// Transcript capture was removed. Wrappers installed by earlier releases
// (.codex|.claude/hooks/knownex-stop.cjs) still require this file: it drains the
// payload and answers with no effect until `knownex init` retires them.
// Remove it in the release after the one that retires those wrappers.
process.stdin.on('error', () => {});
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('{}\n'));
