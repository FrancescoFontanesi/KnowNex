// Ephemeral curator session: no capture and no context.
if (process.env.KNOWNEX_CAPTURE === '0') process.exit(0);
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');
const runtime = resolve(__dirname, '../..');
const entry = existsSync(join(runtime, 'dist/hooks/session-hook.js'))
  ? join(runtime, 'dist/hooks/session-hook.js')
  : join(runtime, 'src/hooks/session-hook.ts');
// A broken harness output channel cannot receive a second diagnostic payload.
process.stdout.on('error', () => {
  process.exitCode = 1;
});
const diagnostic = (code) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: `KnowNex: avvio contesto non riuscito (${code}); memoria e pending non verificati. Non assumere conferme.`,
    },
  }) + '\n';

async function context() {
  const chunks = [];
  let failure;
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  // After a compact the conversation summary already holds the context: stay silent.
  try {
    if (JSON.parse(input)?.source === 'compact') return null;
  } catch {}
  const child = spawn(process.execPath, [entry], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input);
  const timer = setTimeout(() => {
    failure = 'SESSION_TIMEOUT';
    child.kill('SIGKILL');
  }, 7500);
  try {
    const closed = new Promise((resolve) => {
      child.on('error', () => {
        failure ??= 'SESSION_PROCESS_ERROR';
      });
      child.on('close', (code, signal) => resolve({ code, signal }));
    });
    child.stdout.on('data', (chunk) => {
      // Keep raw UTF-8 bytes until success: never publish a failed child's prefix.
      try {
        chunks.push(chunk);
      } catch {
        failure = 'SESSION_OUTPUT_ERROR';
        child.kill('SIGKILL');
      }
    });
    child.stdout.on('error', () => {
      failure = 'SESSION_OUTPUT_ERROR';
      child.kill('SIGKILL');
    });
    const result = await closed;
    if (failure) throw new Error(failure);
    if (result.code !== 0 || result.signal)
      throw new Error('SESSION_PROCESS_ERROR');
    const output = Buffer.concat(chunks);
    let payload;
    try {
      payload = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(output),
      );
    } catch {
      throw new Error('SESSION_OUTPUT_INVALID');
    }
    if (
      payload?.hookSpecificOutput?.hookEventName !== 'SessionStart' ||
      typeof payload.hookSpecificOutput.additionalContext !== 'string'
    )
      throw new Error('SESSION_OUTPUT_INVALID');
    return output;
  } finally {
    clearTimeout(timer);
  }
}

context().then(
  (output) => output && process.stdout.write(output),
  (error) =>
    process.stdout.write(
      diagnostic(
        [
          'SESSION_TIMEOUT',
          'SESSION_PROCESS_ERROR',
          'SESSION_OUTPUT_ERROR',
          'SESSION_OUTPUT_INVALID',
        ].includes(error.message)
          ? error.message
          : 'SESSION_OUTPUT_ERROR',
      ),
    ),
);
