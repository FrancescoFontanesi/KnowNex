import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { prepareRetrieval, inventory } from '../retrieval.mjs';
import { memory, source, facts, scenarios } from '../retrieval-fixture.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'knownex-retrieval-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return prepareRetrieval(join(root, 'experiment'));
}
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
function run(f, args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: f.workspace,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, KNOWNEX_WORKSPACE: f.workspace },
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const cli = (f, args) =>
  run(f, [
    join(f.workspace, 'node_modules/knownex/dist/index.js'),
    'memory',
    ...args,
  ]);

test('isolated reference fixture freezes five distinct protocols with a private source/oracle; no runs or checkpoint', async (t) => {
  const f = await fixture(t);
  assert.equal(f.scenarios, 5);
  assert.equal(f.inferenceStarted, false);
  assert.equal(f.checkpointStarted, false);
  const shim = join(
    f.workspace,
    'node_modules/.bin',
    process.platform === 'win32' ? 'knownex.cmd' : 'knownex',
  );
  await readFile(shim); // Must be created by npm, not by copying package files.
  const npmCli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'),
  );
  env.PATH = [
    dirname(process.execPath),
    ...(process.platform === 'win32'
      ? [join(process.env.SystemRoot, 'System32')]
      : ['/usr/bin', '/bin']),
  ].join(delimiter);
  const npmExec = (args) => {
    const result = spawnSync(
      process.execPath,
      [npmCli, 'exec', '--offline', '--', 'knownex', ...args],
      {
        cwd: f.workspace,
        env,
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  const beforeCli = await inventory(f.workspace);
  assert.match(npmExec(['--help']), /knownex memory state/);
  assert.equal(
    JSON.parse(npmExec(['memory', 'state'])).content,
    memory['STATE.md'],
  );
  assert.equal(
    JSON.parse(npmExec(['memory', 'read', 'knowledge/experiments.md'])).content,
    memory['knowledge/experiments.md'],
  );
  const recall = await readFile(
    join(f.workspace, '.agents/skills/knownex-recall/SKILL.md'),
    'utf8',
  );
  // Commands use the workspace-local binary, through the alias K the skill defines.
  assert.match(recall, /`K` = `npm exec --offline -- knownex`/);
  assert.match(recall, /`K memory state`/);
  assert.doesNotMatch(recall, /`knownex (?:memory|pending)/);
  for (const workspace of Object.values(f.workspaces)) {
    const role = await readFile(
      join(workspace, '.codex/agents/knownex_recaller.toml'),
      'utf8',
    );
    assert.match(role, /name = "knownex_recaller"/);
    assert.match(role, /model = "gpt-6\.1-terra"/);
    assert.match(role, /model_reasoning_effort = "medium"/);
    assert.match(role, /Non delegare/);
    const policy = await readFile(join(workspace, 'AGENTS.md'), 'utf8');
    assert.match(policy, /knownex_recaller/);
    assert.match(policy, /fork_turns="none"/);
  }
  if (process.platform === 'win32') {
    const command =
      recall.match(/`K` = `(npm exec --offline -- knownex)`/)[1] +
      ' memory state';
    const powershell = spawnSync(
      join(
        process.env.SystemRoot,
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoProfile', '-NonInteractive', '-Command', command],
      {
        cwd: f.workspace,
        env,
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      },
    );
    assert.ifError(powershell.error);
    assert.equal(powershell.status, 0, powershell.stderr);
    assert.equal(JSON.parse(powershell.stdout).content, memory['STATE.md']);
  }
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: f.workspace,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(git.status, 0, git.stderr);
  assert.equal(await realpath(git.stdout.trim()), await realpath(f.workspace));
  assert.deepEqual(await inventory(f.workspace), beforeCli);
  for (const scenario of scenarios) {
    const exp = join(f.root, 'experiments', scenario.id);
    assert.deepEqual(await readdir(join(exp, 'runs')), []);
    const protocol = await json(join(exp, 'protocol.json'));
    assert.equal(
      protocol.config.workspace,
      await realpath(f.workspaces[scenario.id]),
    );
    assert.equal(protocol.config.limits.modelCalls, 0);
    assert.equal(protocol.config.environment.stateDeliveryVerified, false);
    const oracle = await json(join(exp, 'reference/oracle.json'));
    assert.deepEqual(
      oracle.facts.map((f) => f.id).sort(),
      [...scenario.facts].sort(),
    );
    for (const fact of oracle.facts)
      for (const ref of fact.sources) {
        assert.match(source.split('\n')[ref.startLine - 1], /R[1-6] \|/);
        assert.equal(ref.startLine, ref.endLine);
      }
    assert.equal(
      await readFile(join(exp, 'reference/ledger.txt'), 'utf8'),
      source,
    );
  }
  assert.equal(new Set(Object.values(f.workspaces)).size, 5);
  for (const workspace of Object.values(f.workspaces)) {
    await readFile(
      join(
        workspace,
        'node_modules/.bin',
        process.platform === 'win32' ? 'knownex.cmd' : 'knownex',
      ),
    );
    assert.equal(
      (await readFile(join(workspace, '.knownex/internal/feed/project.jsonl')))
        .length,
      0,
    );
    assert.equal(
      await readFile(join(workspace, '.knownex/memory/STATE.md'), 'utf8'),
      memory['STATE.md'],
    );
  }
  const files = await inventory(f.workspace);
  assert.ok(
    !Object.keys(files).some((name) =>
      /oracle|ledger\.md|scenarios\.json|checkpoint\.json/.test(name),
    ),
  );
  assert.equal(
    (await readFile(join(f.workspace, '.knownex/internal/feed/project.jsonl')))
      .length,
    0,
  );
  await assert.rejects(() => prepareRetrieval(f.root), { code: 'EEXIST' });
  await assert.rejects(
    () => prepareRetrieval(resolve('evaluation/unsafe-output')),
    /OUTPUT_MUST_BE_ISOLATED/,
  );
});

test('ordinary installed SessionStart emits byte-exact seed for startup and compact without modifying fixture memory', async (t) => {
  const f = await fixture(t),
    before = await inventory(f.workspace);
  const hooks = await json(join(f.workspace, '.codex/hooks.json'));
  const hook = hooks.hooks.SessionStart[0].hooks[0];
  assert.equal(hook.additionalContextLimit, 0);
  const script = hook.command.match(/^node "([^"]+)"$/)?.[1];
  assert.ok(script);
  for (const source of ['startup', 'compact']) {
    // A real hook executable, manually supplied event: not native delivery proof.
    const payload = run(f, [resolve(f.workspace, script)], {
      input: JSON.stringify({ hook_event_name: 'SessionStart', source }),
    }).hookSpecificOutput;
    assert.equal(payload.hookEventName, 'SessionStart');
    assert.match(
      payload.additionalContext,
      /seed non materializzato, cutoff E0/,
    );
    assert.ok(payload.additionalContext.endsWith(memory['STATE.md']));
    assert.match(
      payload.additionalContext,
      new RegExp(Buffer.byteLength(memory['STATE.md']) + ' byte UTF-8'),
    );
    assert.ok(!payload.additionalContext.includes('10000 righe')); // Detail remains in Knowledge.
    assert.deepEqual(
      Buffer.from(payload.additionalContext.slice(-memory['STATE.md'].length)),
      Buffer.from(memory['STATE.md']),
    );
  }
  assert.deepEqual(await inventory(f.workspace), before);
});

test('direct, linked, historical and negative retrieval routes expose the exact reference content without checkpoint or writes', async (t) => {
  const f = await fixture(t),
    before = await inventory(f.workspace);
  assert.equal(cli(f, ['state']).content, memory['STATE.md']);
  let navigations = 0;
  for (const scenario of scenarios) {
    const selected = { ...f, workspace: f.workspaces[scenario.id] };
    for (const reference of scenario.route) {
      const result = cli(selected, ['read', reference]);
      const expected = memory[reference.split('#')[0]];
      assert.ok(expected);
      if (reference.includes('#')) {
        assert.match(result.content, /SQLite/);
        assert.match(result.content, /superato/);
      } else assert.equal(result.content, expected);
      navigations++;
    }
    assert.equal(scenario.targetReads, scenario.route.length);
  }
  assert.equal(navigations, 4);
  // Every local link resolves; a missing reference must fail, not fabricate data.
  for (const [name, content] of Object.entries(memory))
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      const target = resolve(
        dirname(join(f.workspace, '.knownex/memory', name)),
        match[1].split('#')[0],
      );
      assert.ok(
        Object.keys(memory).some(
          (key) => resolve(f.workspace, '.knownex/memory', key) === target,
        ),
      );
    }
  assert.match(
    memory['knowledge/decisions.md'],
    /Responsabile del rilascio non documentato/,
  );
  assert.match(facts.find((f) => f.id === 'owner').expected, /senza inventare/);
  const absent = spawnSync(
    process.execPath,
    [
      join(f.workspace, 'node_modules/knownex/dist/index.js'),
      'memory',
      'read',
      'knowledge/absent.md',
    ],
    { cwd: f.workspace, encoding: 'utf8' },
  );
  assert.notEqual(absent.status, 0);
  assert.deepEqual(await inventory(f.workspace), before);
});
