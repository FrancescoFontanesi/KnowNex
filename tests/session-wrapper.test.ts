import assert from 'node:assert/strict';
import {
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';

async function fixture(t: TestContext, script: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'knownex-session-')),
  );
  t.after(async () => {
    assert.equal(dirname(root), await realpath(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, '.codex/hooks'), { recursive: true });
  await mkdir(join(root, 'dist'));
  const wrapper = join(root, '.codex/hooks/session.cjs');
  await copyFile(
    process.env.KNOWNEX_SESSION_WRAPPER ?? resolve('.codex/hooks/session.cjs'),
    wrapper,
  );
  await writeFile(join(root, 'dist/session-hook.js'), script);
  return { root, wrapper };
}
const payload = (state: string) =>
  Buffer.from(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: state,
      },
    }) + '\n',
  );
function run(wrapper: string, source = 'startup', prefix: string[] = []) {
  return spawnSync(process.execPath, [...prefix, wrapper], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
}

test('SessionStart wrapper preserves exact UTF-8 bytes across 64 KiB and multi-megabyte payloads without an output cap', async (t) => {
  for (const size of [65535, 65536, 65537, 2 * 1024 * 1024])
    await t.test(String(size), async (t) => {
      const sample = 'caffè Ελληνικά 日本語 🧠 e\u0301\n';
      const state = sample + 'x'.repeat(size - Buffer.byteLength(sample));
      const expected = payload(state);
      const f = await fixture(
        t,
        `const fs=require('node:fs');const b=fs.readFileSync(${JSON.stringify('payload.bin')});const i=b.indexOf(Buffer.from('🧠'))+1;process.stdout.write(b.subarray(0,i));setTimeout(()=>{process.stdout.write(b.subarray(i,i+1));setTimeout(()=>process.stdout.write(b.subarray(i+1)),10)},10);`,
      );
      await writeFile(join(f.root, 'payload.bin'), expected);
      // Child inherits cwd in the real hook; keep the fixture equally local.
      for (const source of ['startup', 'compact']) {
        const result = spawnSync(process.execPath, [f.wrapper], {
          cwd: f.root,
          input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
          timeout: 15000,
          maxBuffer: 16 * 1024 * 1024,
          windowsHide: true,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr.toString());
        assert.deepEqual(result.stdout, expected);
        assert.deepEqual(
          Buffer.from(
            JSON.parse(result.stdout.toString('utf8')).hookSpecificOutput
              .additionalContext,
          ),
          Buffer.from(state),
        );
      }
    });
});

test('SessionStart wrapper withholds failed, incomplete and invalid output and reports timeout without publishing a prefix', async (t) => {
  const cases = [
    {
      name: 'nonzero after complete payload',
      script: `process.stdout.write(${JSON.stringify(payload('SHOULD_NOT_ESCAPE').toString())});process.exitCode=9`,
      code: 'SESSION_PROCESS_ERROR',
    },
    {
      name: 'partial output then error',
      script: `process.stdout.write('SHOULD_NOT_ESCAPE');process.exitCode=9`,
      code: 'SESSION_PROCESS_ERROR',
    },
    {
      name: 'child terminated by signal',
      script: "process.kill(process.pid,'SIGTERM');",
      code: 'SESSION_PROCESS_ERROR',
    },
    {
      name: 'empty successful exit',
      script: '',
      code: 'SESSION_OUTPUT_INVALID',
    },
    {
      name: 'stdout closed prematurely',
      script: `process.stdout.end('{"hookSpecificOutput":');`,
      code: 'SESSION_OUTPUT_INVALID',
    },
    {
      name: 'invalid UTF-8',
      script: `process.stdout.write(Buffer.from([0xff,0xfe]));`,
      code: 'SESSION_OUTPUT_INVALID',
    },
    {
      name: 'wrong payload shape',
      script: `process.stdout.write('{"state":"SHOULD_NOT_ESCAPE"}');`,
      code: 'SESSION_OUTPUT_INVALID',
    },
    {
      name: 'partial output then timeout',
      script: `process.stdout.write('SHOULD_NOT_ESCAPE');setInterval(()=>{},1000);`,
      code: 'SESSION_TIMEOUT',
    },
  ];
  for (const c of cases)
    await t.test(c.name, async (t) => {
      const f = await fixture(t, c.script),
        r = run(f.wrapper);
      assert.ifError(r.error);
      assert.equal(r.status, 0, r.stderr.toString());
      const text = r.stdout.toString('utf8');
      assert.ok(!text.includes('SHOULD_NOT_ESCAPE'));
      assert.ok(
        JSON.parse(text).hookSpecificOutput.additionalContext.includes(c.code),
      );
    });
  await t.test('spawn failure', async (t) => {
    const f = await fixture(t, '');
    const preload = join(f.root, 'fail.cjs');
    await writeFile(
      preload,
      `require('node:child_process').spawn=()=>{throw new Error('private detail')}`,
    );
    const r = run(f.wrapper, 'startup', ['--require', preload]);
    assert.equal(r.status, 0);
    assert.match(r.stdout.toString(), /SESSION_OUTPUT_ERROR/);
    assert.ok(!r.stdout.toString().includes('private detail'));
  });
});

test('SessionStart wrapper discards stderr and fails explicitly when its downstream output channel closes', async (t) => {
  const expected = payload('x'.repeat(2 * 1024 * 1024));
  const f = await fixture(
    t,
    `process.stderr.write('private detail'.repeat(200000));process.stdout.write(${JSON.stringify(payload('valid').toString())});`,
  );
  const success = run(f.wrapper);
  assert.equal(success.status, 0);
  assert.deepEqual(success.stdout, payload('valid'));
  assert.equal(success.stderr.length, 0);
  // Use a valid large payload so the failure occurs while delivering, not validating.
  await writeFile(join(f.root, 'payload.bin'), expected);
  await writeFile(
    join(f.root, 'dist/session-hook.js'),
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(join(f.root, 'payload.bin'))}));`,
  );
  const child = spawn(process.execPath, [f.wrapper], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart' }));
  child.stdout.once('data', () => child.stdout.destroy());
  let stderr = '';
  child.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  const result = await new Promise<{
    code: number | null;
    signal: string | null;
  }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  assert.ok(result.code !== 0 || result.signal !== null);
  assert.ok(!stderr.includes('private detail'));
});
