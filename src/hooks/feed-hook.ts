import { workspaceLayout } from '../shared/layout.ts';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFeedEvent, isFeedInput } from '../feed/feed.ts';
import { captureCommentary } from '../feed/commentary.ts';

try {
  let input = '';
  let bytes = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16 * 1024 * 1024)
      throw Object.assign(new Error(), { code: 'HOOK_PAYLOAD_TOO_LARGE' });
  }
  const payload = JSON.parse(input);
  // Transcript-derived commentary is read with the provider's own format.
  const codex = process.env.KNOWNEX_PROVIDER !== 'claude';
  const user = payload?.hook_event_name === 'UserPromptSubmit';
  if (!user && payload?.hook_event_name !== 'Stop')
    throw Object.assign(new Error(), { code: 'INVALID_HOOK_PAYLOAD' });
  const text = user ? payload.prompt : payload.last_assistant_message;
  if (typeof text !== 'string')
    throw Object.assign(new Error(), {
      code: user ? 'MISSING_PROMPT' : 'MISSING_ASSISTANT_MESSAGE',
    });
  const directory = workspaceLayout(
    resolve(
      process.env.KNOWNEX_WORKSPACE ??
        fileURLToPath(new URL('../..', import.meta.url)),
    ),
  ).feed;
  const event = {
    type: user ? 'user_message' : 'assistant_final',
    sessionId: payload.session_id,
    turnId: payload.turn_id,
    text,
    hook: payload.hook_event_name,
    ...(process.env.KNOWNEX_PROVIDER === 'claude' ||
    process.env.KNOWNEX_PROVIDER === 'codex'
      ? { provider: process.env.KNOWNEX_PROVIDER }
      : {}),
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
        codex
          ? process.env.KNOWNEX_PROVIDER === 'codex'
            ? 'codex'
            : undefined
          : 'claude',
      );
  const result = await appendFeedEvent(directory, event);
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
