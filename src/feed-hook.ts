import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFeedEvent, isFeedInput } from './feed.ts';
import { captureCommentary } from './commentary.ts';

try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16 * 1024 * 1024)
      throw Object.assign(new Error(), { code: 'HOOK_PAYLOAD_TOO_LARGE' });
  }
  const payload = JSON.parse(input);
  const user = payload?.hook_event_name === 'UserPromptSubmit';
  if (!user && payload?.hook_event_name !== 'Stop')
    throw Object.assign(new Error(), { code: 'INVALID_HOOK_PAYLOAD' });
  const text = user ? payload.prompt : payload.last_assistant_message;
  if (typeof text !== 'string')
    throw Object.assign(new Error(), {
      code: user ? 'MISSING_PROMPT' : 'MISSING_ASSISTANT_MESSAGE',
    });
  const directory = resolve(
    process.env.KNOWNEX_WORKSPACE ??
      fileURLToPath(new URL('..', import.meta.url)),
    '.knownex/feed',
  );
  const event = {
    type: user ? 'user_message' : 'assistant_final',
    sessionId: payload.session_id,
    turnId: payload.turn_id,
    text,
    hook: payload.hook_event_name,
  } as const;
  if (!isFeedInput(event))
    throw Object.assign(new Error(), { code: 'INVALID_HOOK_PAYLOAD' });
  const commentary = user
    ? undefined
    : await captureCommentary(
        directory,
        payload.transcript_path,
        payload.session_id,
        payload.turn_id,
        process.env.KNOWNEX_PROJECT_FEED === '1',
      );
  const result = await appendFeedEvent(
    directory,
    event,
    process.env.KNOWNEX_PROJECT_FEED === '1',
  );
  process.stdout.write(
    JSON.stringify({
      status: 'ok',
      ...result,
      ...commentary,
      contentHash: createHash('sha256').update(text).digest('hex'),
      contentBytes: Buffer.byteLength(text),
    }) + '\n',
  );
} catch (error) {
  const value = (error as NodeJS.ErrnoException).code;
  const code =
    typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
      ? value
      : 'FEED_CAPTURE_FAILED';
  process.stderr.write(JSON.stringify({ status: 'error', code }) + '\n');
  process.exitCode = 1;
}
