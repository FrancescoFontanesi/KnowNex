import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate, nativeMetrics, statuses, unionMs } from './metrics.mjs';

const hash = (b) => createHash('sha256').update(b).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const slug = (v) =>
  typeof v === 'string' &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(v) &&
  v !== '.' &&
  v !== '..';
const json = async (file) =>
  JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file)),
  );
const put = async (file, value) =>
  writeFile(
    file,
    typeof value === 'string' || Buffer.isBuffer(value)
      ? value
      : JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
const under = (root, path) => {
  const r = relative(root, path);
  return (
    r === '' || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r))
  );
};
const safeName = (name) =>
  typeof name === 'string' &&
  name !== '' &&
  !isAbsolute(name) &&
  !name.includes('\\') &&
  name.split('/').every((p) => p && p !== '.' && p !== '..');
const stamp = () => new Date().toISOString();
const outputPath = async (path) =>
  join(await realpath(dirname(resolve(path))), basename(resolve(path)));
const defaultPaths = [
  '.knownex/seed',
  '.knownex/curator',
  '.knownex/feed',
  '.knownex/install.json',
  '.codex',
  '.agents/skills',
  'AGENTS.md',
  'node_modules/knownex/package.json',
  'node_modules/knownex/dist',
  'node_modules/knownex/.codex',
  'node_modules/knownex/.agents',
];
const instrumentFiles = [
  'harness.mjs',
  'metrics.mjs',
  'cli.mjs',
  '../scripts/measure.ts',
];
const here = dirname(fileURLToPath(import.meta.url));

async function instrumentation() {
  return Object.fromEntries(
    await Promise.all(
      instrumentFiles.map(async (f) => [
        f,
        hash(await readFile(join(here, f))),
      ]),
    ),
  );
}
async function rawFile(path) {
  if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink())
    fail('UNSAFE_SOURCE');
  const canonical = await realpath(path),
    bytes = await readFile(canonical);
  if (
    (await realpath(path)) !== canonical ||
    (await lstat(path)).isSymbolicLink()
  )
    fail('SOURCE_CHANGED');
  return bytes;
}
async function tree(root, names) {
  const files = {};
  async function visit(name) {
    if (!safeName(name)) fail('UNSAFE_SNAPSHOT_PATH');
    const file = join(root, name);
    let info;
    try {
      info = await lstat(file);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    if (info.isSymbolicLink() || !under(root, await realpath(file)))
      fail('UNSAFE_SOURCE');
    if (info.isDirectory())
      for (const child of (await readdir(file)).sort())
        await visit(name + '/' + child);
    else if (info.isFile())
      files[name] = {
        bytes: info.size,
        mtimeMs: info.mtimeMs,
        sha256: hash(await rawFile(file)),
      };
    else fail('UNSUPPORTED_SOURCE');
  }
  for (const name of names) {
    if (!safeName(name)) fail('UNSAFE_SNAPSHOT_PATH');
    // Check ancestors too: a junction may resolve back inside the root.
    let p = root;
    for (const component of name.split('/')) {
      p = join(p, component);
      try {
        if ((await lstat(p)).isSymbolicLink()) fail('UNSAFE_SOURCE');
      } catch (e) {
        if (e.code === 'ENOENT') break;
        throw e;
      }
    }
    await visit(name);
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b, 'en')),
  );
}
async function snapshot(workspace, target, paths) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  const before = await tree(workspace, paths);
  for (const [name, entry] of Object.entries(before)) {
    const bytes = await rawFile(join(workspace, name));
    if (hash(bytes) !== entry.sha256) fail('SNAPSHOT_CHANGED_DURING_COPY');
    await mkdir(dirname(join(target, name)), { recursive: true, mode: 0o700 });
    await put(join(target, name), bytes);
  }
  const after = await tree(workspace, paths);
  return {
    files: before,
    stable: JSON.stringify(before) === JSON.stringify(after),
    atomic: false,
    method: 'two inventories around copy; no workspace locks acquired',
  };
}
async function checkEvidence(root, ref) {
  root = await realpath(root);
  if (
    !object(ref) ||
    !safeName(ref.file) ||
    !Number.isSafeInteger(ref.startLine) ||
    !Number.isSafeInteger(ref.endLine) ||
    ref.startLine < 1 ||
    ref.endLine < ref.startLine
  )
    fail('EVIDENCE_REFERENCE_INVALID');
  if (!under(root, await realpath(join(root, ref.file))))
    fail('EVIDENCE_REFERENCE_INVALID');
  const bytes = await rawFile(join(root, ref.file));
  const lines = new TextDecoder('utf-8', { fatal: true })
    .decode(bytes)
    .split('\n');
  if (ref.endLine > lines.length) fail('EVIDENCE_LINE_MISSING');
  return { ...ref, sha256: hash(bytes) };
}
function oracleCheck(oracle) {
  if (
    oracle?.version !== 1 ||
    !slug(oracle.id) ||
    !Array.isArray(oracle.facts) ||
    !oracle.facts.length
  )
    fail('ORACLE_INVALID');
  const ids = new Set();
  for (const f of oracle.facts) {
    if (
      !slug(f.id) ||
      ids.has(f.id) ||
      !['critical', 'ordinary', 'unavailable'].includes(f.priority) ||
      ['description', 'expected', 'criterion', 'temporalScope'].some(
        (k) => typeof f[k] !== 'string' || !f[k].trim(),
      ) ||
      !Array.isArray(f.qualifications) ||
      f.qualifications.some((q) => typeof q !== 'string') ||
      !Array.isArray(f.sources)
    )
      fail('FACT_INVALID');
    ids.add(f.id);
  }
  for (const f of oracle.facts)
    for (const r of f.supersedes ?? [])
      if (!ids.has(r) || r === f.id) fail('FACT_RELATION_INVALID');
}
async function frozen(experiment) {
  experiment = await realpath(experiment);
  const protocol = await json(join(experiment, 'protocol.json'));
  if (
    hash(await readFile(join(experiment, 'protocol.json'))) !==
    (await readFile(join(experiment, 'protocol.sha256'), 'utf8')).trim()
  )
    fail('PROTOCOL_CHANGED');
  if (
    JSON.stringify(await instrumentation()) !==
    JSON.stringify(protocol.instrumentation)
  )
    fail('HARNESS_CHANGED_CREATE_NEW_EXPERIMENT');
  for (const [name, sha] of Object.entries(protocol.frozenFiles))
    if (hash(await rawFile(join(experiment, name))) !== sha)
      fail('FROZEN_REFERENCE_CHANGED');
  return { experiment, protocol };
}
export async function initialize(configFile, output) {
  const source = await realpath(configFile),
    base = dirname(source),
    config = await json(source);
  if (
    config.version !== 1 ||
    [
      'scenario',
      'condition',
      'workload',
      'comparisonGroup',
      'instructionPolicy',
      'transport',
      'model',
      'reasoning',
    ].some((k) => typeof config[k] !== 'string' || !config[k].trim()) ||
    !Array.isArray(config.sources) ||
    !config.groundTruth ||
    !config.workspace
  )
    fail('CONFIG_INVALID');
  if (
    config.roleModels !== undefined &&
    (!object(config.roleModels) ||
      Object.entries(config.roleModels).some(
        ([role, expected]) =>
          !['principal', 'curator', 'other'].includes(role) ||
          !object(expected) ||
          ['model', 'reasoning'].some(
            (key) => typeof expected[key] !== 'string' || !expected[key].trim(),
          ),
      ))
  )
    fail('ROLE_MODELS_INVALID');
  const workspace = await realpath(resolve(base, config.workspace)),
    experiment = await outputPath(output);
  const parent = await realpath(dirname(experiment));
  if (
    under(
      workspace,
      resolve(parent, relative(dirname(experiment), experiment)),
    ) ||
    under(experiment, workspace)
  )
    fail('OUTPUT_OVERLAPS_WORKSPACE');
  const paths = config.snapshotPaths ?? defaultPaths;
  if (!Array.isArray(paths) || !paths.length || paths.some((p) => !safeName(p)))
    fail('SNAPSHOT_PATHS_INVALID');
  const controlPaths = config.controlPaths ?? ['AGENTS.md'];
  if (
    !Array.isArray(controlPaths) ||
    controlPaths.some(
      (p) =>
        !safeName(p) ||
        !paths.some((root) => p === root || p.startsWith(root + '/')),
    )
  )
    fail('CONTROL_PATH_NOT_CAPTURED');
  const oracle = await json(resolve(base, config.groundTruth));
  oracleCheck(oracle);
  if (
    new Set(config.sources.map((s) => s.id)).size !== config.sources.length ||
    config.sources.some((s) => !slug(s.id) || typeof s.path !== 'string')
  )
    fail('SOURCE_IDS_INVALID');
  await mkdir(experiment, { mode: 0o700 });
  const frozenFiles = {};
  await mkdir(join(experiment, 'reference'), { mode: 0o700 });
  for (const s of config.sources) {
    const name = 'reference/' + s.id + '.txt';
    const bytes = await rawFile(resolve(base, s.path));
    await put(join(experiment, name), bytes);
    frozenFiles[name] = hash(bytes);
  }
  for (const fact of oracle.facts)
    for (const ref of fact.sources) {
      if (!config.sources.some((s) => s.id === ref.source))
        fail('FACT_SOURCE_UNKNOWN');
      await checkEvidence(experiment, {
        file: 'reference/' + ref.source + '.txt',
        startLine: ref.startLine,
        endLine: ref.endLine,
      });
    }
  await put(join(experiment, 'reference/oracle.json'), oracle);
  frozenFiles['reference/oracle.json'] = hash(
    await readFile(join(experiment, 'reference/oracle.json')),
  );
  await put(
    join(experiment, 'reference/config.original.json'),
    await readFile(source),
  );
  frozenFiles['reference/config.original.json'] = hash(await readFile(source));
  await mkdir(join(experiment, 'reference/implementation/evaluation'), {
    recursive: true,
    mode: 0o700,
  });
  await mkdir(join(experiment, 'reference/implementation/scripts'), {
    mode: 0o700,
  });
  for (const file of instrumentFiles) {
    const name = file.startsWith('../')
      ? 'reference/implementation/' + file.slice(3)
      : 'reference/implementation/evaluation/' + file;
    const bytes = await rawFile(join(here, file));
    await put(join(experiment, name), bytes);
    frozenFiles[name] = hash(bytes);
  }
  const protocol = {
    version: 1,
    createdAt: stamp(),
    config: { ...config, workspace, snapshotPaths: paths, controlPaths },
    oracleSha256: frozenFiles['reference/oracle.json'],
    frozenFiles,
    instrumentation: await instrumentation(),
    environment: { node: process.version, platform: process.platform },
    sensitiveData:
      'private local evidence; not automatically redacted or encrypted',
  };
  await put(join(experiment, 'protocol.json'), protocol);
  await put(
    join(experiment, 'protocol.sha256'),
    hash(await readFile(join(experiment, 'protocol.json'))) + '\n',
  );
  await mkdir(join(experiment, 'runs'), { mode: 0o700 });
  return { experiment, oracleSha256: protocol.oracleSha256 };
}
async function installation(workspace) {
  try {
    return await json(join(workspace, 'node_modules/knownex/package.json'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function event(run, kind, details) {
  await put(join(run, 'event-' + randomUUID() + '.json'), {
    at: stamp(),
    kind,
    ...details,
  });
}
export async function start(experiment) {
  const f = await frozen(experiment),
    c = f.protocol.config,
    id = randomUUID(),
    run = join(f.experiment, 'runs', id);
  await mkdir(run, { mode: 0o700 });
  const metadata = {
    version: 1,
    id,
    startedAt: stamp(),
    protocolSha256: hash(await readFile(join(f.experiment, 'protocol.json'))),
    environment: { node: process.version, platform: process.platform },
    status: 'observing',
  };
  await put(join(run, 'run.json'), metadata);
  try {
    const installed = await installation(c.workspace);
    const before = await snapshot(
      c.workspace,
      join(run, 'before'),
      c.snapshotPaths,
    );
    const versionMatch =
      c.knownexVersion === null
        ? true
        : installed?.version === (c.knownexVersion ?? '0.1.0-rc.10');
    await put(join(run, 'initial.json'), {
      before,
      installed: installed
        ? { name: installed.name, version: installed.version }
        : null,
      versionMatch,
    });
    await mkdir(join(run, 'reviews'), { mode: 0o700 });
    return { id, run, stable: before.stable, versionMatch };
  } catch (e) {
    await event(run, 'start_failed', { code: e.message });
    await put(join(run, 'failure.json'), { stage: 'start', code: e.message });
    await mkdir(join(run, 'reviews'), { recursive: true, mode: 0o700 });
    await sealEvidence(run);
    await report(experiment, id);
    throw e;
  }
}
async function atRun(experiment, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) fail('RUN_ID_INVALID');
  const f = await frozen(experiment),
    run = join(f.experiment, 'runs', id),
    meta = await json(join(run, 'run.json'));
  if (
    meta.id !== id ||
    meta.protocolSha256 !==
      hash(await readFile(join(f.experiment, 'protocol.json')))
  )
    fail('RUN_PROTOCOL_MISMATCH');
  return { ...f, run, meta };
}
export async function collect(experiment, id, captureFile) {
  const f = await atRun(experiment, id),
    capture = await json(captureFile),
    base = dirname(resolve(captureFile));
  if (!statuses.includes(capture.status) || !Array.isArray(capture.traces))
    fail('CAPTURE_INVALID');
  const raw = join(f.run, 'raw');
  await mkdir(raw, { mode: 0o700 }); // one collection attempt; never overwrite
  try {
    await put(join(raw, 'capture.json'), await readFile(captureFile));
    const initial = await json(join(f.run, 'initial.json')),
      traces = [],
      identities = new Set(),
      responseIdentities = new Set();
    for (let i = 0; i < capture.traces.length; i++) {
      const spec = capture.traces[i],
        name = String(i + 1).padStart(3, '0') + '.jsonl';
      if (!Array.isArray(spec.turns)) fail('TURN_SCOPE_REQUIRED');
      for (const t of spec.turns) {
        const key = JSON.stringify([spec.threadId, t.id]);
        if (identities.has(key)) fail('DUPLICATE_TURN_SCOPE');
        identities.add(key);
      }
      const source = resolve(base, spec.path),
        bytes = await rawFile(source);
      await put(join(raw, name), bytes);
      traces.push({
        file: 'raw/' + name,
        sha256: hash(bytes),
        ...(await nativeMetrics(
          join(raw, name),
          spec,
          f.protocol.config.roleModels?.[spec.role] ?? f.protocol.config,
        )),
      });
    }
    for (const trace of traces)
      for (const turn of trace.turns)
        for (const usage of turn.usageLines) {
          const key = JSON.stringify([turn.threadId, usage.responseId]);
          if (responseIdentities.has(key)) fail('DUPLICATE_RESPONSE_SCOPE');
          responseIdentities.add(key);
        }
    const after = await snapshot(
      f.protocol.config.workspace,
      join(f.run, 'after'),
      f.protocol.config.snapshotPaths,
    );
    const toolIdentities = new Set();
    for (const trace of traces)
      for (const tool of trace.tools) {
        const key = JSON.stringify([trace.threadId, tool.callId]);
        if (toolIdentities.has(key)) fail('DUPLICATE_TOOL_SCOPE');
        toolIdentities.add(key);
      }
    const endedAt = stamp(),
      metrics = aggregate(traces);
    const intervals = capture.intervals ?? [];
    const annotations = [];
    for (const interval of intervals) {
      if (
        ![
          'human_wait',
          'cold_start',
          'curation',
          'checkpoint',
          'navigation',
        ].includes(interval.kind) ||
        !interval.explanation ||
        !Array.isArray(interval.evidence) ||
        !interval.evidence.length
      )
        fail('INTERVAL_INVALID');
      unionMs([[interval.start, interval.end]]);
      const evidence = await Promise.all(
        interval.evidence.map((r) => checkEvidence(f.run, r)),
      );
      annotations.push({
        ...interval,
        evidence,
        provenance: 'observer annotated, not a native timer',
      });
    }
    const reasons = [];
    const annotatedTimingMs = Object.fromEntries(
      ['human_wait', 'cold_start', 'curation', 'checkpoint', 'navigation'].map(
        (kind) => [
          kind,
          unionMs(
            annotations
              .filter((a) => a.kind === kind)
              .map((a) => [a.start, a.end]),
          ),
        ],
      ),
    );
    if (capture.status !== 'completed') reasons.push(capture.status);
    if (!initial.before.stable || !after.stable)
      reasons.push('unstable_snapshot');
    if (!initial.versionMatch) reasons.push('version_mismatch');
    if (
      f.protocol.config.controlPaths.some(
        (p) =>
          (initial.before.files[p]?.sha256 ?? null) !==
          (after.files[p]?.sha256 ?? null),
      )
    )
      reasons.push('instructions_changed_during_run');
    const runtimeFiles = (files) =>
      Object.fromEntries(
        Object.entries(files)
          .filter(([name]) => name.startsWith('node_modules/knownex/'))
          .map(([name, entry]) => [name, entry.sha256]),
      );
    if (
      JSON.stringify(runtimeFiles(initial.before.files)) !==
      JSON.stringify(runtimeFiles(after.files))
    )
      reasons.push('installation_changed_during_run');
    if (metrics.tokens.coverage !== 'complete')
      reasons.push('usage_incomplete');
    if (traces.some((t) => t.turns.some((t) => !t.modelMatch)))
      reasons.push('model_reasoning_unverified');
    const collection = {
      version: 1,
      declaredStatus: capture.status,
      endedAt,
      observationWindowMs: Date.parse(endedAt) - Date.parse(f.meta.startedAt),
      comparable: reasons.length === 0,
      exclusionReasons: reasons,
      after,
      traces,
      annotations,
      annotatedTimingMs,
      metrics,
    };
    await put(join(f.run, 'collection.json'), collection);
    await event(f.run, 'collection_finished', {
      declaredStatus: capture.status,
      exclusionReasons: reasons,
    });
    await sealEvidence(f.run);
    await report(experiment, id);
    return {
      run: f.run,
      comparable: collection.comparable,
      exclusionReasons: reasons,
    };
  } catch (e) {
    await event(f.run, 'collection_failed', { code: e.message });
    let completed = false;
    try {
      await lstat(join(f.run, 'collection.json'));
      completed = true;
    } catch {}
    if (!completed) {
      await put(join(f.run, 'failure.json'), {
        stage: 'collection',
        code: e.message,
      });
      await sealEvidence(f.run);
      await report(experiment, id);
    }
    throw e;
  }
}
async function sealEvidence(run) {
  const files = await tree(run, [
    'before',
    'after',
    'raw',
    'run.json',
    'initial.json',
    'collection.json',
    'failure.json',
  ]);
  await put(join(run, 'evidence.json'), files);
  await put(
    join(run, 'evidence.sha256'),
    hash(await readFile(join(run, 'evidence.json'))) + '\n',
  );
}
async function verifyEvidence(run) {
  if (
    hash(await readFile(join(run, 'evidence.json'))) !==
    (await readFile(join(run, 'evidence.sha256'), 'utf8')).trim()
  )
    fail('EVIDENCE_MANIFEST_CHANGED');
  const files = await json(join(run, 'evidence.json'));
  const now = await tree(run, [
    'before',
    'after',
    'raw',
    'run.json',
    'initial.json',
    'collection.json',
    'failure.json',
  ]);
  if (JSON.stringify(files) !== JSON.stringify(now)) fail('EVIDENCE_CHANGED');
}
const grades = ['correct', 'partial', 'incorrect', 'omitted', 'not_evaluable'];
async function reviews(run) {
  const files = (await readdir(join(run, 'reviews')))
    .filter((n) => n.endsWith('.json'))
    .sort();
  const entries = [];
  let previous = null;
  for (const name of files) {
    const bytes = await readFile(join(run, 'reviews', name)),
      review = JSON.parse(bytes);
    if (
      review.previous !== previous ||
      hash(bytes) !==
        (
          await readFile(join(run, 'reviews', name + '.sha256'), 'utf8')
        ).trim() ||
      hash(await readFile(join(run, 'reviews', name + '.input'))) !==
        review.inputSha256
    )
      fail('REVIEW_CHAIN_CHANGED');
    entries.push(review);
    previous = hash(bytes);
  }
  return { entries, previous };
}
export async function evaluate(experiment, id, file) {
  const f = await atRun(experiment, id);
  await verifyEvidence(f.run);
  const input = await json(file),
    oracle = await json(join(f.experiment, 'reference/oracle.json'));
  if (
    ![
      'human',
      'llm_assisted',
      ...(f.protocol.config.synthetic === true ? ['fixture'] : []),
    ].includes(input.reviewer?.kind) ||
    typeof input.reviewer?.id !== 'string' ||
    !input.reviewer.id.trim() ||
    !Array.isArray(input.assessments) ||
    !input.assessments.length
  )
    fail('REVIEW_INVALID');
  const history = await reviews(f.run),
    seen = new Set();
  const checked = [];
  for (const a of input.assessments) {
    if (
      !oracle.facts.some((x) => x.id === a.factId) ||
      seen.has(a.factId) ||
      ['verdict', 'memory', 'retrieval', 'use', 'fidelity'].some(
        (k) => !grades.includes(a[k]),
      ) ||
      typeof a.explanation !== 'string' ||
      !a.explanation.trim() ||
      !Array.isArray(a.evidence) ||
      !a.evidence.length ||
      !Array.isArray(a.errors) ||
      a.errors.some(
        (e) =>
          ![
            'contradiction',
            'invented',
            'misattributed',
            'temporal_confusion',
            'qualification_lost',
          ].includes(e),
      )
    )
      fail('ASSESSMENT_INVALID');
    if (a.memory === 'omitted' && !a.searchCoverage)
      fail('ABSENCE_REQUIRES_SEARCH_COVERAGE');
    seen.add(a.factId);
    const refs = [];
    for (const r of a.evidence) {
      if (r.file.startsWith('reference/'))
        refs.push({
          ...(await checkEvidence(f.experiment, r)),
          root: 'experiment',
        });
      else if (['before/', 'after/', 'raw/'].some((p) => r.file.startsWith(p)))
        refs.push({ ...(await checkEvidence(f.run, r)), root: 'run' });
      else fail('ASSESSMENT_EVIDENCE_SCOPE');
    }
    const localization =
      a.memory === 'omitted'
        ? 'absent_memory'
        : a.memory === 'correct' && a.retrieval === 'omitted'
          ? 'present_not_retrieved'
          : a.retrieval === 'correct' && a.use === 'incorrect'
            ? 'retrieved_misused'
            : a.retrieval === 'correct' && a.use === 'correct'
              ? 'correctly_used'
              : 'unresolved';
    checked.push({
      ...a,
      evidence: refs,
      localization,
      causalAttribution: 'reviewer evidence; not proven by aggregate score',
    });
  }
  const review = {
    version: 1,
    at: stamp(),
    previous: history.previous,
    reviewer: input.reviewer,
    assessments: checked,
    inputSha256: hash(await readFile(file)),
  };
  const reviewFile = join(
    f.run,
    'reviews',
    String(history.entries.length + 1).padStart(6, '0') + '.json',
  );
  await put(reviewFile + '.input', await readFile(file));
  await put(reviewFile, review);
  await put(reviewFile + '.sha256', hash(await readFile(reviewFile)) + '\n');
  await report(experiment, id);
  return { assessments: checked.length, revision: history.entries.length + 1 };
}
function qualitative(oracle, history) {
  const latest = new Map(
    history.entries.flatMap((r) =>
      r.assessments.map((a) => [a.factId, { ...a, reviewer: r.reviewer }]),
    ),
  );
  const facts = oracle.facts.map((f) => ({
    ...f,
    assessment: latest.get(f.id) ?? null,
  }));
  const counts = (rows, field) =>
    Object.fromEntries(
      grades.map((g) => [
        g,
        rows.filter((r) => r.assessment?.[field] === g).length,
      ]),
    );
  const categories = Object.fromEntries(
    ['critical', 'ordinary', 'unavailable'].map((priority) => {
      const rows = facts.filter((f) => f.priority === priority),
        complete = rows.filter(
          (f) => f.assessment?.verdict === 'correct',
        ).length;
      return [
        priority,
        {
          denominator: rows.length,
          reviewed: rows.filter((r) => r.assessment).length,
          verdict: counts(rows, 'verdict'),
          completeness: counts(rows, 'memory'),
          fidelity: counts(rows, 'fidelity'),
          utility: counts(rows, 'use'),
          strictAccuracy:
            rows.length &&
            rows.every(
              (r) => r.assessment && r.assessment.verdict !== 'not_evaluable',
            )
              ? complete / rows.length
              : null,
        },
      ];
    }),
  );
  const critical = facts.filter((f) => f.priority === 'critical');
  const gate = (field) =>
    !critical.length
      ? 'not_defined'
      : critical.some(
            (f) =>
              f.assessment &&
              f.assessment[field] !== 'correct' &&
              f.assessment[field] !== 'not_evaluable',
          )
        ? 'FAIL'
        : critical.every((f) => f.assessment?.[field] === 'correct')
          ? 'PASS'
          : 'UNMEASURED';
  const criticalGates = Object.fromEntries(
    ['verdict', 'memory', 'fidelity', 'use'].map((k) => [k, gate(k)]),
  );
  return {
    facts,
    categories,
    criticalGates,
    criticalGate: Object.values(criticalGates).includes('FAIL')
      ? 'FAIL'
      : Object.values(criticalGates).every((g) => g === 'PASS')
        ? 'PASS'
        : 'UNMEASURED',
    allCriticalJudgmentsHuman:
      critical.length > 0 &&
      critical.every((f) => f.assessment?.reviewer.kind === 'human'),
    judgeKinds: [...new Set(history.entries.map((r) => r.reviewer.kind))],
    semanticCompletenessProven: false,
  };
}
const cell = (value) => String(value ?? 'N/A').replace(/[|\r\n]/g, ' ');
export async function report(experiment, id) {
  const f = await atRun(experiment, id);
  await verifyEvidence(f.run);
  let collection;
  try {
    collection = await json(join(f.run, 'collection.json'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    const failure = await json(join(f.run, 'failure.json'));
    collection = {
      declaredStatus: 'incomplete_evidence',
      comparable: false,
      exclusionReasons: ['collection_failed', failure.code],
      metrics: aggregate([]),
      annotations: [],
      observationWindowMs: null,
    };
  }
  const history = await reviews(f.run),
    oracle = await json(join(f.experiment, 'reference/oracle.json'));
  const quality = qualitative(oracle, history),
    metrics = collection.metrics;
  const result = {
    id,
    scenario: f.protocol.config.scenario,
    condition: f.protocol.config.condition,
    synthetic: f.protocol.config.synthetic === true,
    declaredStatus: collection.declaredStatus,
    comparable: collection.comparable,
    exclusionReasons: collection.exclusionReasons,
    protocolSha256: f.meta.protocolSha256,
    oracleSha256: f.protocol.oracleSha256,
    metrics,
    quality,
    annotations: collection.annotations,
    annotatedTimingMs: collection.annotatedTimingMs ?? null,
    scope:
      'Explicit selected native turns only; completeness outside these files/scopes is not established',
    observationWindowMs: collection.observationWindowMs,
  };
  const factTable = [
    '| ID | Priorità | Esito | Memoria / recupero / uso / fedeltà | Localizzazione | Evidenze |',
    '|---|---|---|---|---|---|',
    ...quality.facts.map(
      (f) =>
        `| ${cell(f.id)} | ${f.priority} | ${f.assessment?.verdict ?? 'non revisionato'} | ${['memory', 'retrieval', 'use', 'fidelity'].map((k) => f.assessment?.[k] ?? 'non revisionato').join(' / ')} | ${f.assessment?.localization ?? 'unresolved'} | ${cell(f.assessment?.evidence.map((e) => `${e.root}:${e.file}:${e.startLine}-${e.endLine}`).join(', '))} |`,
    ),
  ].join('\n');
  const lines = [
    `# Run ${id}`,
    `Scenario: ${cell(result.scenario)}; condizione: ${cell(result.condition)}; synthetic: ${result.synthetic}.`,
    `Stato dichiarato: ${result.declaredStatus}; confrontabile: ${result.comparable}. Esclusioni: ${result.exclusionReasons.join(', ') || 'nessuna'}.`,
    '## Metriche osservate',
    `\`\`\`json\n${JSON.stringify({ tokens: metrics.tokens, byRole: metrics.byRole, byPhase: metrics.byPhase, byOperation: metrics.byOperation, toolCalls: metrics.toolCalls, toolCallsByType: metrics.toolCallsByType, recognizedNavigationCalls: metrics.recognizedNavigationCalls, recognizedExactRereads: metrics.recognizedExactRereads, activeTurnUnionMs: metrics.activeTurnUnionMs, observationWindowMs: collection.observationWindowMs, missing: metrics.missing }, null, 2)}\n\`\`\``,
    '## Valutazioni',
    `Gate critici: **${quality.criticalGate}**. Giudizi: ${quality.judgeKinds.join(', ') || 'non disponibili'}. Parziali non ricevono credito pieno.`,
    `Gate per dimensione: ${JSON.stringify(quality.criticalGates)}; giudizi critici tutti umani: ${quality.allCriticalJudgmentsHuman}.`,
    factTable,
    '## Limiti',
    'Usage identifica risposte registrate, non chiamate interne non esportate. Cache è un sottoinsieme dell’input; reasoning è un sottoinsieme dell’output. I byte serializzati dei tool non dimostrano consegna al modello. Le latenze includono scheduling e trasporto. Snapshot a due inventari, non transazione atomica. Ruoli/fasi sono attribuzioni dichiarate da verificare. Giudizi LLM non diventano ground truth. Nessuna stima monetaria o causalità end-to-end.',
  ];
  // Derived outputs may be regenerated; frozen inputs and review revisions never are.
  await writeFile(
    join(f.run, 'metrics.json'),
    JSON.stringify(result, null, 2) + '\n',
    { mode: 0o600 },
  );
  await writeFile(join(f.run, 'REPORT.md'), lines.join('\n\n') + '\n', {
    mode: 0o600,
  });
  return result;
}
export async function compare(runDirectories, output) {
  output = await outputPath(output);
  const rows = [];
  for (const path of runDirectories) {
    const run = await realpath(path),
      id = JSON.parse(await readFile(join(run, 'run.json'))).id,
      experiment = dirname(dirname(run));
    const result = await report(experiment, id),
      { protocol } = await frozen(experiment),
      c = protocol.config;
    if (under(c.workspace, resolve(output))) fail('OUTPUT_OVERLAPS_WORKSPACE');
    let initial;
    try {
      initial = await json(join(run, 'initial.json'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      initial = { before: { files: {} } };
    }
    rows.push({
      run,
      result,
      key: JSON.stringify({
        oracle: protocol.oracleSha256,
        sources: protocol.frozenFiles,
        scenario: c.scenario,
        workload: c.workload,
        comparisonGroup: c.comparisonGroup,
        instructionPolicy: c.instructionPolicy,
        instructionControls: Object.fromEntries(
          c.controlPaths.map((p) => [
            p,
            initial.before.files[p]?.sha256 ?? null,
          ]),
        ),
        transport: c.transport,
        model: c.model,
        roleModels: c.roleModels ?? null,
        reasoning: c.reasoning,
        synthetic: c.synthetic === true,
        limits: c.limits ?? null,
      }),
    });
  }
  // Source manifests include config.original, which intentionally differs by condition.
  for (const row of rows) {
    const key = JSON.parse(row.key);
    delete key.sources['reference/config.original.json'];
    row.key = JSON.stringify(key);
  }
  if (new Set(rows.map((r) => r.run)).size !== rows.length)
    fail('DUPLICATE_RUN');
  const pairs = [];
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i],
        b = rows[j],
        sharedSession = a.result.metrics.turns.some((t) =>
          b.result.metrics.turns.some((other) => other.threadId === t.threadId),
        ),
        independent =
          (a.result.synthetic && b.result.synthetic) || !sharedSession,
        eligible =
          independent &&
          a.key === b.key &&
          a.result.comparable &&
          b.result.comparable;
      pairs.push({
        a: a.result.id,
        b: b.result.id,
        eligible,
        reason: eligible
          ? 'matching declared controls; equivalence still requires review'
          : a.key !== b.key
            ? 'different controls/oracle/sources'
            : !independent
              ? 'shared native session; independent runs required'
              : 'incomplete or non-completed run',
        differenceBMinusA: eligible
          ? Object.fromEntries(
              [
                'input_tokens',
                'cached_input_tokens',
                'uncached_input_tokens',
                'output_tokens',
              ].map((k) => [
                k,
                a.result.metrics.tokens[k] !== null &&
                b.result.metrics.tokens[k] !== null
                  ? b.result.metrics.tokens[k] - a.result.metrics.tokens[k]
                  : null,
              ]),
            )
          : null,
      });
    }
  const result = {
    version: 1,
    conditions: Object.fromEntries(
      [...new Set(rows.map((r) => r.result.condition))].map((condition) => {
        const selected = rows.filter((r) => r.result.condition === condition);
        return [
          condition,
          {
            attempts: selected.length,
            comparable: selected.filter((r) => r.result.comparable).length,
            statuses: Object.fromEntries(
              [...new Set(selected.map((r) => r.result.declaredStatus))].map(
                (status) => [
                  status,
                  selected.filter((r) => r.result.declaredStatus === status)
                    .length,
                ],
              ),
            ),
          },
        ];
      }),
    ),
    runs: rows.map((r) => ({ path: r.run, ...r.result })),
    pairs,
    interpretation:
      'descriptive only; no statistical significance, pooled failed runs, or causal cost claim',
  };
  await mkdir(resolve(output), { mode: 0o700 });
  await put(join(output, 'comparison.json'), result);
  const csv = [
    [
      'run',
      'condition',
      'status',
      'eligible',
      'input',
      'cached',
      'uncached',
      'output',
      'criticalGate',
    ],
    ...rows.map(({ result: r }) => [
      r.id,
      r.condition,
      r.declaredStatus,
      r.comparable,
      r.metrics.tokens.input_tokens,
      r.metrics.tokens.cached_input_tokens,
      r.metrics.tokens.uncached_input_tokens,
      r.metrics.tokens.output_tokens,
      r.quality.criticalGate,
    ]),
  ]
    .map((r) =>
      r.map((v) => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(','),
    )
    .join('\n');
  await put(join(output, 'comparison.csv'), csv + '\n');
  await put(
    join(output, 'REPORT.md'),
    [
      '# Confronto descrittivo',
      ...pairs.map(
        (p) =>
          `- ${p.a} / ${p.b}: ${p.eligible ? 'confrontabile' : 'escluso'} (${p.reason}); delta B−A ${JSON.stringify(p.differenceBMinusA)}.`,
      ),
      'Tutti i run, inclusi fallimenti e policy block, restano in comparison.json e CSV. Nessuna conclusione causale o significatività statistica.',
    ].join('\n\n') + '\n',
  );
  return {
    runs: rows.length,
    eligiblePairs: pairs.filter((p) => p.eligible).length,
    output: resolve(output),
  };
}
