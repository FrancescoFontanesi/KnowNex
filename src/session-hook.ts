import { sessionContext, workspaceDirectory } from './runtime.ts';

try {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 1024 * 1024) throw new Error();
  }
  const payload = JSON.parse(input);
  if (payload?.hook_event_name !== 'SessionStart') throw new Error();
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
          'KnowNex: memoria/pending non verificati. Non assumere uno stato confermato; nessuna riparazione automatica. Esegui knownex runtime per diagnosticare.',
      },
    }) + '\n',
  );
}
