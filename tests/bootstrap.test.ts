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
import { policy } from '../src/cli/bootstrap.ts';

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
    await assert.rejects(stat(join(project, 'memory')), { code: 'ENOENT' });
    const agents = await readFile(join(project, 'AGENTS.md'), 'utf8');
    assert.ok(agents.startsWith(personal));
    // The installed block is the package's policy, not this repository's own AGENTS.md.
    assert.equal(
      agents.match(/<!-- knownex:start -->[\s\S]*?<!-- knownex:end -->/)?.[0],
      policy.trimEnd(),
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
    assert.match(initialized.nextSteps.join(' '), /explicitly trust this path/);
    assert.match(initialized.nextSteps.join(' '), /explicitly approve/);
    assert.match(initialized.nextSteps.join(' '), /SessionStart/);
    assert.ok(initialized.created.includes('.codex/hooks.json'));
    assert.match(agents, /knownex checkpoint --codex/);
    assert.match(agents, /subagent/);
    assert.match(agents, /knownex-recall/);
    assert.doesNotMatch(
      agents,
      /knownex_recaller|knownex_curator|curate native|\$knownex-checkpoint/,
    );
    // A note linked from STATE costs one read: no delegation for it.
    assert.match(
      agents,
      /note already linked from STATE directly with `npm exec --offline -- knownex memory read`/,
    );
    assert.match(agents, /After a compact STATE is not emitted again/);
    const recallSkill = await readFile(
      join(project, '.agents/skills/knownex-recall/SKILL.md'),
      'utf8',
    );
    assert.doesNotMatch(recallSkill, /knownex_recaller/);
    assert.match(recallSkill, /No automatic fallback/);
    assert.match(
      recallSkill,
      /main session's delegation instructions do not apply/,
    );
    // The installed launcher runs directly; with nothing to curate it starts no session.
    const launched = node([entry, 'checkpoint', '--codex']);
    assert.equal(launched.status, 0, launched.stderr + launched.stdout);
    assert.equal(JSON.parse(launched.stdout).action, 'noop');
    await assert.rejects(
      stat(join(project, '.agents/skills/knownex-handoff/SKILL.md')),
      { code: 'ENOENT' },
    );
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
    ]);
    assert.doesNotMatch(configText, /knownex-stop/);
    await assert.rejects(stat(join(project, '.knownex/internal/captures')), {
      code: 'ENOENT',
    });
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
    await stat(join(project, '.knownex/internal/docs/RUNTIME.md'));
    // Links to docs no longer copied resolve into the installed package.
    for (const name of ['RUNTIME.md', 'TAXONOMY.md']) {
      const directory = join(project, '.knownex/internal/docs');
      const text = await readFile(join(directory, name), 'utf8');
      for (const m of text.matchAll(/\]\(([^)#:]+\.md)/g))
        await stat(resolve(directory, m[1]!));
    }
    assert.deepEqual(
      paths.filter((p) => p.startsWith('.knownex/internal/docs/')).sort(),
      [
        '.knownex/internal/docs/RUNTIME.md',
        '.knownex/internal/docs/TAXONOMY.md',
      ],
    );
    assert.match(cli(['memory', 'state']).content, /Nothing materialized/);
    let session = 'synthetic-install-session';
    const transcript = join(project, 'synthetic.jsonl');
    await writeFile(
      transcript,
      JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n',
    );
    function hooks(event: string, fields: Record<string, unknown>) {
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
    assert.match(start.additionalContext, /0 pending project events/);
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
    await assert.rejects(stat(join(project, '.knownex/internal/captures')), {
      code: 'ENOENT',
    });
    hooks('UserPromptSubmit', {
      prompt: 'Synthetic bootstrap \u00e8 \ud83e\udde0',
    });
    assert.deepEqual(await readFile(feed), feedBytes);
    session = 'synthetic-session-B';
    const next = hooks('SessionStart', {}).hookSpecificOutput.additionalContext;
    assert.match(next, /2 pending project events/);
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
    await stat(join(prep.run, 'SKILL.md'));
    await stat(join(prep.run, 'WINDOW.md'));
    await assert.rejects(stat(join(prep.run, 'MEMORY-CONTRACT.md')), {
      code: 'ENOENT',
    });
    await writeFile(prep.proposal, '{"action":"invalid"}\n');
    assert.equal(node([entry, 'curate', 'validate', '--work', work]).status, 1);
    assert.equal(cli(['runtime']).pending, 4);
    assert.equal(cli(['runtime']).through, 0);
    assert.equal(cli(['runtime']).activeRun, prep.run);
    assert.match(
      hooks('SessionStart', {}).hookSpecificOutput.additionalContext,
      /Batch already active/,
    );
    // Test fixture repairs JSON deterministically; no LLM retry is performed.
    await writeFile(
      prep.proposal,
      JSON.stringify({
        action: 'update',
        state: '# Synthetic A+B state\n\nA+B result. [E001..E004]\n',
        history: {
          summary: 'A+B',
          topics: ['Synthetic'],
          transition: 'Consolidate A+B synthetic result',
        },
        knowledge: {
          'knowledge/bootstrap.md':
            '---\nid: kn-00000000-0000-4000-8000-000000000001\ntype: knowledge\n---\n\n# Synthetic bootstrap\n\nReusable fixture detail. [E004]\n',
        },
      }),
    );
    const writtenProposal = await readFile(prep.proposal);
    await writeFile(
      join(prep.run, 'review.json'),
      JSON.stringify({
        version: 4,
        proposalSha256: createHash('sha256')
          .update(writtenProposal)
          .digest('hex'),
        summary: 'Fixture review, not a semantic-model evaluation',
        sources: [1, 4],
        ignored: [2, 3],
        changes: [
          { path: 'STATE.md', summary: 'Initial state', sources: [1, 4] },
          {
            path: 'knowledge/bootstrap.md',
            summary: 'Initial detail',
            sources: [4],
          },
        ],
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
      initialCheckpoint.knowledgeVersions.heads[
        'knowledge/H000001/bootstrap.md'
      ].file;
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
    const resumed = hooks('SessionStart', { source: 'resume' })
      .hookSpecificOutput.additionalContext;
    assert.match(resumed, /Synthetic A\+B state/);
    assert.match(resumed, /0 pending project events/);
    // With nothing new after the checkpoint, prepare is a noop and the feed is untouched.
    const checkpointBeforeReport = await readFile(
      join(work, 'checkpoint.json'),
    );
    const authorityBeforeReport = await readFile(feed + '.curator.json');
    const feedBeforeReport = await readFile(feed);
    assert.equal(cli(['curate', 'prepare', '--work', work]).status, 'noop');
    assert.deepEqual(await readFile(feed), feedBeforeReport);
    // E: a new SessionStart reports pending without treating it as progress or
    // mutating the checkpoint/authorization. This checks context, not model semantics.
    const cold = hooks('SessionStart', {
      session_id: 'new-cold-session',
      source: 'startup',
    }).hookSpecificOutput.additionalContext;
    assert.match(cold, /0 pending project events/);
    assert.match(cold, /pending does not prove substantial progress/);
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
    assert.match(unsafe, /not verified/);
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
    const second = cli(['curate', 'prepare', '--work', work]);
    const secondPacket = JSON.parse(
      await readFile(join(second.run, 'packet.json'), 'utf8'),
    );
    assert.deepEqual(
      secondPacket.events.map((e: { sequence: number }) => e.sequence),
      [5, 6],
    );
    assert.deepEqual(secondPacket.orderingIssues, []);
    assert.ok(
      secondPacket.events.some(
        (e: { text: string }) => e.text === technicalPrompt,
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
      '.gitignore',
      '.knownex/internal/feed/project.jsonl',
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
    }

    // Claude Code: the same package hooks through .claude wrappers, merged settings and CLAUDE.md.
    const ownSettings = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }],
        // An earlier release also registered the capture hook on SessionEnd.
        SessionEnd: [
          { hooks: [{ type: 'command', command: 'echo end' }] },
          {
            hooks: [
              {
                type: 'command',
                command:
                  'node "$CLAUDE_PROJECT_DIR/.claude/hooks/knownex-stop.cjs"',
              },
            ],
          },
        ],
      },
    };
    await mkdir(join(project, '.claude'), { recursive: true });
    await writeFile(
      join(project, '.claude/settings.json'),
      JSON.stringify(ownSettings),
    );
    await writeFile(join(project, 'CLAUDE.md'), '# Mie istruzioni\n');
    const withClaude = cli(['init', '--provider', 'codex,claude']);
    for (const name of ['feed', 'session'])
      assert.ok(
        withClaude.created.includes(`.claude/hooks/knownex-${name}.cjs`),
        name,
      );
    assert.ok(!withClaude.created.includes('.claude/hooks/knownex-stop.cjs'));
    assert.ok(withClaude.updated.includes('.claude/settings.json'));
    const settings = JSON.parse(
      await readFile(join(project, '.claude/settings.json'), 'utf8'),
    );
    assert.deepEqual(settings.permissions, ownSettings.permissions);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'echo mine');
    assert.deepEqual(settings.hooks.SessionEnd, [
      ownSettings.hooks.SessionEnd[0],
    ]);
    assert.doesNotMatch(JSON.stringify(settings), /knownex-stop/);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop'])
      assert.match(
        JSON.stringify(settings.hooks[event]),
        /\$CLAUDE_PROJECT_DIR\/\.claude\/hooks\/knownex-/,
        event,
      );
    const claudeMd = await readFile(join(project, 'CLAUDE.md'), 'utf8');
    assert.ok(claudeMd.startsWith('# Mie istruzioni\n'));
    assert.match(claudeMd, /knownex checkpoint --codex/);
    assert.match(
      await readFile(join(project, '.claude/hooks/knownex-feed.cjs'), 'utf8'),
      /KNOWNEX_PROVIDER = 'claude'/,
    );
    assert.match(
      await readFile(join(project, '.gitignore'), 'utf8'),
      /\.claude\/hooks\/feed-events\.jsonl/,
    );
    // Without --provider, init keeps both installed providers and changes nothing.
    const kept = cli(['init']);
    assert.deepEqual([kept.created, kept.updated], [[], []]);
    // A Claude turn through the installed wrapper lands in the shared project feed.
    const claudeTurn = node([join(project, '.claude/hooks/knownex-feed.cjs')], {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'claude-session',
      prompt_id: 'prompt-1',
      prompt: 'Messaggio da Claude',
      transcript_path: join(project, 'claude-transcript.jsonl'),
      cwd: project,
    });
    assert.equal(claudeTurn.status, 0, claudeTurn.stderr);
    assert.equal(claudeTurn.stdout.trim(), '{}');
    const lastEvent = JSON.parse(
      (await readFile(feed, 'utf8')).trim().split('\n').at(-1)!,
    ).block.event;
    assert.equal(lastEvent.provider, 'claude');
    assert.equal(lastEvent.turnId, 'prompt-1');
    assert.equal(lastEvent.text, 'Messaggio da Claude');
    combined = await readFile(feed);
    // Unparseable Claude settings stop init before anything changes.
    await writeFile(join(project, '.claude/settings.json'), '{ not json');
    const badSettings = node([entry, 'init']);
    assert.equal(badSettings.status, 1);
    assert.equal(
      JSON.parse(badSettings.stderr).code,
      'BOOTSTRAP_CLAUDE_SETTINGS_INVALID',
    );
    await writeFile(
      join(project, '.claude/settings.json'),
      JSON.stringify(settings, null, 2) + '\n',
    );
    assert.deepEqual(cli(['init']).updated, []);
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
        ? 'Packed RC: offline install/reinstall, private ignores, hooks, A-to-B continuity, bounded pending, manual handoff, failed-batch withdrawal/fresh approval and single-pass helper passed. Runtime source access denied. Real Codex/model behavior unmeasured.'
        : 'Staged compiled payload (no installer generated), project hooks, A-to-B pending, repeated Stop, failed validation, sequence-zero init, update/recovery/replay, managed policy, navigator and idempotence passed with source access denied to runtime Node processes.',
    );
  },
);
