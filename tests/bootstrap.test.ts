import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { nativeFixture } from './native-fixture.ts';

const repository = resolve('.');
const archive = process.env.KNOWNEX_INSTALL_ARCHIVE
  ? resolve(process.env.KNOWNEX_INSTALL_ARCHIVE)
  : undefined;
const npmCli =
  process.env.npm_execpath ??
  join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
function npm(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [npmCli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  assert.ifError(r.error);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
}

test(
  'installed payload bootstraps an independent workspace and preserves project pending across sessions',
  { timeout: 120000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'knownex install '));
    t.after(async () => {
      assert.equal(dirname(root), resolve(tmpdir()));
      await rm(root, { recursive: true, force: true });
    });
    // S4 must not regenerate the installer. Exercise a copy of the compiled
    // package payload, still denying runtime access to the source repository.
    if (!archive) npm(['run', 'build'], repository);
    let project = join(root, 'empty project');
    await mkdir(project);
    project = await realpath(project);
    const installed = join(project, 'node_modules/knownex');
    const metadata = JSON.parse(
      await readFile(join(repository, 'package.json'), 'utf8'),
    );
    if (archive) {
      npm(
        [
          'install',
          '--offline',
          '--no-save',
          '--package-lock=false',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          archive,
        ],
        project,
      );
      assert.match(
        npm(['exec', '--offline', '--', 'knownex', '--help'], project),
        /knownex pending/,
      );
    } else {
      await mkdir(installed, { recursive: true });
      for (const name of ['package.json', ...metadata.files]) {
        await mkdir(dirname(join(installed, name)), { recursive: true });
        await cp(join(repository, name), join(installed, name), {
          recursive: true,
        });
      }
    }
    const entry = join(project, 'node_modules/knownex/dist/index.js');
    // Runtime Node processes may access this workspace, not the source repository.
    const canonical = project;
    const permissions = `--permission --allow-fs-read="${canonical.replaceAll('\\', '/')}" --allow-fs-write="${canonical.replaceAll('\\', '/')}" --allow-child-process --disable-warning=SecurityWarning`;
    function node(args: string[], input?: unknown) {
      const r = spawnSync(process.execPath, args, {
        cwd: project,
        env: {
          ...process.env,
          NODE_OPTIONS: permissions,
          KNOWNEX_CODEX_BIN: process.execPath,
        },
        input: input === undefined ? undefined : JSON.stringify(input),
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      assert.ifError(r.error);
      return r;
    }
    function cli(args: string[]) {
      const r = node([entry, ...args]);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      return JSON.parse(r.stdout);
    }
    assert.notEqual(
      node([
        '--eval',
        "require('node:fs').readFileSync(process.argv[1])",
        join(repository, 'package.json'),
      ]).status,
      0,
    );
    assert.match(node([entry, '--help']).stdout, /knownex init/);
    const personal = '# Project instructions\n\nKeep this text.\n';
    await writeFile(join(project, 'AGENTS.md'), personal);
    const personalIgnore = '# Personal rules\ncustom-output/\n';
    await writeFile(join(project, '.gitignore'), personalIgnore);
    const initialized = cli(['init']);
    const native = await nativeFixture(join(project, '.knownex/internal/feed'));
    await assert.rejects(stat(join(project, 'memory')), { code: 'ENOENT' });
    const agents = await readFile(join(project, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith(personal));
    const currentPolicy = (
      await readFile(join(repository, 'AGENTS.md'), 'utf8')
    ).match(/<!-- knownex:start -->[\s\S]*?<!-- knownex:end -->/)?.[0];
    assert.ok(currentPolicy);
    assert.equal(
      agents.match(/<!-- knownex:start -->[\s\S]*?<!-- knownex:end -->/)?.[0],
      currentPolicy,
    );
    assert.equal(agents.split('<!-- knownex:start -->').length, 2);
    assert.deepEqual(initialized.updated, ['AGENTS.md', '.gitignore']);
    assert.ok(
      (await readFile(join(project, '.gitignore'), 'utf8')).startsWith(
        personalIgnore,
      ),
    );
    assert.ok(
      (await readFile(join(project, '.gitignore'), 'utf8')).includes(
        '.knownex/',
      ),
    );
    assert.equal(initialized.status, 'initialized');
    assert.ok(initialized.nextSteps.some((s: string) => s.includes(project)));
    assert.match(initialized.nextSteps.join(' '), /autorizza esplicitamente/);
    assert.match(initialized.nextSteps.join(' '), /approva esplicitamente/);
    assert.match(initialized.nextSteps.join(' '), /SessionStart/);
    assert.ok(initialized.created.includes('.codex/hooks.json'));
    assert.ok(initialized.created.includes('.codex/config.toml'));
    assert.ok(
      initialized.created.includes('.codex/agents/knownex_curator.toml'),
    );
    const nativeRole = await readFile(
      join(project, '.codex/agents/knownex_curator.toml'),
      'utf8',
    );
    assert.match(nativeRole, /model = "gpt-6\.1-terra"/);
    assert.match(nativeRole, /model_reasoning_effort = "medium"/);
    assert.match(nativeRole, /modalita materialize-only/);
    assert.match(
      nativeRole,
      /Non eseguire prepare, validate, apply, curate native/,
    );
    assert.ok(
      initialized.created.includes('.codex/agents/knownex_recaller.toml'),
    );
    const recallRole = await readFile(
      join(project, '.codex/agents/knownex_recaller.toml'),
      'utf8',
    );
    assert.equal(
      recallRole,
      await readFile(
        join(installed, '.codex/agents/knownex_recaller.toml'),
        'utf8',
      ),
    );
    assert.match(recallRole, /name = "knownex_recaller"/);
    for (const role of [nativeRole, recallRole]) {
      assert.match(role, /model = "gpt-6\.1-terra"/);
      assert.match(role, /model_reasoning_effort = "medium"/);
    }
    assert.match(recallRole, /knownex-recall\/SKILL\.md/);
    assert.match(recallRole, /Non delegare/);
    assert.doesNotMatch(recallRole, /^sandbox_mode\s*=/m);
    assert.match(agents, /knownex_recaller/);
    assert.match(agents, /fork_turns="none"/);
    const recallSkill = await readFile(
      join(project, '.agents/skills/knownex-recall/SKILL.md'),
      'utf8',
    );
    assert.match(recallSkill, /knownex_recaller/);
    assert.match(recallSkill, /Nessun fallback automatico/);
    assert.match(
      recallSkill,
      /istruzioni di delega del principale non si applicano/,
    );
    assert.match(recallRole, /permessi effettivi.*ereditati/);
    assert.match(agents, /non naviga STATE, Knowledge, HISTORY o pending/);
    // A known reference costs one read: no delegation for it.
    assert.match(
      agents,
      /riferimento già noto[^\n]*`npm exec --offline -- knownex memory read`/,
    );
    assert.match(agents, /anche dopo compact/);
    // Upgrade an owned installation without the new role; data and other roles stay intact.
    const recallPath = '.codex/agents/knownex_recaller.toml';
    const installPath = join(project, '.knownex/internal/install.json');
    const previousInstall = JSON.parse(await readFile(installPath, 'utf8'));
    delete previousInstall.files[recallPath];
    await writeFile(
      installPath,
      JSON.stringify(previousInstall, null, 2) + '\n',
    );
    await rm(join(project, recallPath));
    const roleUpgrade = cli(['init']);
    assert.deepEqual(roleUpgrade.created, [recallPath]);
    assert.deepEqual(roleUpgrade.updated, ['.knownex/internal/install.json']);
    assert.equal(await readFile(join(project, recallPath), 'utf8'), recallRole);
    assert.equal(
      await readFile(
        join(project, '.codex/agents/knownex_curator.toml'),
        'utf8',
      ),
      nativeRole,
    );
    // A user-modified role blocks init before any managed resources are changed.
    const guardedNames = [
      'AGENTS.md',
      '.codex/config.toml',
      '.codex/hooks.json',
      '.knownex/internal/install.json',
      '.knownex/memory/STATE.md',
      '.knownex/memory/HISTORY.md',
      '.knownex/internal/feed/project.jsonl',
    ];
    const guarded = await Promise.all(
      guardedNames.map(
        async (name) => [name, await readFile(join(project, name))] as const,
      ),
    );
    const personalRole = recallRole + '\n# Personal role customization\n';
    await writeFile(join(project, recallPath), personalRole);
    const roleConflict = node([entry, 'init']);
    assert.equal(roleConflict.status, 1);
    assert.equal(JSON.parse(roleConflict.stderr).code, 'BOOTSTRAP_CONFLICT');
    assert.equal(JSON.parse(roleConflict.stderr).file, recallPath);
    assert.equal(
      await readFile(join(project, recallPath), 'utf8'),
      personalRole,
    );
    for (const [name, bytes] of guarded)
      assert.deepEqual(await readFile(join(project, name)), bytes, name);
    await writeFile(join(project, recallPath), recallRole);
    const checkpointSkill = await readFile(
      join(project, '.agents/skills/knownex-checkpoint/SKILL.md'),
      'utf8',
    );
    assert.match(checkpointSkill, /curate native --stage prepare/);
    assert.match(checkpointSkill, /curate native --stage complete/);
    assert.match(checkpointSkill, /"workerMode": "materialize-only"/);
    assert.ok(!nativeRole.includes('native-owner'));
    // Execute the installed runtime directly: no registry/cache or npm fallback.
    const nativeDenied = node([
      entry,
      'curate',
      'native',
      '--stage',
      'prepare',
      '--work',
      '.knownex/internal/curator',
    ]);
    assert.equal(nativeDenied.status, 0);
    assert.equal(JSON.parse(nativeDenied.stdout).action, 'noop');
    await assert.rejects(
      stat(join(project, '.agents/skills/knownex-handoff/SKILL.md')),
      { code: 'ENOENT' },
    );
    const agentConfig = await readFile(
      join(project, '.codex/config.toml'),
      'utf8',
    );
    assert.equal(
      agentConfig,
      await readFile(join(installed, '.codex/config.toml'), 'utf8'),
    );
    assert.match(agentConfig, /default_subagent_model = "gpt-6\.1-terra"/);
    assert.match(agentConfig, /default_subagent_reasoning_effort = "medium"/);
    assert.ok(!initialized.created.some((p: string) => /graft/i.test(p)));
    await assert.rejects(stat(join(project, 'graft')), { code: 'ENOENT' });
    const configText = await readFile(
      join(project, '.codex/hooks.json'),
      'utf8',
    );
    const config = JSON.parse(configText);
    assert.deepEqual(Object.keys(config.hooks), [
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'SessionEnd',
    ]);
    const paths = initialized.created as string[];
    for (const p of paths) {
      const text = await readFile(join(project, p), 'utf8');
      assert.ok(
        !text
          .toLowerCase()
          .includes(repository.replaceAll('\\', '/').toLowerCase()),
        p,
      );
      assert.ok(!text.toLowerCase().includes(repository.toLowerCase()), p);
    }
    for (const name of [
      'knownex-checkpoint',
      'knownex-curator',
      'knownex-recall',
      'knownex-taxonomy',
    ]) {
      const text = await readFile(
        join(project, '.agents/skills', name, 'SKILL.md'),
        'utf8',
      );
      assert.ok(text.startsWith(`---\nname: ${name}\ndescription: `));
      for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
        const href = m[1]!;
        await stat(resolve(project, '.agents/skills', name, href));
      }
    }
    assert.match(
      await readFile(
        join(project, '.agents/skills/knownex-taxonomy/agents/openai.yaml'),
        'utf8',
      ),
      /allow_implicit_invocation: false/,
    );
    await stat(join(project, '.knownex/internal/docs/TAXONOMY.md'));
    assert.match(cli(['memory', 'state']).content, /Nessuna informazione/);
    let session = 'synthetic-install-session';
    const transcript = join(project, 'synthetic.jsonl');
    await writeFile(
      transcript,
      JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n',
    );
    function hooks(event: string, fields: Record<string, unknown>) {
      if (event === 'UserPromptSubmit')
        native.retain(session, String(fields.turn_id ?? 'turn-1'));
      let output;
      for (const group of config.hooks[event])
        for (const h of group.hooks) {
          const script = h.command.match(/^node "([^"]+)"$/)?.[1];
          assert.ok(script);
          const r = node([resolve(project, script)], {
            hook_event_name: event,
            session_id: session,
            turn_id: 'turn-1',
            transcript_path: transcript,
            ...fields,
          });
          assert.equal(r.status, 0, r.stderr);
          output = JSON.parse(r.stdout);
          if (event !== 'SessionStart') assert.deepEqual(output, {}, r.stdout);
        }
      return output;
    }
    const start = hooks('SessionStart', {}).hookSpecificOutput;
    assert.equal(start.hookEventName, 'SessionStart');
    assert.match(start.additionalContext, /0 eventi pendenti/);
    const originalSeed = await readFile(
      join(project, '.knownex/memory/STATE.md'),
      'utf8',
    );
    await writeFile(
      join(project, '.knownex/memory/STATE.md'),
      '# Oversized seed\n' + 'x'.repeat(7000),
    );
    const complete = hooks('SessionStart', {}).hookSpecificOutput
      .additionalContext;
    assert.ok(complete.endsWith('# Oversized seed\n' + 'x'.repeat(7000)));
    assert.equal(
      config.hooks.SessionStart[0].hooks[0].additionalContextLimit,
      0,
    );
    await writeFile(join(project, '.knownex/memory/STATE.md'), originalSeed);
    hooks('UserPromptSubmit', {
      prompt: 'Synthetic bootstrap \u00e8 \ud83e\udde0',
    });
    hooks('Stop', { last_assistant_message: 'Synthetic final' });
    hooks('SessionEnd', {});
    const hash = createHash('sha256').update(session).digest('hex');
    const feed = join(project, '.knownex/internal/feed/project.jsonl');
    const feedBytes = await readFile(feed);
    const frames = feedBytes
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((x) => JSON.parse(x));
    assert.deepEqual(
      frames.map((f) => f.block.event.type),
      ['user_message', 'assistant_final'],
    );
    assert.equal(
      frames[0].block.event.text,
      'Synthetic bootstrap \u00e8 \ud83e\udde0',
    );
    const capture = await readFile(
      join(project, '.knownex/internal/captures', hash + '.jsonl'),
      'utf8',
    );
    assert.ok(capture.includes('session_meta'));
    hooks('UserPromptSubmit', {
      prompt: 'Synthetic bootstrap \u00e8 \ud83e\udde0',
    });
    assert.deepEqual(await readFile(feed), feedBytes);
    session = 'synthetic-session-B';
    const next = hooks('SessionStart', {}).hookSpecificOutput.additionalContext;
    assert.match(next, /2 eventi pendenti/);
    assert.ok(Buffer.byteLength(next) < 8192);
    assert.equal(cli(['runtime']).pending, 2);
    await writeFile(
      transcript,
      JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n',
    );
    hooks('UserPromptSubmit', { prompt: 'Continue A in B' });
    hooks('Stop', {
      last_assistant_message: 'A+B result',
      stop_hook_active: true,
    });
    let combined = await readFile(feed);
    hooks('Stop', { last_assistant_message: 'A+B result' });
    assert.deepEqual(await readFile(feed), combined);
    assert.equal(cli(['runtime']).pending, 4);
    const selectivePending = cli(['pending', '--limit', '1']);
    assert.equal(selectivePending.cutoff, 0);
    assert.equal(selectivePending.events.length, 1);
    assert.equal(selectivePending.events[0].sequence, 1);
    assert.equal(selectivePending.pendingComplete, false);
    await assert.rejects(
      stat(join(project, '.knownex/internal/curator/checkpoint.json')),
      { code: 'ENOENT' },
    );
    assert.deepEqual(await readFile(feed), combined);
    const seed = await readFile(
      join(project, '.knownex/memory/STATE.md'),
      'utf8',
    );
    const work = join(project, '.knownex/internal/curator');
    cli([
      'curate',
      'init',
      '--work',
      work,
      '--memory',
      join(project, '.knownex/memory'),
      '--feed',
      feed,
      '--through',
      '0',
    ]);
    function invokeHandoff(milestone: string) {
      hooks('UserPromptSubmit', {
        turn_id: milestone + '-yes',
        prompt:
          '[$knownex-checkpoint](' +
          join(project, '.agents/skills/knownex-checkpoint/SKILL.md') +
          ')',
      });
      return { sequence: cli(['runtime']).latest };
    }
    const request = invokeHandoff('one');
    combined = await readFile(feed);
    const prep = cli([
      'curate',
      'prepare',
      '--work',
      work,
      '--through',
      '4',
      '--autonomous',
    ]);
    assert.equal(cli(['runtime', '--summary']).state, undefined);
    const packet = JSON.parse(
      await readFile(join(prep.run, 'packet.json'), 'utf8'),
    );
    assert.equal(packet.events.length, 4);
    assert.equal(packet.directive, '');
    await assert.rejects(stat(join(project, '.knownex/directive.md')), {
      code: 'ENOENT',
    });
    assert.deepEqual(
      packet.events.map((e: { sequence: number }) => e.sequence),
      [1, 2, 3, 4],
    );
    assert.equal(
      new Set(packet.events.map((e: { sessionId: string }) => e.sessionId))
        .size,
      2,
    );
    assert.deepEqual(packet.orderingIssues, []);
    const requestOutput = join(prep.run, 'request.txt');
    const transport = node([
      join(installed, 'dist/curator-request.js'),
      '--run',
      prep.run,
      '--output',
      requestOutput,
    ]);
    assert.equal(transport.status, 0, transport.stderr);
    const requestText = await readFile(requestOutput, 'utf8');
    assert.deepEqual(
      JSON.parse(requestText.split('INPUT_REFERENCES_JSON\n')[1]!).packet.path,
      join(prep.run, 'packet.json'),
    );
    await stat(join(prep.run, 'SKILL.md'));
    await stat(join(prep.run, 'WINDOW.md'));
    await assert.rejects(stat(join(prep.run, 'MEMORY-CONTRACT.md')), {
      code: 'ENOENT',
    });
    await writeFile(prep.proposal, '{"action":"invalid"}\n');
    assert.equal(node([entry, 'curate', 'validate', '--work', work]).status, 1);
    assert.equal(cli(['runtime']).pending, 4);
    assert.equal(cli(['runtime']).pendingRaw, 5);
    assert.equal(cli(['runtime']).through, 0);
    assert.equal(cli(['runtime']).activeRun, prep.run);
    assert.match(
      hooks('SessionStart', {}).hookSpecificOutput.additionalContext,
      /Batch gia attivo/,
    );
    // Test fixture repairs JSON deterministically; no LLM retry is performed.
    await writeFile(
      prep.proposal,
      JSON.stringify({
        action: 'update',
        state:
          '# Synthetic A+B state\n\nA+B result. [E001..E004](' +
          packet.feed +
          ')\n',
        history: {
          summary: 'A+B',
          topics: ['Synthetic'],
          transition: 'Consolidate A+B synthetic result',
        },
        knowledge: {
          'knowledge/bootstrap.md':
            '---\nid: kn-00000000-0000-4000-8000-000000000001\ntype: knowledge\n---\n\n# Synthetic bootstrap\n\nReusable fixture detail. [E004](../' +
            packet.feed +
            ')\n',
        },
      }),
    );
    const writtenProposal = await readFile(prep.proposal);
    await writeFile(
      join(prep.run, 'review.json'),
      JSON.stringify({
        version: 1,
        proposalSha256: createHash('sha256')
          .update(writtenProposal)
          .digest('hex'),
        summary: 'Fixture review, not a semantic-model evaluation',
        sources: [1, 4],
        changes: [
          { path: 'STATE.md', summary: 'Initial state', sources: [1, 4] },
          {
            path: 'knowledge/bootstrap.md',
            summary: 'Initial detail',
            sources: [4],
          },
        ],
        critical: [],
        uncertainties: [],
        anomalies: [],
      }),
    );
    const validation = cli(['curate', 'validate', '--work', work]);
    assert.equal(
      cli(['curate', 'apply', '--work', work, '--confirm', validation.seal])
        .through,
      4,
    );
    assert.match(
      cli(['memory', 'state', '--memory', join(project, '.knownex/memory')])
        .content,
      /Synthetic A\+B state/,
    );
    assert.match(cli(['memory', 'state']).content, /Synthetic A\+B state/);
    assert.ok(
      cli(['memory', 'find', 'Reusable']).results.some(
        (r: { id: string }) =>
          r.id === 'kn-00000000-0000-4000-8000-000000000001',
      ),
    );
    assert.equal(cli(['runtime']).pending, 0);
    const initialCheckpoint = JSON.parse(
      await readFile(join(work, 'checkpoint.json'), 'utf8'),
    );
    const publicationFile =
      '.knownex/memory/knowledge/' +
      initialCheckpoint.knowledgeVersions.heads['knowledge/bootstrap.md'].file;
    const record = JSON.parse(
      await readFile(join(work, 'apply.json'), 'utf8'),
    ).record;
    const history = await readFile(join(project, '.knownex/memory/HISTORY.md'));
    // Process interruption model: authorization persisted, only STATE promoted.
    await writeFile(
      join(work, 'checkpoint.json'),
      JSON.stringify(record.before),
    );
    await writeFile(
      join(project, '.knownex/memory/HISTORY.md'),
      record.previous['HISTORY.md'],
    );
    assert.equal(cli(['runtime']).through, 4);
    assert.deepEqual(
      await readFile(join(project, '.knownex/memory/HISTORY.md')),
      history,
    );
    assert.equal(cli(['runtime']).pending, 0);
    cli(['curate', 'apply', '--work', work, '--confirm', validation.seal]);
    assert.deepEqual(
      await readFile(join(project, '.knownex/memory/HISTORY.md')),
      history,
    );
    assert.equal(
      (
        history.toString().match(/^- \[H000001\]\(history\/H000001\.md\)/gm) ??
        []
      ).length,
      1,
    );
    const resumed = hooks('SessionStart', { source: 'compact' })
      .hookSpecificOutput.additionalContext;
    assert.match(resumed, /Synthetic A\+B state/);
    assert.match(resumed, /0 eventi pendenti/);
    // S4.4 A: the consumed invocation is not a new milestone, even under a new key.
    const checkpointBeforeReport = await readFile(
      join(work, 'checkpoint.json'),
    );
    const authorityBeforeReport = await readFile(feed + '.curator.json');
    const feedBeforeReport = await readFile(feed);
    assert.equal(cli(['curate', 'prepare', '--work', work]).status, 'noop');
    assert.deepEqual(await readFile(feed), feedBeforeReport);
    hooks('Stop', {
      turn_id: 'one-yes',
      last_assistant_message: 'Memoria consolidata.',
    });
    combined = await readFile(feed);
    assert.ok(combined.toString('utf8').includes('Memoria consolidata.'));
    assert.ok(
      combined.subarray(0, feedBeforeReport.length).equals(feedBeforeReport),
    );
    hooks('SessionEnd', {});
    const reportOnly = node([entry, 'curate', 'prepare', '--work', work]);
    assert.equal(reportOnly.status, 0);
    assert.equal(JSON.parse(reportOnly.stdout).status, 'noop');
    // E: a new SessionStart reports pending without treating it as progress or
    // mutating the checkpoint/authorization. This checks context, not model semantics.
    const cold = hooks('SessionStart', {
      session_id: 'new-cold-session',
      source: 'startup',
    }).hookSpecificOutput.additionalContext;
    assert.match(cold, /0 eventi pendenti/);
    assert.match(cold, /pending non prova progresso sostanziale/);
    assert.deepEqual(
      await readFile(join(work, 'checkpoint.json')),
      checkpointBeforeReport,
    );
    assert.deepEqual(
      await readFile(feed + '.curator.json'),
      authorityBeforeReport,
    );
    assert.deepEqual(await readFile(feed), combined);
    // Mixed confirmed data never reach the model as valid context.
    const confirmedState = await readFile(
      join(project, '.knownex/memory/STATE.md'),
    );
    await writeFile(
      join(project, '.knownex/memory/STATE.md'),
      '# Tampered mixed state\n',
    );
    const unsafe = hooks('SessionStart', {}).hookSpecificOutput
      .additionalContext;
    assert.match(unsafe, /non verificati/);
    assert.doesNotMatch(unsafe, /Tampered/);
    await writeFile(join(project, '.knownex/memory/STATE.md'), confirmedState);
    session = 'synthetic-session-C';
    await writeFile(
      transcript,
      JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n',
    );
    // B/D: genuine new work mentioning administrative vocabulary is not filtered.
    const technicalPrompt =
      'KnowNex: difetto nel consenso checkpoint; correggere il blocker di continuita.';
    hooks('UserPromptSubmit', { prompt: technicalPrompt });
    hooks('Stop', { last_assistant_message: 'No changes' });
    combined = await readFile(feed);
    const secondRequest = invokeHandoff('two');
    combined = await readFile(feed);
    const second = cli(['curate', 'prepare', '--work', work]);
    const secondPacket = JSON.parse(
      await readFile(join(second.run, 'packet.json'), 'utf8'),
    );
    assert.deepEqual(
      secondPacket.events.map((e: { sequence: number }) => e.sequence),
      [7, 8],
    );
    assert.deepEqual(secondPacket.orderingIssues, []);
    assert.ok(
      secondPacket.events.some(
        (e: { text: string }) => e.text === technicalPrompt,
      ),
    );
    assert.ok(
      !secondPacket.events.some(
        (e: { text: string }) => e.text === 'Memoria consolidata.',
      ),
    );
    // Same frozen batch on repeated prepare; no additional run/delegation.
    assert.equal(cli(['curate', 'prepare', '--work', work]).run, second.run);
    await writeFile(second.proposal, '{"action":"noop"}\n');
    const secondSeal = cli(['curate', 'validate', '--work', work]).seal;
    cli(['curate', 'apply', '--work', work, '--confirm', secondSeal]);
    cli(['curate', 'apply', '--work', work, '--confirm', secondSeal]);
    assert.equal(
      JSON.parse(await readFile(join(work, 'checkpoint.json'), 'utf8'))
        .sessionId,
      session,
    );
    assert.equal(cli(['runtime']).pending, 0);
    assert.equal(cli(['curate', 'prepare', '--work', work]).status, 'noop');
    assert.deepEqual(
      await readFile(join(project, '.knownex/memory/HISTORY.md')),
      history,
    );
    // Managed policy replacement preserves the user's prefix and suffix.
    const obsolete =
      agents.replace('## KnowNex continuity', '## Older policy') +
      '\nUser suffix.\n';
    await writeFile(join(project, 'AGENTS.md'), obsolete);
    assert.deepEqual(cli(['init']).updated, ['AGENTS.md']);
    const refreshed = await readFile(join(project, 'AGENTS.md'), 'utf8');
    assert.ok(refreshed.startsWith(personal));
    assert.ok(refreshed.endsWith('\nUser suffix.\n'));
    assert.equal(refreshed.split('<!-- knownex:start -->').length, 2);
    // A previous manifest authorizes only its exact generated bytes to update.
    const startBefore = await readFile(
      join(project, '.knownex/README.md'),
      'utf8',
    );
    const olderStart = startBefore + '\nPrevious installer resource.\n';
    const manifest = JSON.parse(
      await readFile(join(project, '.knownex/internal/install.json'), 'utf8'),
    );
    manifest.packageVersion = 'previous-fixture';
    manifest.files['.knownex/README.md'] = createHash('sha256')
      .update(olderStart)
      .digest('hex');
    await writeFile(join(project, '.knownex/README.md'), olderStart);
    await writeFile(
      join(project, '.knownex/internal/install.json'),
      JSON.stringify(manifest),
    );
    const upgraded = cli(['init']);
    assert.ok(upgraded.updated.includes('.knownex/README.md'));
    assert.equal(
      await readFile(join(project, '.knownex/README.md'), 'utf8'),
      startBefore,
    );
    const preservePaths = [
      ...paths,
      'AGENTS.md',
      '.codex/config.toml',
      '.gitignore',
      '.knownex/internal/feed/project.jsonl',
      '.knownex/internal/captures/' + hash + '.jsonl',
      '.knownex/internal/curator/checkpoint.json',
      '.knownex/internal/feed/project.jsonl.curator.json',
      '.knownex/internal/curator/apply.json',
      '.knownex/memory/STATE.md',
      '.knownex/memory/HISTORY.md',
      publicationFile,
    ];
    const before = await Promise.all(
      preservePaths.map(async (p) => ({
        p,
        bytes: await readFile(join(project, p)),
        mtime: (await stat(join(project, p), { bigint: true })).mtimeNs,
      })),
    );
    assert.deepEqual(cli(['init']).created, []);
    for (const x of before) {
      assert.deepEqual(await readFile(join(project, x.p)), x.bytes, x.p);
      assert.equal(
        (await stat(join(project, x.p), { bigint: true })).mtimeNs,
        x.mtime,
        x.p,
      );
    }
    if (archive) {
      for (const args of [
        ['init', '--quiet'],
        [
          'check-ignore',
          '--no-index',
          '--',
          '.knownex/internal/feed/project.jsonl',
          '.knownex/internal/curator/apply.json',
          'node_modules/knownex/package.json',
        ],
      ]) {
        const git = spawnSync('git', args, {
          cwd: project,
          encoding: 'utf8',
          windowsHide: true,
        });
        assert.equal(git.status, 0, git.stderr);
        if (args[0] === 'check-ignore')
          assert.equal(git.stdout.trim().split(/\r?\n/).length, 3);
      }
      // One integrated packed-install smoke; no model or semantic benchmark.
      const critical = async () =>
        Promise.all(
          [
            'AGENTS.md',
            '.gitignore',
            '.knownex/internal/install.json',
            '.knownex/internal/feed/project.jsonl',
            '.knownex/internal/curator/checkpoint.json',
            '.knownex/internal/feed/project.jsonl.curator.json',
            '.knownex/internal/curator/apply.json',
            '.knownex/memory/STATE.md',
            '.knownex/memory/HISTORY.md',
            publicationFile,
          ].map(async (p) => ({
            p,
            bytes: await readFile(join(project, p)),
            mtime: (await stat(join(project, p), { bigint: true })).mtimeNs,
          })),
        );
      const manual = (milestone: string, invoke = true) => {
        hooks('UserPromptSubmit', {
          turn_id: milestone + '-reply',
          prompt: invoke ? '$knownex-checkpoint' : 'Non ora',
        });
        return { sequence: cli(['runtime']).latest };
      };
      hooks('Stop', {
        turn_id: 'two-yes',
        last_assistant_message: 'Checkpoint completed.',
      });
      hooks('UserPromptSubmit', {
        turn_id: 'new-work',
        prompt: 'New synthetic project work',
      });
      hooks('Stop', {
        turn_id: 'new-work',
        last_assistant_message: 'Synthetic progress',
      });
      const no = manual('declined-smoke', false);
      const refusedSnapshot = await critical();
      assert.deepEqual(await critical(), refusedSnapshot);
      hooks('Stop', {
        turn_id: 'declined-smoke-reply',
        last_assistant_message: 'Checkpoint deferred.',
      });
      const failedRequest = manual('failed-smoke');
      const failed = cli(['curate', 'prepare', '--work', work]);
      await writeFile(failed.proposal, '{');
      const failureSnapshot = await critical();
      assert.equal(
        node([entry, 'curate', 'validate', '--work', work]).status,
        1,
      );
      assert.deepEqual(await critical(), failureSnapshot);
      const withdrawn = cli([
        'curate',
        'abandon',
        '--work',
        work,
        '--run',
        failed.run.split(/[\\/]/).at(-1),
      ]);
      assert.equal(withdrawn.status, 'abandoned');
      assert.equal(cli(['runtime']).activeRun, null);
      hooks('Stop', {
        turn_id: 'failed-smoke-reply',
        last_assistant_message:
          'Materialization not confirmed; events retained.',
      });
      const freshRequest = manual('fresh-smoke');
      assert.notEqual(freshRequest.sequence, failedRequest.sequence);
      const fresh = cli(['curate', 'prepare', '--work', work]);
      await writeFile(fresh.proposal, '{"action":"noop"}');
      const freshApproval = cli(['curate', 'validate', '--work', work]);
      cli(['curate', 'apply', '--work', work, '--confirm', freshApproval.seal]);
      assert.equal(cli(['runtime']).activeRun, null);
      hooks('UserPromptSubmit', {
        turn_id: 'bounded',
        prompt: 'Large UTF-8 pending è 🧠 '.repeat(4000),
      });
      const latest = cli(['runtime']).latest;
      const bounded = node([
        entry,
        'pending',
        '--from',
        String(latest),
        '--through',
        String(latest),
      ]);
      assert.equal(bounded.status, 0, bounded.stderr);
      assert.ok(Buffer.byteLength(bounded.stdout) <= 16384);
      assert.equal(JSON.parse(bounded.stdout).events[0].textComplete, false);
      const reinstallSnapshot = await critical();
      npm(
        [
          'install',
          '--offline',
          '--no-save',
          '--package-lock=false',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          archive,
        ],
        project,
      );
      const reinstalled = cli(['init']);
      assert.deepEqual(reinstalled.created, []);
      assert.deepEqual(reinstalled.updated, []);
      assert.deepEqual(await critical(), reinstallSnapshot);

      // Exact S3 resources are adopted; previous user data and journals stay byte-identical.
      await t.test(
        'upgrade from the optional original S3 workspace',
        {
          skip: process.env.KNOWNEX_PREVIOUS_WORKSPACE
            ? false
            : 'Original S3 fixture not supplied; this run does not verify S3 adoption',
        },
        async () => {
          assert.ok(process.env.KNOWNEX_PREVIOUS_WORKSPACE);
          const previous = await realpath(
            process.env.KNOWNEX_PREVIOUS_WORKSPACE,
          );
          assert.equal(dirname(previous), await realpath(tmpdir()));
          const previousEntry = join(
            previous,
            'node_modules/knownex/dist/index.js',
          );
          assert.equal(
            JSON.parse(
              await readFile(
                join(previous, 'node_modules/knownex/package.json'),
                'utf8',
              ),
            ).version,
            '0.0.0',
          );
          const previousOptions = permissions.replaceAll(
            canonical.replaceAll('\\', '/'),
            previous.replaceAll('\\', '/'),
          );
          function oldNode(args: string[], input?: unknown) {
            const r = spawnSync(process.execPath, args, {
              cwd: previous,
              env: { ...process.env, NODE_OPTIONS: previousOptions },
              encoding: 'utf8',
              windowsHide: true,
              timeout: 15000,
              input: input === undefined ? undefined : JSON.stringify(input),
            });
            assert.ifError(r.error);
            assert.equal(r.status, 0, r.stderr + r.stdout);
            return JSON.parse(r.stdout);
          }
          const previousSession = 's5-previous-synthetic';
          const previousHash = createHash('sha256')
            .update(previousSession)
            .digest('hex');
          const previousTranscript = join(previous, 'synthetic.jsonl');
          await writeFile(
            previousTranscript,
            JSON.stringify({
              type: 'session_meta',
              payload: { id: previousSession },
            }) + '\n',
          );
          const payload = {
            session_id: previousSession,
            turn_id: 'previous',
            transcript_path: previousTranscript,
          };
          oldNode([join(previous, '.codex/hooks/knownex-feed.cjs')], {
            ...payload,
            hook_event_name: 'UserPromptSubmit',
            prompt: 'Previous project fact',
          });
          oldNode([join(previous, '.codex/hooks/knownex-feed.cjs')], {
            ...payload,
            hook_event_name: 'Stop',
            last_assistant_message: 'Previous report',
          });
          oldNode([join(previous, '.codex/hooks/knownex-stop.cjs')], {
            ...payload,
            hook_event_name: 'SessionEnd',
          });
          await writeFile(
            join(previous, 'memory/STATE.md'),
            '# Previous state\n\nOpen task. [E001](../.knownex/feed/' +
              previousHash +
              '.jsonl)\n',
          );
          await writeFile(
            join(previous, 'memory/knowledge/previous.md'),
            '---\nid: kn-00000000-0000-4000-8000-000000000002\ntype: knowledge\n---\n\n# Previous detail\n\nFact. [E001](../../.knownex/feed/' +
              previousHash +
              '.jsonl)\n',
          );
          const previousWork = join(previous, '.knownex/curator');
          oldNode([
            previousEntry,
            'curate',
            'init',
            '--work',
            previousWork,
            '--memory',
            join(previous, 'memory'),
            '--feed',
            join(previous, '.knownex/feed', previousHash + '.jsonl'),
            '--through',
            '1',
          ]);
          const previousDirective = join(previous, 'directive.md');
          await writeFile(previousDirective, 'Synthetic prior version test.');
          const previousRun = oldNode([
            previousEntry,
            'curate',
            'prepare',
            '--work',
            previousWork,
            '--directive',
            previousDirective,
          ]);
          await writeFile(previousRun.proposal, '{"action":"noop"}');
          const previousValidation = oldNode([
            previousEntry,
            'curate',
            'validate',
            '--work',
            previousWork,
          ]);
          oldNode([
            previousEntry,
            'curate',
            'apply',
            '--work',
            previousWork,
            '--confirm',
            previousValidation.seal,
          ]);
          const previousData = [
            'memory/STATE.md',
            'memory/HISTORY.md',
            'memory/knowledge/previous.md',
            '.knownex/feed/' + previousHash + '.jsonl',
            '.knownex/captures/' + previousHash + '.jsonl',
            '.knownex/curator/checkpoint.json',
            '.knownex/curator/apply.json',
            '.knownex/curator/memory/STATE.md',
            '.knownex/curator/memory/HISTORY.md',
            '.knownex/curator/memory/knowledge/previous.md',
          ];
          const previousSnapshot = await Promise.all(
            previousData.map(async (p) => ({
              p,
              bytes: await readFile(join(previous, p)),
              mtime: (await stat(join(previous, p), { bigint: true })).mtimeNs,
            })),
          );
          const previousAgents = await readFile(
            join(previous, 'AGENTS.md'),
            'utf8',
          );
          npm(
            [
              'install',
              '--offline',
              '--no-save',
              '--package-lock=false',
              '--ignore-scripts',
              '--no-audit',
              '--no-fund',
              archive,
            ],
            previous,
          );
          const oldUpgraded = oldNode([previousEntry, 'init']);
          assert.ok(oldUpgraded.updated.includes('.codex/hooks.json'));
          assert.deepEqual(oldUpgraded.warnings, ['LEGACY_SESSION_FEEDS']);
          assert.ok(
            (await readFile(join(previous, 'AGENTS.md'), 'utf8')).startsWith(
              previousAgents,
            ),
          );
          assert.equal(
            oldNode([previousEntry, 'runtime']).code,
            'LEGACY_SESSION_FEEDS',
          );
          for (const x of previousSnapshot) {
            assert.deepEqual(await readFile(join(previous, x.p)), x.bytes, x.p);
            assert.equal(
              (await stat(join(previous, x.p), { bigint: true })).mtimeNs,
              x.mtime,
              x.p,
            );
          }
          assert.deepEqual(oldNode([previousEntry, 'init']).updated, []);
          if (process.env.KNOWNEX_SMOKE_REPORT)
            await writeFile(
              process.env.KNOWNEX_SMOKE_REPORT,
              JSON.stringify(
                {
                  status: 'passed',
                  version: metadata.version,
                  archive,
                  workspace: project,
                  sourceAccessDenied: true,
                  hooks: true,
                  crossSessionPending: true,
                  boundedRecall: true,
                  manualHandoff: true,
                  failedCheckpoint: true,
                  singlePassHelper: true,
                  sameVersionReinstall: true,
                  ownedResourceUpgrade: true,
                  s3UpgradePreservesMemoryAndJournal: true,
                  legacyFeed: 'preserved and explicitly blocked, no migration',
                  llmCalls: 0,
                  realCodexSession: 'unmeasured',
                },
                null,
                2,
              ) + '\n',
            );
        },
      );
    }

    // Rename only owned entrypoints; refuse modified/unowned old skills before any writes.
    const oldSkill = '.agents/skills/knownex-handoff/SKILL.md';
    const oldBody =
      '---\nname: knownex-handoff\ndescription: Previous managed skill.\n---\n';
    const manifestPath = join(project, '.knownex/internal/install.json');
    const ownedManifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    ownedManifest.files[oldSkill] = createHash('sha256')
      .update(oldBody)
      .digest('hex');
    await mkdir(dirname(join(project, oldSkill)), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(ownedManifest, null, 2) + '\n',
    );
    await writeFile(join(project, oldSkill), oldBody + 'User modification\n');
    const agentsBeforeRename = await readFile(join(project, 'AGENTS.md'));
    const beforeConflict = await readFile(manifestPath);
    const modifiedOld = node([entry, 'init']);
    assert.equal(modifiedOld.status, 1);
    assert.equal(JSON.parse(modifiedOld.stderr).file, oldSkill);
    assert.deepEqual(await readFile(manifestPath), beforeConflict);
    assert.deepEqual(
      await readFile(join(project, 'AGENTS.md')),
      agentsBeforeRename,
    );
    await writeFile(join(project, oldSkill), oldBody);
    delete ownedManifest.files[oldSkill];
    await writeFile(
      manifestPath,
      JSON.stringify(ownedManifest, null, 2) + '\n',
    );
    assert.equal(JSON.parse(node([entry, 'init']).stderr).file, oldSkill);
    ownedManifest.files[oldSkill] = createHash('sha256')
      .update(oldBody)
      .digest('hex');
    await writeFile(
      manifestPath,
      JSON.stringify(ownedManifest, null, 2) + '\n',
    );
    const extra = join(project, '.agents/skills/knownex-handoff/personal.txt');
    await writeFile(extra, 'Preserve this user resource.');
    const renamed = cli(['init']);
    assert.deepEqual(renamed.removed, [oldSkill]);
    await assert.rejects(stat(join(project, oldSkill)), { code: 'ENOENT' });
    assert.equal(await readFile(extra, 'utf8'), 'Preserve this user resource.');
    assert.deepEqual(cli(['init']).removed, []);
    const ownConfig = agentConfig + '\n# User custom configuration\n';
    const configSnapshot = await readFile(join(project, 'AGENTS.md'));
    await writeFile(join(project, '.codex/config.toml'), ownConfig);
    const configConflict = node([entry, 'init']);
    assert.equal(configConflict.status, 1);
    assert.equal(JSON.parse(configConflict.stderr).file, '.codex/config.toml');
    assert.equal(
      await readFile(join(project, '.codex/config.toml'), 'utf8'),
      ownConfig,
    );
    assert.deepEqual(
      await readFile(join(project, 'AGENTS.md')),
      configSnapshot,
    );
    await writeFile(join(project, '.codex/config.toml'), agentConfig);
    const legacy = join(
      project,
      '.knownex/internal/feed',
      'a'.repeat(64) + '.jsonl',
    );
    await writeFile(legacy, 'legacy evidence must not be silently migrated');
    assert.equal(cli(['runtime']).code, 'LEGACY_SESSION_FEEDS');
    assert.match(
      hooks('SessionStart', {}).hookSpecificOutput.additionalContext,
      /LEGACY_SESSION_FEEDS/,
    );
    if (!archive) assert.deepEqual(await readFile(feed), combined);
    const stateBeforeConflict = await readFile(
      join(project, '.knownex/memory/STATE.md'),
      'utf8',
    );
    const custom = JSON.stringify({ ...config, userOwned: true }) + '\n';
    await writeFile(join(project, '.codex/hooks.json'), custom);
    const conflict = node([entry, 'init']);
    assert.equal(conflict.status, 1);
    assert.equal(JSON.parse(conflict.stderr).code, 'BOOTSTRAP_CONFLICT');
    assert.equal(JSON.parse(conflict.stderr).file, '.codex/hooks.json');
    assert.equal(
      await readFile(join(project, '.codex/hooks.json'), 'utf8'),
      custom,
    );
    assert.equal(
      await readFile(join(project, '.knownex/memory/STATE.md'), 'utf8'),
      stateBeforeConflict,
    );
    for (const args of [
      ['init', '--workspace', project, '--workspace', project],
      ['init', 'extra'],
    ])
      assert.equal(node([entry, ...args]).status, 2);
    t.diagnostic(
      archive
        ? 'Packed RC: offline install/reinstall, private ignores, hooks, A-to-B continuity, bounded pending, manual handoff, failed-batch withdrawal/fresh approval, single-pass helper, S3 resource upgrade and data/journal preservation passed. Runtime source access denied. Real Codex/model behavior unmeasured.'
        : 'Staged compiled payload (no installer generated), project hooks, A-to-B pending, repeated Stop, failed validation, sequence-zero init, update/recovery/replay, managed policy, navigator and idempotence passed with source access denied to runtime Node processes.',
    );
  },
);
