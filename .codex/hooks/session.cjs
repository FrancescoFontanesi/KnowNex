const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');
const runtime = resolve(__dirname, '../..');
const entry = existsSync(join(runtime, 'dist/session-hook.js'))
  ? join(runtime, 'dist/session-hook.js')
  : join(runtime, 'src/session-hook.ts');
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
  const child = spawn(process.execPath, [entry], {
    stdio: ['inherit', 'pipe', 'ignore'],
    windowsHide: true,
  });
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
  (output) => process.stdout.write(output),
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
