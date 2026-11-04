const { appendFileSync, existsSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { join, resolve } = require('node:path');
const runtime = resolve(__dirname, '../..');
const root = process.env.KNOWNEX_WORKSPACE
  ? resolve(process.env.KNOWNEX_WORKSPACE)
  : runtime;
const entry = existsSync(join(runtime, 'dist/feed-hook.js'))
  ? join(runtime, 'dist/feed-hook.js')
  : join(runtime, 'src/feed-hook.ts');
const safeCode = (value) =>
  typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
    ? value
    : 'FEED_CAPTURE_FAILED';

function capture(input) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 7500,
      killSignal: 'SIGKILL',
    });
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
    child.on('error', reject);
    child.stdin.on('error', (error) =>
      reject(Object.assign(new Error(), { code: safeCode(error.code) })),
    );
    child.on('close', (status, signal) => {
      if (signal)
        return reject(Object.assign(new Error(), { code: 'FEED_TIMEOUT' }));
      try {
        const result = JSON.parse(status === 0 ? stdout : stderr);
        if (status !== 0)
          return reject(
            Object.assign(new Error(), { code: safeCode(result.code) }),
          );
        if (
          result.status !== 'ok' ||
          ![0, 1].includes(result.appended) ||
          !Number.isSafeInteger(result.sequence) ||
          result.sequence < 1 ||
          !Number.isSafeInteger(result.recoveredBytes) ||
          result.recoveredBytes < 0 ||
          !/^[a-f0-9]{64}$/.test(result.contentHash) ||
          !Number.isSafeInteger(result.contentBytes) ||
          result.contentBytes < 0 ||
          (result.commentaryAppended !== undefined &&
            (!Number.isSafeInteger(result.commentaryAppended) ||
              result.commentaryAppended < 0 ||
              !Number.isSafeInteger(result.commentaryMatched) ||
              result.commentaryMatched < result.commentaryAppended ||
              !Array.isArray(result.commentaryIssues) ||
              result.commentaryIssues.some((c) => safeCode(c) !== c)))
        )
          throw new Error();
        resolveResult(result);
      } catch {
        reject(Object.assign(new Error(), { code: 'FEED_PROTOCOL_ERROR' }));
      }
    });
    child.stdin.end(input);
  });
}

(async () => {
  let payload, result, failure;
  try {
    let input = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 16 * 1024 * 1024)
        throw Object.assign(new Error(), { code: 'HOOK_PAYLOAD_TOO_LARGE' });
    }
    const value = JSON.parse(input);
    if (
      !['UserPromptSubmit', 'Stop'].includes(value?.hook_event_name) ||
      typeof value.session_id !== 'string' ||
      !value.session_id.trim() ||
      value.session_id.length > 256 ||
      typeof value.turn_id !== 'string' ||
      !value.turn_id.trim() ||
      value.turn_id.length > 256
    ) {
      throw Object.assign(new Error(), { code: 'INVALID_HOOK_PAYLOAD' });
    }
    payload = value;
    result = await capture(input);
  } catch (error) {
    failure = safeCode(error.code);
  }
  try {
    appendFileSync(
      join(root, '.codex/hooks/feed-events.jsonl'),
      JSON.stringify({
        session_id: payload?.session_id ?? null,
        turn_id: payload?.turn_id ?? null,
        event: payload?.hook_event_name ?? null,
        timestamp: new Date().toISOString(),
        status: failure ? 'error' : 'captured',
        ...(failure
          ? { code: failure }
          : {
              appended: result.appended,
              sequence: result.sequence,
              recoveredBytes: result.recoveredBytes,
              contentHash: result.contentHash,
              contentBytes: result.contentBytes,
              ...(result.commentaryAppended !== undefined
                ? {
                    commentaryAppended: result.commentaryAppended,
                    commentaryMatched: result.commentaryMatched,
                    commentaryIssues: result.commentaryIssues,
                  }
                : {}),
            }),
      }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    failure ||= 'FEED_LOG_WRITE_FAILED';
  }
  process.stdout.write(
    JSON.stringify(
      failure
        ? {
            systemMessage: `KnowNex: feed non acquisito (${failure}).`,
            continue: true,
          }
        : {},
    ) + '\n',
  );
})().catch(() => {
  process.stdout.write(
    '{"systemMessage":"KnowNex: feed non acquisito (FEED_CAPTURE_FAILED).","continue":true}\n',
  );
});
