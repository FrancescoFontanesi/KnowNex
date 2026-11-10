import assert from 'node:assert/strict';
import {
  mkdtemp,
  readFile,
  writeFile,
  readdir,
  rm,
  stat,
  symlink,
  mkdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  initialize,
  start,
  collect,
  evaluate,
  report,
  compare,
} from '../harness.mjs';
import { unionMs, navigation } from '../metrics.mjs';
import { exampleInputs, trace } from '../example.mjs';

async function fixture(t, condition = 'demo') {
  const root = await mkdtemp(join(tmpdir(), 'knownex-harness-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const inputs = await exampleInputs(join(root, 'inputs'), condition);
  const experiment = join(root, 'experiment');
  await initialize(inputs.config, experiment);
  return {
    root,
    inputs,
    experiment,
    workspace: join(root, 'inputs/workspace'),
  };
}
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
async function completed(f) {
  const run = await start(f.experiment);
  await collect(f.experiment, run.id, f.inputs.capture);
  return run;
}

test('usage deduplicates responses and mirrors; cache and reasoning remain subsets, commands and clocks stay separate', async (t) => {
  const f = await fixture(t),
    before = await readFile(join(f.workspace, 'STATE.md')),
    mtime = (await stat(join(f.workspace, 'STATE.md'))).mtimeMs;
  const run = await completed(f),
    result = await report(f.experiment, run.id),
    m = result.metrics;
  assert.equal(m.tokens.input_tokens, 150);
  assert.equal(m.tokens.cached_input_tokens, 80);
  assert.equal(m.tokens.uncached_input_tokens, 70);
  assert.equal(m.tokens.output_tokens, 15);
  assert.equal(m.tokens.reasoning_output_tokens, 4);
  assert.equal(m.tokens.total_tokens, 165);
  assert.equal(m.tokens.modelResponses, 2);
  assert.equal(m.turns[0].duplicates, 1);
  assert.equal(m.byPhase.consultation.input_tokens, 150);
  assert.equal(m.byPhase.creation.input_tokens, null);
  assert.equal(m.byRole.curator.input_tokens, null);
  assert.equal(m.byOperation['targeted-recall'].input_tokens, 150);
  assert.equal(m.toolCalls, 2);
  assert.equal(m.recognizedNavigationCalls, 1);
  assert.equal(m.recognizedNavigationLatencyMs, 1000);
  assert.equal(m.activeTurnUnionMs, 4000);
  assert.equal(m.missing.humanWaitMs, null);
  assert.equal(m.missing.modelDeliveredBytes, null);
  assert.equal(m.missing.monetaryCost, null);
  assert.equal(m.tools[1].navigation, null);
  assert.equal(m.tools[1].modelDeliveredBytes, null);
  assert.deepEqual(
    await readFile(join(run.run, 'raw/001.jsonl')),
    await readFile(join(f.root, 'inputs/trace.jsonl')),
  );
  assert.deepEqual(await readFile(join(f.workspace, 'STATE.md')), before);
  assert.equal((await stat(join(f.workspace, 'STATE.md'))).mtimeMs, mtime);
  assert.equal(result.quality.categories.critical.strictAccuracy, null);
});

test('absent optional counters and interrupted usage remain null or partial, not zero or a complete run', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, 'inputs/trace.jsonl'),
    trace({ optional: false, completed: false }),
  );
  const run = await completed(f),
    r = await report(f.experiment, run.id);
  assert.equal(r.metrics.tokens.cached_input_tokens, null);
  assert.equal(r.metrics.tokens.uncached_input_tokens, null);
  assert.equal(r.metrics.tokens.reasoning_output_tokens, null);
  assert.equal(r.metrics.tokens.input_tokens, 150);
  assert.equal(r.metrics.tokens.coverage, 'partial');
  assert.equal(r.metrics.activeTurnUnionMs, null);
  assert.equal(r.comparable, false);
  assert.ok(r.exclusionReasons.includes('usage_incomplete'));
});

test('real formats with only cumulative mirrors do not manufacture per-response costs', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, 'inputs/trace.jsonl'),
    trace()
      .split('\n')
      .filter((l) => !l.includes('token_usage_record'))
      .join('\n'),
  );
  const run = await completed(f),
    r = await report(f.experiment, run.id);
  assert.equal(r.metrics.tokens.input_tokens, null);
  assert.equal(r.metrics.tokens.modelResponses, null);
  assert.equal(r.comparable, false);
});

test('scopes and native identities reject duplicate turns, wrong sessions and conflicting response usage', async (t) => {
  for (const scenario of ['duplicate', 'session', 'usage'])
    await t.test(scenario, async (t) => {
      const f = await fixture(t),
        capture = await json(f.inputs.capture);
      if (scenario === 'duplicate') capture.traces.push(capture.traces[0]);
      if (scenario === 'session') capture.traces[0].threadId = 'wrong-thread';
      if (scenario === 'usage') {
        const rows = trace().trim().split('\n').map(JSON.parse);
        rows[4].payload.usage.input_tokens = 101;
        rows[4].payload.usage.total_tokens = 111;
        await writeFile(
          join(f.root, 'inputs/trace.jsonl'),
          rows.map(JSON.stringify).join('\n') + '\n',
        );
      }
      await writeFile(f.inputs.capture, JSON.stringify(capture));
      const run = await start(f.experiment);
      await assert.rejects(collect(f.experiment, run.id, f.inputs.capture));
      const r = await report(f.experiment, run.id);
      assert.equal(r.comparable, false);
      assert.equal(r.declaredStatus, 'incomplete_evidence');
      assert.ok(
        (await readFile(join(run.run, 'REPORT.md'), 'utf8')).includes(
          'collection_failed',
        ),
      );
    });
});

test('qualitative reviews preserve per-fact evidence, separate failure locations, and never average away a critical omission', async (t) => {
  const f = await fixture(t),
    run = await completed(f),
    review = await json(f.inputs.review);
  const a = review.assessments;
  review.reviewer = { kind: 'human', id: 'human-review-fixture' };
  Object.assign(a[0], {
    memory: 'omitted',
    retrieval: 'omitted',
    use: 'omitted',
    verdict: 'omitted',
    searchCoverage:
      'All frozen STATE lines and the declared memory snapshot were inspected; synthetic condition only.',
  });
  Object.assign(a[1], {
    memory: 'correct',
    retrieval: 'omitted',
    use: 'partial',
    verdict: 'partial',
  });
  Object.assign(a[2], {
    memory: 'correct',
    retrieval: 'correct',
    use: 'incorrect',
    verdict: 'incorrect',
    errors: ['invented'],
  });
  await writeFile(f.inputs.review, JSON.stringify(review));
  await evaluate(f.experiment, run.id, f.inputs.review);
  let result = await report(f.experiment, run.id);
  assert.equal(result.quality.criticalGate, 'FAIL');
  assert.equal(result.quality.categories.critical.denominator, 1);
  assert.deepEqual(
    result.quality.facts.map((f) => f.assessment.localization),
    ['absent_memory', 'present_not_retrieved', 'retrieved_misused'],
  );
  assert.equal(result.quality.categories.ordinary.verdict.partial, 1);
  assert.equal(result.quality.categories.ordinary.strictAccuracy, 0);
  const first = await readFile(join(run.run, 'reviews/000001.json'));
  for (const item of a)
    Object.assign(item, {
      verdict: 'correct',
      memory: 'correct',
      retrieval: 'correct',
      use: 'correct',
      fidelity: 'correct',
      errors: [],
    });
  review.reviewer = {
    kind: 'llm_assisted',
    id: 'external-judge',
    model: 'declared-model',
  };
  await writeFile(f.inputs.review, JSON.stringify(review));
  await evaluate(f.experiment, run.id, f.inputs.review);
  result = await report(f.experiment, run.id);
  assert.equal(result.quality.criticalGate, 'PASS');
  assert.equal(result.quality.allCriticalJudgmentsHuman, false);
  assert.ok(
    result.quality.facts.every(
      (f) => f.assessment.localization === 'correctly_used',
    ),
  );
  assert.deepEqual(await readFile(join(run.run, 'reviews/000001.json')), first);
  assert.equal(
    (await json(join(run.run, 'reviews/000002.json'))).previous.length,
    64,
  );
  assert.equal(result.quality.semanticCompletenessProven, false);
});

test('invalid evidence, unsupported fact IDs and unsupported claims of absence are rejected', async (t) => {
  const f = await fixture(t),
    run = await completed(f),
    review = await json(f.inputs.review);
  const original = structuredClone(review);
  review.assessments[0].evidence[0].endLine = 999999;
  await writeFile(f.inputs.review, JSON.stringify(review));
  await assert.rejects(
    evaluate(f.experiment, run.id, f.inputs.review),
    /EVIDENCE_LINE_MISSING/,
  );
  const r = structuredClone(original);
  r.assessments[0].factId = 'unknown';
  await writeFile(f.inputs.review, JSON.stringify(r));
  await assert.rejects(
    evaluate(f.experiment, run.id, f.inputs.review),
    /ASSESSMENT_INVALID/,
  );
  const s = structuredClone(original);
  s.assessments[0].memory = 'omitted';
  await writeFile(f.inputs.review, JSON.stringify(s));
  await assert.rejects(
    evaluate(f.experiment, run.id, f.inputs.review),
    /ABSENCE_REQUIRES_SEARCH_COVERAGE/,
  );
  assert.deepEqual(await readdir(join(run.run, 'reviews')), []);
});

test('frozen ground truth and captured bytes cannot change silently; review revisions are hash checked', async (t) => {
  for (const what of ['reference', 'evidence', 'review'])
    await t.test(what, async (t) => {
      const f = await fixture(t),
        run = await completed(f);
      if (what === 'reference')
        await writeFile(join(f.experiment, 'reference/project.txt'), 'changed');
      if (what === 'evidence')
        await writeFile(join(run.run, 'raw/001.jsonl'), 'changed');
      if (what === 'review') {
        await evaluate(f.experiment, run.id, f.inputs.review);
        const p = join(run.run, 'reviews/000001.json'),
          r = await json(p);
        r.reviewer.id = 'changed';
        await writeFile(p, JSON.stringify(r));
      }
      await assert.rejects(report(f.experiment, run.id), /CHANGED/);
    });
});

test('comparisons keep failed, timeout, interrupted and policy-blocked runs but exclude them from eligible pairs', async (t) => {
  const f = await fixture(t),
    runs = [];
  for (const status of [
    'completed',
    'completed',
    'failed',
    'timeout',
    'interrupted',
    'policy_blocked',
  ]) {
    const capture = await json(f.inputs.capture);
    capture.status = status;
    await writeFile(f.inputs.capture, JSON.stringify(capture));
    const r = await completed(f);
    runs.push(r.run);
  }
  const one = join(f.root, 'compare-one'),
    two = join(f.root, 'compare-two');
  const comparison = await compare(runs, one);
  assert.equal(comparison.eligiblePairs, 1);
  const data = await json(join(one, 'comparison.json'));
  assert.equal(data.runs.length, 6);
  assert.equal(data.pairs[0].differenceBMinusA.input_tokens, 0);
  await compare(runs, two);
  assert.deepEqual(
    await readFile(join(one, 'comparison.json')),
    await readFile(join(two, 'comparison.json')),
  );
  await assert.rejects(
    compare([runs[0], runs[0]], join(f.root, 'duplicate')),
    /DUPLICATE_RUN/,
  );
  await assert.rejects(
    compare([runs[0]], join(f.workspace, 'bad-output')),
    /OUTPUT_OVERLAPS_WORKSPACE/,
  );
});

test('model mismatch excludes comparisons and changed controls cannot be pooled', async (t) => {
  const f = await fixture(t);
  await writeFile(
    join(f.root, 'inputs/trace.jsonl'),
    trace({ model: 'other-model' }),
  );
  const r = await completed(f),
    result = await report(f.experiment, r.id);
  assert.ok(result.exclusionReasons.includes('model_reasoning_unverified'));
  const g = await fixture(t);
  const cfg = await json(g.inputs.config);
  cfg.transport = 'different-transport';
  await writeFile(g.inputs.config, JSON.stringify(cfg));
  const different = join(g.root, 'different-experiment');
  await initialize(g.inputs.config, different);
  g.experiment = different;
  const other = await completed(g),
    output = join(f.root, 'compared');
  assert.equal((await compare([r.run, other.run], output)).eligiblePairs, 0);
  assert.match(
    (await json(join(output, 'comparison.json'))).pairs[0].reason,
    /different controls/,
  );
});

test('snapshot rejects unsafe paths and symlinks; CLI refuses writing an experiment in the observed workspace', async (t) => {
  const f = await fixture(t),
    cfg = await json(f.inputs.config);
  await assert.rejects(
    initialize(f.inputs.config, join(f.workspace, 'experiment')),
    /OUTPUT_OVERLAPS_WORKSPACE/,
  );
  cfg.snapshotPaths = ['../outside'];
  await writeFile(f.inputs.config, JSON.stringify(cfg));
  await assert.rejects(
    initialize(f.inputs.config, join(f.root, 'escape')),
    /SNAPSHOT_PATHS_INVALID/,
  );
  try {
    await symlink(
      join(f.root, 'inputs/source.txt'),
      join(f.workspace, 'link.txt'),
    );
  } catch (e) {
    if (['EPERM', 'EACCES'].includes(e.code)) {
      t.diagnostic('File symlink unsupported by this OS account');
      return;
    }
    throw e;
  }
  cfg.snapshotPaths = ['link.txt'];
  cfg.controlPaths = [];
  await writeFile(f.inputs.config, JSON.stringify(cfg));
  const exp = join(f.root, 'unsafe');
  await initialize(f.inputs.config, exp);
  await assert.rejects(start(exp), /UNSAFE_SOURCE/);
});

test('intervals union overlapping observations and direct command recognition never executes or guesses orchestration', () => {
  assert.equal(
    unionMs([
      ['2026-01-01T00:00:00Z', '2026-01-01T00:00:03Z'],
      ['2026-01-01T00:00:02Z', '2026-01-01T00:00:04Z'],
    ]),
    4000,
  );
  assert.equal(unionMs([]), null);
  assert.throws(() => unionMs([['bad', 'bad']]), /INVALID_INTERVAL/);
  assert.equal(navigation('echo knownex memory state'), null);
  assert.equal(navigation('knownex memory state; something'), null);
  assert.equal(
    navigation('npm exec --offline -- knownex memory read H000001').document,
    'HISTORY',
  );
});

test('CLI reports usage and frozen results deterministically without invoking Codex', async (t) => {
  const f = await fixture(t),
    run = await completed(f);
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL('../cli.mjs', import.meta.url)),
      'report',
      '--experiment',
      f.experiment,
      '--run',
      run.id,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).id, run.id);
  const archived = spawnSync(
    process.execPath,
    [
      join(f.experiment, 'reference/implementation/evaluation/cli.mjs'),
      'report',
      '--experiment',
      f.experiment,
      '--run',
      run.id,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(archived.status, 0, archived.stderr);
  assert.equal(JSON.parse(archived.stdout).id, run.id);
  const unknown = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('../cli.mjs', import.meta.url)), 'launch-model'],
    { encoding: 'utf8' },
  );
  assert.notEqual(unknown.status, 0);
});

test('observer intervals are evidence-linked and kept distinct from automatic execution time', async (t) => {
  const f = await fixture(t),
    capture = await json(f.inputs.capture);
  capture.intervals = [
    {
      kind: 'human_wait',
      start: '2026-01-01T00:00:01Z',
      end: '2026-01-01T00:00:02Z',
      explanation:
        'Synthetic observer interval, not inferred from model silence.',
      evidence: [{ file: 'raw/001.jsonl', startLine: 2, endLine: 2 }],
    },
    {
      kind: 'human_wait',
      start: '2026-01-01T00:00:01.500Z',
      end: '2026-01-01T00:00:03Z',
      explanation: 'Overlapping synthetic observer annotation.',
      evidence: [{ file: 'raw/001.jsonl', startLine: 2, endLine: 2 }],
    },
  ];
  await writeFile(f.inputs.capture, JSON.stringify(capture));
  const run = await completed(f),
    r = await report(f.experiment, run.id);
  assert.equal(r.annotatedTimingMs.human_wait, 2000);
  assert.equal(r.annotatedTimingMs.cold_start, null);
  assert.equal(r.metrics.missing.automaticMs, null);
  assert.equal(r.metrics.missing.humanWaitMs, null);
  assert.equal(r.metrics.bySession['synthetic-thread'].input_tokens, 150);
  assert.equal(r.metrics.byPhaseWallMs.consultation, 4000);
});

test('no traces mean unavailable interactions; partial trailing bytes and wrong installed versions cannot pass comparison gates', async (t) => {
  for (const mode of ['empty', 'tail', 'version'])
    await t.test(mode, async (t) => {
      const f = await fixture(t),
        capture = await json(f.inputs.capture);
      if (mode === 'empty') capture.traces = [];
      if (mode === 'tail')
        await writeFile(
          join(f.root, 'inputs/trace.jsonl'),
          trace() + '{"unfinished":',
        );
      if (mode === 'version') {
        const config = await json(f.inputs.config);
        config.knownexVersion = '0.1.0-rc.10';
        await writeFile(f.inputs.config, JSON.stringify(config));
        f.experiment = join(f.root, 'versioned-experiment');
        await initialize(f.inputs.config, f.experiment);
      }
      await writeFile(f.inputs.capture, JSON.stringify(capture));
      const run = await completed(f),
        r = await report(f.experiment, run.id);
      assert.equal(r.comparable, false);
      if (mode === 'empty') {
        assert.equal(r.metrics.toolCalls, null);
        assert.equal(r.metrics.recognizedNavigationCalls, null);
      }
      if (mode === 'tail') assert.equal(r.metrics.tokens.coverage, 'partial');
      if (mode === 'version')
        assert.ok(r.exclusionReasons.includes('version_mismatch'));
    });
});

test('missing native clocks and output content remain unavailable without discarding valid usage', async (t) => {
  const f = await fixture(t),
    rows = trace().trim().split('\n').map(JSON.parse);
  for (const row of rows) {
    delete row.timestamp;
    if (row.payload?.type?.endsWith('call_output')) delete row.payload.output;
  }
  await writeFile(
    join(f.root, 'inputs/trace.jsonl'),
    rows.map(JSON.stringify).join('\n') + '\n',
  );
  const run = await completed(f),
    r = await report(f.experiment, run.id);
  assert.equal(r.metrics.tokens.input_tokens, 150);
  assert.equal(r.metrics.activeTurnUnionMs, null);
  assert.equal(r.metrics.serializedToolOutputBytes, null);
  assert.ok(r.metrics.tools.every((t) => t.latencyMs === null));
});

test('instruction changes during a run or between runs invalidate the corresponding comparison', async (t) => {
  const f = await fixture(t),
    first = await start(f.experiment);
  await writeFile(join(f.workspace, 'AGENTS.md'), 'Different instructions.');
  await collect(f.experiment, first.id, f.inputs.capture);
  assert.ok(
    (await report(f.experiment, first.id)).exclusionReasons.includes(
      'instructions_changed_during_run',
    ),
  );
  const second = await completed(f);
  await writeFile(
    join(f.workspace, 'AGENTS.md'),
    'Yet another instruction set.',
  );
  const third = await completed(f),
    output = join(f.root, 'controls-comparison');
  assert.equal(
    (await compare([second.run, third.run], output)).eligiblePairs,
    0,
  );
});

test('the same native session cannot masquerade as independent real runs', async (t) => {
  const f = await fixture(t),
    config = await json(f.inputs.config);
  config.synthetic = false;
  await writeFile(f.inputs.config, JSON.stringify(config));
  f.experiment = join(f.root, 'non-synthetic-protocol');
  await initialize(f.inputs.config, f.experiment);
  const one = await completed(f),
    two = await completed(f),
    output = join(f.root, 'not-independent');
  await assert.rejects(
    evaluate(f.experiment, one.id, f.inputs.review),
    /REVIEW_INVALID/,
  );
  assert.equal((await compare([one.run, two.run], output)).eligiblePairs, 0);
  assert.match(
    (await json(join(output, 'comparison.json'))).pairs[0].reason,
    /shared native session/,
  );
});

test('frozen per-role model expectations accept heterogeneous principal and curator without relaxing identity or model checks', async (t) => {
  const f = await fixture(t),
    config = await json(f.inputs.config);
  config.roleModels = {
    principal: { model: 'synthetic-model', reasoning: 'medium' },
    curator: { model: 'synthetic-curator', reasoning: 'medium' },
  };
  await writeFile(f.inputs.config, JSON.stringify(config));
  f.experiment = join(f.root, 'role-aware');
  await initialize(f.inputs.config, f.experiment);
  const child = trace({ model: 'synthetic-curator' }).replaceAll(
    'synthetic-thread',
    'curator-thread',
  );
  await writeFile(join(f.root, 'inputs/curator.jsonl'), child);
  const capture = await json(f.inputs.capture);
  capture.traces.push({
    path: 'curator.jsonl',
    threadId: 'curator-thread',
    role: 'curator',
    turns: [
      { id: 'turn-1', phase: 'creation', operation: 'single-pass-curation' },
    ],
  });
  await writeFile(f.inputs.capture, JSON.stringify(capture));
  const run = await completed(f),
    r = await report(f.experiment, run.id);
  assert.equal(r.comparable, true);
  assert.equal(r.metrics.byRole.principal.input_tokens, 150);
  assert.equal(r.metrics.byRole.curator.input_tokens, 150);
  assert.equal(r.metrics.tokens.input_tokens, 300);
  await writeFile(
    join(f.root, 'inputs/curator.jsonl'),
    child.replaceAll('synthetic-curator', 'wrong-curator'),
  );
  const wrong = await completed(f);
  assert.ok(
    (await report(f.experiment, wrong.id)).exclusionReasons.includes(
      'model_reasoning_unverified',
    ),
  );
});
