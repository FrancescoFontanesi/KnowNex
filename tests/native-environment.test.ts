import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nativePreflight } from '../src/native-preflight.ts';
import { withNativeRpc } from '../src/native-rpc.ts';
import { emptyMemory } from '../src/curator.ts';

// Exercise the shared RPC transport diagnostics, not a checkpoint dependency.
const probeRpc = (ids: string[], cwd: string) =>
  withNativeRpc(cwd, 'CURATOR_NATIVE_HISTORY_UNAVAILABLE', async (call) => {
    const result = new Map<string, { turns: Set<string> }>();
    for (const threadId of ids) {
      await call('thread/read', { threadId, includeTurns: false });
      const page = await call('thread/turns/list', { threadId });
      result.set(threadId, {
        turns: new Set((page.data as { id: string }[]).map((t) => t.id)),
      });
    }
    return result;
  });
import { preparedCheckpoint } from '../src/native-checkpoint.ts';
import { appendFeedEvent } from '../src/feed.ts';

async function fixture(t: TestContext) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'knownex-environment-')),
  );
  const cwd = join(root, '.knownex/internal/feed');
  await mkdir(cwd, { recursive: true });
  await mkdir(join(root, '.codex/hooks'), { recursive: true });
  await writeFile(join(root, '.codex/hooks/knownex-feed.cjs'), '// fixture');
  const previous = process.env.KNOWNEX_CODEX_BIN;
  process.env.KNOWNEX_CODEX_BIN = process.execPath;
  t.after(async () => {
    if (previous === undefined) delete process.env.KNOWNEX_CODEX_BIN;
    else process.env.KNOWNEX_CODEX_BIN = previous;
    await rm(root, { recursive: true, force: true });
  });
  const config = {
    mode: 'ok',
    expectedCwd: '',
    hooksEnabled: true,
    hooks: [
      {
        eventName: 'userPromptSubmit',
        command: 'node ".codex/hooks/knownex-feed.cjs"',
        enabled: true,
        trustStatus: 'trusted',
        source: 'project',
        sourcePath: join(root, '.codex/hooks.json'),
      },
      {
        eventName: 'stop',
        command: 'node ".codex/hooks/knownex-feed.cjs"',
        enabled: true,
        trustStatus: 'trusted',
        source: 'project',
        sourcePath: join(root, '.codex/hooks.json'),
      },
    ],
  };
  const configPath = join(root, 'peer.json');
  const peer = `
const fs = require('node:fs');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const r=JSON.parse(line); if(!('id' in r))return;
 const c=JSON.parse(fs.readFileSync(${JSON.stringify(configPath)},'utf8'));
 fs.appendFileSync(${JSON.stringify(join(root, 'calls.jsonl'))},JSON.stringify({method:r.method,cwd:process.cwd(),params:r.params})+'\\n');
 let result={},error;
 if(c.mode==='exit')return process.exit(9);
 if(c.mode==='home-required'&&!process.env.CODEX_HOME){process.stderr.write('Error: Could not find home directory\\n');return process.exit(1);}
 if(c.mode==='home-error'){process.stderr.write('WARNING: proceeding, even though we could not create PATH aliases: Could not find home directory\\nError: Could not find home directory\\n');return process.exit(1);}
 if(c.mode==='permission-error'){process.stderr.write('Error: Access is denied. (os error 5)\\nAuthorization: Bearer secret-value\\n');return process.exit(1);}
 if(c.mode==='malformed')return process.stdout.write('not JSON\\n');
 if(c.mode==='timeout')return;
 if(r.method==='initialize')result={};
 else if(c.mode==='rpc'){process.stderr.write('permission denied\\nAuthorization: Bearer secret-value\\n');error={code:-32001,message:'permission denied',data:{token:'secret-value',conversation:'private text'}};}
 else if(r.method==='config/read')result={config:{features:{hooks:c.hooksEnabled}}};
 else if(r.method==='hooks/list')result=c.mode==='bad-hooks'?{data:42}:{data:[{cwd:r.params.cwds?.[0],hooks:c.hooks.map(h=>({...h,trustStatus:c.expectedCwd&&r.params.cwds?.[0]!==c.expectedCwd?'untrusted':h.trustStatus}))}]};
 else if(r.method==='thread/read') {if(r.params.threadId==='missing')error={code:-32004,message:'thread not found'};else result={thread:{id:r.params.threadId,sessionId:r.params.threadId,historyMode:'paginated'}};}
 else if(r.method==='thread/turns/list')result={data:[{id:'turn'}],nextCursor:null};
 else error={code:-32601,message:'unsupported'};
 process.stdout.write(JSON.stringify({id:r.id,...(error?{error}:{result})})+'\\n');
});`;
  await writeFile(join(root, 'app-server'), peer);
  await writeFile(join(cwd, 'app-server'), peer);
  const save = () => writeFile(configPath, JSON.stringify(config));
  await save();
  return { root, cwd, config, save };
}

test(
  'Windows preflight preserves the caller path spelling used by native hook approval',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const f = await fixture(t);
    const alternate =
      (f.root[0] === f.root[0]!.toUpperCase()
        ? f.root[0]!.toLowerCase()
        : f.root[0]!.toUpperCase()) + f.root.slice(1);
    f.config.expectedCwd = alternate;
    await f.save();
    const result = await nativePreflight(alternate);
    assert.equal(result.status, 'ready');
    assert.equal(result.workspace, alternate);
    const calls = (await readFile(join(f.root, 'calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    for (const call of calls.filter((c) =>
      ['config/read', 'hooks/list'].includes(c.method),
    )) {
      if (call.method === 'hooks/list')
        assert.deepEqual(call.params.cwds, [alternate]);
      else assert.equal(call.params.cwd, alternate);
    }
  },
);

test('preflight distinguishes approval, disabled and missing capture hooks without acquiring authority', async (t) => {
  const f = await fixture(t);
  const sentinel = join(f.cwd, 'project.jsonl');
  await writeFile(sentinel, 'immutable feed');
  const approved = await nativePreflight(f.root);
  assert.equal(approved.status, 'ready');
  assert.equal(approved.executionVerified, false);
  const cli = () =>
    spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('../src/index.ts', import.meta.url)),
        'preflight',
        '--workspace',
        f.root,
      ],
      { cwd: f.root, env: process.env, encoding: 'utf8', timeout: 15000 },
    );
  const cliReady = cli();
  assert.equal(cliReady.status, 0, cliReady.stderr);
  assert.equal(JSON.parse(cliReady.stdout).status, 'ready');
  await rm(join(f.root, '.codex/hooks/knownex-feed.cjs'));
  assert.equal((await nativePreflight(f.root)).hooks[0]!.status, 'unavailable');
  await writeFile(join(f.root, '.codex/hooks/knownex-feed.cjs'), '// fixture');
  f.config.hooksEnabled = false;
  await f.save();
  assert.equal((await nativePreflight(f.root)).hooks[0]!.status, 'disabled');
  f.config.hooksEnabled = true;
  f.config.hooks[0]!.trustStatus = 'untrusted';
  await f.save();
  const untrusted = await nativePreflight(f.root);
  assert.equal(untrusted.status, 'blocked');
  assert.equal(untrusted.hooks[0]!.status, 'unapproved');
  assert.match(untrusted.action!, /hooks/i);
  const cliBlocked = cli();
  assert.equal(cliBlocked.status, 1, cliBlocked.stderr);
  assert.equal(JSON.parse(cliBlocked.stdout).hooks[0].status, 'unapproved');
  f.config.hooks[0]!.enabled = false;
  await f.save();
  assert.equal((await nativePreflight(f.root)).hooks[0]!.status, 'disabled');
  f.config.hooks.shift();
  await f.save();
  assert.equal((await nativePreflight(f.root)).hooks[0]!.status, 'absent');
  assert.equal(await readFile(sentinel, 'utf8'), 'immutable feed');
  assert.deepEqual(await readdir(f.cwd), ['app-server', 'project.jsonl']);
  const calls = (await readFile(join(f.root, 'calls.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).method);
  assert.ok(
    calls.every((m) => ['initialize', 'config/read', 'hooks/list'].includes(m)),
  );
});

test('native child receives the existing Node default home and preserves an explicit CODEX_HOME', async (t) => {
  const f = await fixture(t);
  const prior = process.env.CODEX_HOME;
  t.after(() => {
    if (prior === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prior;
  });
  delete process.env.CODEX_HOME;
  f.config.mode = 'home-required';
  await f.save();
  assert.equal(
    (await probeRpc(['available'], f.cwd)).get('available')!.turns.size,
    1,
  );
  const configured = join(f.root, 'explicit-home');
  process.env.CODEX_HOME = configured;
  f.config.mode = 'permission-error';
  await f.save();
  await assert.rejects(probeRpc(['available'], f.cwd), {
    code: 'CURATOR_NATIVE_HISTORY_UNAVAILABLE',
  });
  const dir = join(f.root, '.knownex/internal/diagnostics');
  const r = JSON.parse(
    await readFile(join(dir, (await readdir(dir))[0]!), 'utf8'),
  );
  assert.equal(r.codexHome, configured);
  assert.equal(r.homeSource, 'explicit');
  assert.equal(r.failureKind, 'initialize-permission-denied');
  assert.equal(r.initialized, false);
  assert.ok(r.stderr.includes('Error: Access is denied. (os error 5)'));
  assert.doesNotMatch(JSON.stringify(r), /secret-value/);
  delete process.env.CODEX_HOME;
  f.config.mode = 'home-error';
  await f.save();
  await assert.rejects(probeRpc(['available'], f.cwd), {
    code: 'CURATOR_NATIVE_HISTORY_UNAVAILABLE',
  });
  const all = await Promise.all(
    (await readdir(dir)).map(async (n) =>
      JSON.parse(await readFile(join(dir, n), 'utf8')),
    ),
  );
  const missing = all.find(
    (x) => x.failureKind === 'initialize-home-unavailable',
  );
  assert.ok(missing);
  assert.equal(missing.codexHome, join(homedir(), '.codex'));
  assert.equal(missing.homeSource, 'node-default');
  assert.ok(missing.stderr.includes('Error: Could not find home directory'));
});

test('preflight rejects malformed provider reports and unavailable RPC without claiming readiness', async (t) => {
  const f = await fixture(t);
  f.config.mode = 'bad-hooks';
  await f.save();
  await assert.rejects(nativePreflight(f.root), {
    code: 'CURATOR_NATIVE_HOOKS_INVALID',
  });
  f.config.mode = 'rpc';
  await f.save();
  await assert.rejects(nativePreflight(f.root), {
    code: 'CURATOR_NATIVE_HOOKS_UNAVAILABLE',
  });
});

test('history diagnostics preserve public errors, identify RPC/thread and redact sensitive payloads', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await probeRpc(['available'], f.cwd)).get('available')!.turns.size,
    1,
  );
  assert.equal(
    (await readdir(join(f.root, '.knownex/internal'))).includes('diagnostics'),
    false,
  );
  f.config.mode = 'rpc';
  await f.save();
  await assert.rejects(probeRpc(['available'], f.cwd), {
    code: 'CURATOR_NATIVE_HISTORY_UNAVAILABLE',
  });
  f.config.mode = 'ok';
  await f.save();
  await assert.rejects(probeRpc(['missing'], f.cwd), {
    code: 'CURATOR_NATIVE_HISTORY_UNAVAILABLE',
  });
  const dir = join(f.root, '.knownex/internal/diagnostics');
  const reports = await Promise.all(
    (await readdir(dir)).map(async (n) =>
      JSON.parse(await readFile(join(dir, n), 'utf8')),
    ),
  );
  assert.equal(reports.length, 2);
  assert.deepEqual(
    reports.map((r) => r.original.code).sort((a, b) => a - b),
    [-32004, -32001],
  );
  for (const r of reports) {
    assert.equal(
      r.failureKind,
      r.original.code === -32004 ? 'history-unavailable' : 'history-rpc-error',
    );
    assert.equal(r.initialized, true);
    assert.equal(r.method, 'thread/read');
    assert.equal(r.cwd, f.cwd);
    assert.equal(r.spawned, true);
    assert.equal(r.executable, process.execPath);
    assert.ok(r.durationMs >= 0);
    assert.ok(r.termination);
    assert.doesNotMatch(JSON.stringify(r), /secret-value|private text/);
  }
  assert.ok(reports.some((r) => r.original.message === 'thread not found'));
});

test('failed app-server startup is diagnosed separately, including effective environment path', async (t) => {
  const f = await fixture(t);
  process.env.KNOWNEX_CODEX_BIN = join(f.root, 'missing.exe');
  await assert.rejects(probeRpc(['available'], f.cwd), {
    code: 'CURATOR_NATIVE_HISTORY_UNAVAILABLE',
  });
  const dir = join(f.root, '.knownex/internal/diagnostics');
  const r = JSON.parse(
    await readFile(join(dir, (await readdir(dir))[0]!), 'utf8'),
  );
  assert.equal(r.phase, 'spawn');
  assert.equal(r.original.code, 'ENOENT');
  assert.equal(r.spawned, false);
  assert.equal(r.executable, process.env.KNOWNEX_CODEX_BIN);
});

test('native checkpoint does not consult the unavailable native provider', async (t) => {
  const f = await fixture(t);
  const memory = join(f.root, '.knownex/memory');
  await mkdir(memory, { recursive: true });
  for (const [name, text] of Object.entries(emptyMemory))
    await writeFile(join(memory, name), text);
  for (const [type, turnId, text] of [
    ['user_message', 'facts', 'Recorded fact'],
    ['assistant_final', 'facts', 'Confirmed.'],
    ['user_message', 'authorization', '$knownex-checkpoint'],
  ] as const)
    await appendFeedEvent(
      f.cwd,
      {
        type,
        sessionId: 'available',
        nativeThreadId: null,
        turnId,
        text,
        hook: type === 'user_message' ? 'UserPromptSubmit' : 'Stop',
      },
      true,
    );
  const bytes = await readFile(join(f.cwd, 'project.jsonl'));
  f.config.mode = 'rpc';
  await f.save();
  const result = await preparedCheckpoint(
    join(f.root, '.knownex/internal/curator'),
    { stage: 'prepare' },
  );
  assert.equal(result.status, 'READY', JSON.stringify(result));
  assert.deepEqual(await readFile(join(f.cwd, 'project.jsonl')), bytes);
  await assert.rejects(readFile(join(f.root, 'calls.jsonl')), {
    code: 'ENOENT',
  });
});

test('transport distinguishes early exit, malformed protocol, timeout and missing working directory', async (t) => {
  const f = await fixture(t);
  for (const mode of ['exit', 'malformed', 'timeout']) {
    f.config.mode = mode;
    await f.save();
    await assert.rejects(probeRpc(['available'], f.cwd), {
      code: 'CURATOR_NATIVE_HISTORY_UNAVAILABLE',
    });
  }
  const dir = join(f.root, '.knownex/internal/diagnostics');
  const reports = await Promise.all(
    (await readdir(dir)).map(async (n) =>
      JSON.parse(await readFile(join(dir, n), 'utf8')),
    ),
  );
  assert.deepEqual(reports.map((r) => r.reason).sort(), [
    'decode',
    'exit',
    'timeout',
  ]);
  assert.ok(reports.some((r) => r.termination.code === 9));
  assert.ok(
    reports.some((r) => r.reason === 'timeout' && r.durationMs >= 5900),
  );
  await assert.rejects(probeRpc(['available'], join(f.root, 'missing-cwd')), {
    code: 'CURATOR_NATIVE_HISTORY_UNAVAILABLE',
  });
  const after = await readdir(dir);
  assert.equal(after.length, 4);
  const failed = [];
  for (const n of after)
    failed.push(JSON.parse(await readFile(join(dir, n), 'utf8')));
  assert.ok(
    failed.some((r) => r.reason === 'spawn' && r.cwd.endsWith('missing-cwd')),
  );
});

test('ordinary approved capture path preserves the skill invocation without consuming authority', async (t) => {
  const f = await fixture(t);
  assert.equal((await nativePreflight(f.root)).status, 'ready');
  await mkdir(join(f.root, '.codex/hooks'), { recursive: true });
  const transcript = join(f.root, 'header.jsonl');
  await writeFile(
    transcript,
    JSON.stringify({
      type: 'session_meta',
      payload: { id: 'native-test', session_id: 'native-test' },
    }) + '\n',
  );
  const r = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../.codex/hooks/feed.cjs', import.meta.url))],
    {
      cwd: f.root,
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        KNOWNEX_WORKSPACE: f.root,
        KNOWNEX_PROJECT_FEED: '1',
      },
      input: JSON.stringify({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'native-test',
        turn_id: 'turn-test',
        prompt: '$knownex-checkpoint',
        transcript_path: transcript,
      }),
    },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), {});
  const lines = (await readFile(join(f.cwd, 'project.jsonl'), 'utf8'))
    .trim()
    .split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).block.event.text, '$knownex-checkpoint');
  assert.equal(
    (await readdir(f.cwd)).some((n) => n.endsWith('.curator.json')),
    false,
  );
});
