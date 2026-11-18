import { sessionContext, workspaceDirectory } from '../memory/runtime.ts';

try {
  let input = '';
  let bytes = 0;
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    bytes += Buffer.byteLength(chunk);
    if (bytes > 1024 * 1024) throw new Error();
  }
  const payload = JSON.parse(input);
  if (payload?.hook_event_name !== 'SessionStart') throw new Error();
  // After a compact the conversation summary already holds the context.
  if (payload.source === 'compact') process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: await sessionContext(workspaceDirectory()),
      },
    }) + '\n',
  );
} catch {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext:
          'KnowNex: memory/pending not verified. Do not assume a confirmed state; no automatic repair. Run knownex runtime to diagnose.',
      },
    }) + '\n',
  );
}
