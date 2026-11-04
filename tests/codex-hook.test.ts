import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  cp,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
  appendFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { acquireJournalLock } from '../src/journal-lock.ts';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'knownex hook regression '));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const folder = join(root, '.codex/hooks');
  await mkdir(folder, { recursive: true });
  const script = join(folder, 'stop.cjs');
  await copyFile('.codex/hooks/stop.cjs', script);
  await cp('src', join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const source = join(root, 'synthetic session.jsonl');
  await writeFile(source, '{"private":"PRIVATE_SYNTHETIC_CONTENT"}\n');
  return { root, folder, script, source };
}

function payload(
  source: string,
  session = 'synthetic-regression',
  event: 'Stop' | 'SessionEnd' = 'Stop',
) {
  return {
    session_id: session,
    transcript_path: source,
    hook_event_name: event,
    last_assistant_message: 'PRIVATE_SYNTHETIC_CONTENT',
  };
}

function invoke(
  script: string,
  input: unknown,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script], {
      windowsHide: true,
      timeout: 12000,
      killSignal: 'SIGKILL',
    });
    let stdout = '',
      stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => {
      stdout += value;
    });
    child.stderr.on('data', (value) => {
      stderr += value;
    });
    child.on('error', reject);
    child.on('close', (status) => resolveResult({ status, stdout, stderr }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
}

const capturePath = (root: string, id = 'synthetic-regression') =>
  join(
    root,
    '.knownex/captures',
    createHash('sha256').update(id).digest('hex') + '.jsonl',
  );

async function restored(file: string) {
  const frames = (await readFile(file, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  return Buffer.from(
    frames
      .flatMap((frame) => frame.block.records)
      .map((line: string) => line + '\n')
      .join(''),
  );
}

function successful(result: Awaited<ReturnType<typeof invoke>>) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), {});
}

test(
  'il comando Stop configurato funziona sia in PowerShell sia in cmd.exe',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const config = JSON.parse(await readFile('.codex/hooks.json', 'utf8'));
    const declared: string = config.hooks.Stop[0].hooks[0].command;
    const scriptArgument = declared.match(/"[^"\r\n]+\.cjs"$/)?.[0];
    assert.ok(
      scriptArgument,
      'hook command must end with a quoted script path',
    );
    for (const shell of ['powershell', 'cmd']) {
      await t.test(shell, async (subtest) => {
        const { root, folder, script, source } = await fixture(subtest);
        const command =
          declared.slice(0, -scriptArgument.length) + '"' + script + '"';
        const input = JSON.stringify(payload(source));
        const result =
          shell === 'powershell'
            ? spawnSync(
                'powershell.exe',
                ['-NoProfile', '-NonInteractive', '-Command', command],
                { input, encoding: 'utf8', windowsHide: true },
              )
            : spawnSync(
                process.env.ComSpec || 'cmd.exe',
                ['/C', '"' + command + '"'],
                {
                  input,
                  encoding: 'utf8',
                  windowsHide: true,
                  windowsVerbatimArguments: true,
                },
              );
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, '');
        assert.deepEqual(JSON.parse(result.stdout), {});
        const metadata = JSON.parse(
          await readFile(join(folder, 'events.jsonl'), 'utf8'),
        );
        assert.deepEqual(Object.keys(metadata), [
          'session_id',
          'transcript_path',
          'event',
          'timestamp',
          'status',
          'appended',
          'recoveredBytes',
        ]);
        assert.equal(metadata.session_id, 'synthetic-regression');
        assert.equal(metadata.event, 'Stop');
        assert.equal(metadata.transcript_path, source);
        assert.equal(metadata.status, 'captured');
        assert.equal(metadata.appended, 1);
        assert.ok(Number.isFinite(Date.parse(metadata.timestamp)));
        assert.ok(
          !JSON.stringify(metadata).includes('PRIVATE_SYNTHETIC_CONTENT'),
        );
        assert.deepEqual(
          await restored(capturePath(root)),
          await readFile(source),
        );
      });
    }
  },
);

test('hook riparte in processi nuovi, acquisisce solo record completi e separa le sessioni', async (t) => {
  const { root, folder, script, source } = await fixture(t);
  successful(await invoke(script, payload(source)));
  const first = await readFile(capturePath(root));
  await appendFile(source, '{"id":2');
  successful(await invoke(script, payload(source)));
  assert.deepEqual(await readFile(capturePath(root)), first);
  await appendFile(source, '}\n');
  successful(await invoke(script, payload(source)));
  const next = await readFile(capturePath(root));
  assert.deepEqual(next.subarray(0, first.length), first);
  assert.deepEqual(await restored(capturePath(root)), await readFile(source));
  successful(await invoke(script, payload(source)));
  assert.deepEqual(await readFile(capturePath(root)), next);
  const other = join(root, 'other.jsonl');
  await writeFile(other, 'true\n');
  successful(await invoke(script, payload(other, '../../different-session')));
  assert.deepEqual(
    await restored(capturePath(root, '../../different-session')),
    Buffer.from('true\n'),
  );
  assert.equal(
    (await readdir(join(root, '.knownex/captures'))).filter((n) =>
      n.endsWith('.jsonl'),
    ).length,
    2,
  );
  assert.ok(
    !(await readFile(join(folder, 'events.jsonl'), 'utf8')).includes(
      'PRIVATE_SYNTHETIC_CONTENT',
    ),
  );
});

test(
  'hook concorrenti sullo stesso registro attendono e non duplicano i record',
  { timeout: 15000 },
  async (t) => {
    const { root, script, source, folder } = await fixture(t);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => invoke(script, payload(source))),
    );
    results.forEach(successful);
    assert.deepEqual(await restored(capturePath(root)), await readFile(source));
    const logs = (await readFile(join(folder, 'events.jsonl'), 'utf8'))
      .trimEnd()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(
      logs.reduce((n, l) => n + l.appended, 0),
      1,
    );
    assert.ok(logs.every((l) => l.status === 'captured'));
    assert.deepEqual(await readdir(join(root, '.knownex/captures')), [
      createHash('sha256').update('synthetic-regression').digest('hex') +
        '.jsonl',
    ]);
  },
);

test('SessionEnd acquisisce la coda dopo Stop e le ripetizioni non duplicano record', async (t) => {
  const { root, folder, script, source } = await fixture(t);
  const config = JSON.parse(await readFile('.codex/hooks.json', 'utf8'));
  assert.equal(
    config.hooks.SessionEnd[0].hooks[0].command,
    config.hooks.Stop[0].hooks[0].command,
  );
  assert.equal(config.hooks.SessionEnd[0].hooks[0].timeout, 3);
  successful(await invoke(script, payload(source)));
  const before = await readFile(capturePath(root));
  await appendFile(
    source,
    '{"type":"event_msg","payload":{"type":"task_complete"}}\n',
  );
  successful(await invoke(script, payload(source, undefined, 'SessionEnd')));
  const after = await readFile(capturePath(root));
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.deepEqual(await restored(capturePath(root)), await readFile(source));
  successful(await invoke(script, payload(source, undefined, 'SessionEnd')));
  assert.deepEqual(await readFile(capturePath(root)), after);
  const logs = (await readFile(join(folder, 'events.jsonl'), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    logs.map((l) => [l.event, l.appended]),
    [
      ['Stop', 1],
      ['SessionEnd', 1],
      ['SessionEnd', 0],
    ],
  );
});

test('Stop e SessionEnd sovrapposti usano un solo registro senza duplicazioni', async (t) => {
  const { root, script, source, folder } = await fixture(t);
  const results = await Promise.all([
    invoke(script, payload(source)),
    invoke(script, payload(source, undefined, 'SessionEnd')),
  ]);
  results.forEach(successful);
  assert.deepEqual(await restored(capturePath(root)), await readFile(source));
  const logs = (await readFile(join(folder, 'events.jsonl'), 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(
    logs.reduce((n, l) => n + l.appended, 0),
    1,
  );
  assert.deepEqual(
    new Set(logs.map((l) => l.event)),
    new Set(['Stop', 'SessionEnd']),
  );
});

test(
  'SessionEnd con lock occupato termina entro il limite e registra solo il codice errore',
  { timeout: 7000 },
  async (t) => {
    const { root, folder, script, source } = await fixture(t);
    successful(await invoke(script, payload(source)));
    const before = await readFile(capturePath(root));
    const release = await acquireJournalLock(capturePath(root) + '.lock');
    try {
      const start = performance.now();
      const result = await invoke(
        script,
        payload(source, undefined, 'SessionEnd'),
      );
      const elapsed = performance.now() - start;
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.match(JSON.parse(result.stdout).systemMessage, /CAPTURE_TIMEOUT/);
      assert.ok(
        elapsed < 3000,
        `SessionEnd exceeded runtime limit: ${elapsed} ms`,
      );
      assert.deepEqual(await readFile(capturePath(root)), before);
      const logs = (await readFile(join(folder, 'events.jsonl'), 'utf8'))
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(logs.at(-1).event, 'SessionEnd');
      assert.equal(logs.at(-1).code, 'CAPTURE_TIMEOUT');
      assert.ok(!JSON.stringify(logs).includes('PRIVATE_SYNTHETIC_CONTENT'));
    } finally {
      await release();
    }
  },
);

test('errori di sorgente e payload non interrompono Codex né divulgano contenuti', async (t) => {
  const { root, folder, script, source } = await fixture(t);
  successful(await invoke(script, payload(source)));
  const before = await readFile(capturePath(root));
  await appendFile(source, 'PRIVATE_SYNTHETIC_CONTENT\n');
  const result = await invoke(script, payload(source));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  const response = JSON.parse(result.stdout);
  assert.equal(response.continue, true);
  assert.match(response.systemMessage, /JSONL_MALFORMED/);
  assert.ok(!result.stdout.includes('PRIVATE_SYNTHETIC_CONTENT'));
  assert.deepEqual(await readFile(capturePath(root)), before);
  const invalid = await invoke(script, '{PRIVATE_SYNTHETIC_CONTENT');
  assert.equal(invalid.status, 0);
  assert.match(
    JSON.parse(invalid.stdout).systemMessage,
    /INVALID_HOOK_PAYLOAD/,
  );
  assert.ok(
    !(await readFile(join(folder, 'events.jsonl'), 'utf8')).includes(
      'PRIVATE_SYNTHETIC_CONTENT',
    ),
  );
});

test(
  'un registro occupato non blocca Codex oltre il budget dell’hook',
  { timeout: 15000 },
  async (t) => {
    const { root, script, source } = await fixture(t);
    successful(await invoke(script, payload(source)));
    const before = await readFile(capturePath(root));
    const release = await acquireJournalLock(capturePath(root) + '.lock');
    try {
      const result = await invoke(script, payload(source));
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      const output = JSON.parse(result.stdout);
      assert.equal(output.continue, true);
      assert.match(output.systemMessage, /CAPTURE_TIMEOUT/);
      assert.deepEqual(await readFile(capturePath(root)), before);
    } finally {
      await release();
    }
    successful(await invoke(script, payload(source)));
    assert.deepEqual(await readFile(capturePath(root)), before);
  },
);
