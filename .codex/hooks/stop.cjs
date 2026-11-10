const { appendFileSync, existsSync, mkdirSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { isAbsolute, join, resolve } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const runtime = resolve(__dirname, '../..');
const root = process.env.KNOWNEX_WORKSPACE
  ? resolve(process.env.KNOWNEX_WORKSPACE)
  : runtime;
const entry = existsSync(join(runtime, 'dist/index.js'))
  ? join(runtime, 'dist/index.js')
  : join(runtime, 'src/index.ts');
const logFolder = join(root, '.codex/hooks');
const safeCode = (value) =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : 'CAPTURE_FAILED';

function runSync(source, destination, timeout) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(
      process.execPath,
      [entry, 'sync', '--source', source, '--destination', destination],
      {
        cwd: root,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout,
        killSignal: 'SIGKILL',
      },
    );
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(0, 4096);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(0, 4096);
    });
    child.on('error', (error) =>
      reject(Object.assign(new Error(), { code: safeCode(error.code) })),
    );
    child.on('close', (status, signal) => {
      if (signal)
        return reject(Object.assign(new Error(), { code: 'CAPTURE_TIMEOUT' }));
      try {
        if (status !== 0) {
          const result = JSON.parse(stderr);
          return reject(
            Object.assign(new Error(), { code: safeCode(result.code) }),
          );
        }
        const result = JSON.parse(stdout);
        if (
          result.status !== 'ok' ||
          !Number.isSafeInteger(result.appended) ||
          result.appended < 0 ||
          !Number.isSafeInteger(result.recoveredBytes) ||
          result.recoveredBytes < 0
        )
          throw new Error();
        resolveResult(result);
      } catch {
        reject(Object.assign(new Error(), { code: 'CLI_PROTOCOL_ERROR' }));
      }
    });
  });
}

(async () => {
  let event, result, failure;
  try {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 16 * 1024 * 1024)
        throw Object.assign(new Error(), { code: 'HOOK_PAYLOAD_TOO_LARGE' });
    }
    let payload;
    try {
      payload = JSON.parse(input);
    } catch {
      throw Object.assign(new Error(), { code: 'INVALID_HOOK_PAYLOAD' });
    }
    if (
      !['Stop', 'SessionEnd'].includes(payload?.hook_event_name) ||
      typeof payload.session_id !== 'string' ||
      payload.session_id.length === 0 ||
      payload.session_id.length > 256 ||
      typeof payload.transcript_path !== 'string' ||
      !isAbsolute(payload.transcript_path)
    ) {
      throw Object.assign(new Error(), { code: 'INVALID_HOOK_PAYLOAD' });
    }
    event = payload;
    if (
      existsSync(join(root, '.knownex/feed')) &&
      existsSync(join(root, '.knownex/internal/feed'))
    )
      throw Object.assign(new Error(), { code: 'WORKSPACE_LAYOUT_AMBIGUOUS' });
    const folder = join(
      root,
      existsSync(join(root, '.knownex/internal/feed'))
        ? '.knownex/internal/captures'
        : '.knownex/captures',
    );
    mkdirSync(folder, { recursive: true });
    const name =
      createHash('sha256').update(event.session_id).digest('hex') + '.jsonl';
    const destination = join(folder, name);
    // SessionEnd is synchronous and capped at 3 seconds by Codex.
    const deadline =
      performance.now() +
      (event.hook_event_name === 'SessionEnd' ? 2000 : 7500);
    while (true) {
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0)
        throw Object.assign(new Error(), { code: 'CAPTURE_TIMEOUT' });
      try {
        result = await runSync(event.transcript_path, destination, remaining);
        break;
      } catch (error) {
        if (error.code !== 'DESTINATION_BUSY') throw error;
        await delay(Math.min(100, remaining));
      }
    }
  } catch (error) {
    failure = safeCode(error.code);
  }
  try {
    appendFileSync(
      join(logFolder, 'events.jsonl'),
      JSON.stringify({
        session_id: event?.session_id ?? null,
        transcript_path: event?.transcript_path ?? null,
        event: event?.hook_event_name ?? null,
        timestamp: new Date().toISOString(),
        status: failure ? 'error' : 'captured',
        ...(failure
          ? { code: failure }
          : {
              appended: result.appended,
              recoveredBytes: result.recoveredBytes,
            }),
      }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    failure = failure || 'LOG_WRITE_FAILED';
  }
  process.stdout.write(
    JSON.stringify(
      failure
        ? {
            systemMessage: `KnowNex: acquisizione non riuscita (${failure}).`,
            continue: true,
          }
        : {},
    ) + '\n',
  );
})().catch(() => {
  // Last-resort response contains no exception, path, or conversation content.
  process.stdout.write(
    '{"systemMessage":"KnowNex: acquisizione non riuscita (CAPTURE_FAILED).","continue":true}\n',
  );
});
