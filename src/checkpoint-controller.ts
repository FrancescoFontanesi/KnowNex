import { join, resolve } from 'node:path';
import { acquireJournalLock } from './journal-lock.ts';
import { canonicalWork, workspaceLayout } from './layout.ts';
import {
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  curatorStatus,
} from './curator.ts';
import {
  jsonText,
  readArtifact,
  writeAtomicText,
  writeExclusiveFiles,
} from './artifact-io.ts';
import { curatorRequest } from './curator-request-data.ts';
import {
  inspectCodexWorker,
  runCodexCurator,
  type WorkerInput,
} from './codex-curator.ts';

export interface CheckpointResult {
  status: 'applied' | 'blocked' | 'error';
  through: number | null;
  code?: string;
  phase?: string;
  cause?: string;
  action?: string;
  evidence?: string;
  knowledge?: { created: number; updated: number };
  warnings?: string[];
  replayed?: boolean;
}
export interface CheckpointOptions {
  directive?: string;
  artifacts?: string[];
  /** Deterministic test seam; production CLI always uses native Codex. */ worker?: (
    input: WorkerInput,
  ) => Promise<unknown>;
}
const object = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const readJson = async (p: string) => JSON.parse((await readArtifact(p)).text);
async function optionalJson(p: string) {
  try {
    return await readJson(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}
function applied(record: any, replayed = false): CheckpointResult {
  const countsAvailable =
    !!record.before.knowledgeVersions?.heads &&
    !!record.after.knowledgeVersions?.heads;
  const old = new Map(
    Object.values(record.before.knowledgeVersions?.heads ?? {}).map(
      (r: any) => [r.id, r.revision],
    ),
  );
  let created = 0,
    updated = 0;
  for (const r of Object.values(
    record.after.knowledgeVersions?.heads ?? {},
  ) as any[]) {
    if (!old.has(r.id)) created++;
    else if (old.get(r.id) !== r.revision) updated++;
  }
  return {
    status: 'applied',
    through: record.after.sequence,
    ...(countsAvailable ? { knowledge: { created, updated } } : {}),
    warnings: ['CURATOR_SEMANTIC_SELF_REVIEW_ONLY'],
    ...(replayed ? { replayed: true } : {}),
  };
}
async function replay(work: string, through: number) {
  const envelope = await optionalJson(join(work, 'apply.json')),
    r = envelope?.record;
  if (
    !r ||
    !['update', 'noop'].includes(r.action) ||
    r.after.sequence !== through
  )
    return null;
  const receipt = await optionalJson(
    join(work, 'runs', r.runId, 'controller.json'),
  );
  if (
    receipt?.policy !== 'initial-invocation-clean-report-v1' ||
    receipt.seal !== r.seal
  )
    return null;
  return applied(r, true);
}

export async function checkpoint(
  work: string,
  options: CheckpointOptions = {},
): Promise<CheckpointResult> {
  const startedAt = new Date().toISOString();
  work = resolve(work);
  const root = resolve(work, canonicalWork(work) ? '../../..' : '../..'),
    layout = workspaceLayout(root),
    feed = join(layout.feed, 'project.jsonl');
  let phase = 'runtime',
    through: number | null = null,
    run: string | undefined,
    receipt: any,
    release: (() => Promise<void>) | undefined;
  try {
    // Existing stateAt/recovery owns all journal semantics; this controller adds no alternate recovery.
    let status = await curatorStatus(work, feed);
    through = status.through;
    if (status.handoff.status !== 'available') {
      const prior = await replay(work, status.through);
      if (prior) return prior;
    }
    if (status.activeRun) {
      run = status.activeRun;
      const prior = await optionalJson(join(run, 'controller.json'));
      fail(
        prior ? 'CURATOR_CHECKPOINT_RETRY_FORBIDDEN' : 'CURATOR_PENDING_EXISTS',
      );
    }
    if (status.handoff.status !== 'available') fail('CURATOR_HANDOFF_REQUIRED');
    if (!status.initialized) {
      await initCurator(work, layout.memory, feed, 0);
      status = await curatorStatus(work, feed);
    }
    release = await acquireJournalLock(join(work, 'controller.lock'));
    phase = 'prepare';
    const prepared = await prepareCurator(work, options.directive, {
      autonomous: true,
      requireInvocation: true,
      artifacts: options.artifacts,
    });
    if (!prepared.run) fail('CURATOR_CHECKPOINT_BATCH_REQUIRED');
    run = prepared.run;
    receipt = {
      version: 1,
      policy: 'initial-invocation-clean-report-v1',
      phase: 'worker',
      startedAt,
      preparedAt: new Date().toISOString(),
      through,
    };
    await writeExclusiveFiles([
      { path: join(run, 'controller.json'), text: jsonText(receipt, 2) + '\n' },
    ]);
    const request = await curatorRequest(run),
      requestFile = join(run, 'request.txt');
    await writeExclusiveFiles([{ path: requestFile, text: request.text }]);
    phase = 'worker-preflight';
    const config = options.worker ? null : await inspectCodexWorker(run);
    phase = 'worker';
    receipt.workerStartedAt = new Date().toISOString();
    const result = options.worker
      ? await options.worker({ run, requestFile, workspace: root })
      : await runCodexCurator({ run, requestFile, workspace: root }, config!);
    receipt.workerCompletedAt = new Date().toISOString();
    if (!object(result)) fail('CURATOR_WORKER_OUTPUT_INCOMPLETE');
    await verifyCurationReceipts(run, result);
    return await finishPreparedCheckpoint(work, run, receipt, (p) => {
      phase = p;
    });
  } catch (error) {
    const raw = (error as NodeJS.ErrnoException).code,
      code =
        typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(raw)
          ? raw
          : 'CURATOR_CHECKPOINT_FAILED';
    try {
      const current = await curatorStatus(work, feed);
      through = current.through;
      if (phase === 'apply') {
        const recovered = await replay(work, current.through);
        if (recovered) return recovered;
      }
    } catch {
      through = null;
    }
    if (run && receipt)
      try {
        await writeAtomicText(
          join(run, 'controller.json'),
          jsonText({ ...receipt, status: 'failed', phase, code }, 2) + '\n',
        );
        await writeExclusiveFiles([
          {
            path: join(run, 'controller-error.json'),
            text:
              jsonText(
                {
                  phase,
                  code,
                  message:
                    error instanceof Error ? error.message : String(error),
                },
                2,
              ) + '\n',
          },
        ]);
      } catch {
        /* A diagnostic failure cannot turn an unconfirmed operation into success. */
      }
    return {
      status: 'error',
      through,
      code,
      phase,
      cause:
        'Checkpoint stopped; confirmed memory must be interpreted at the returned cutoff.',
      action:
        phase === 'worker-preflight'
          ? 'Resolve the native worker capability/authentication issue.'
          : 'Inspect internal evidence; do not retry the worker without a new authorized batch.',
      ...(run ? { evidence: run } : {}),
    };
  } finally {
    await release?.();
  }
}

export async function verifyCurationReceipts(run: string, result: unknown) {
  if (!object(result)) fail('CURATOR_WORKER_OUTPUT_INCOMPLETE');
  for (const name of ['proposal', 'review']) {
    const r = result[name];
    if (
      !object(r) ||
      typeof r.path !== 'string' ||
      resolve(r.path) !== join(run, name + '.json')
    )
      fail('CURATOR_WORKER_OUTPUT_INCOMPLETE');
    const actual = await readArtifact(r.path);
    if (actual.sha256 !== r.sha256 || actual.bytes !== r.bytes)
      fail('CURATOR_WORKER_RECEIPT_MISMATCH');
  }
}

/** Shared publication path: no model launch, unchanged validation/seal/apply primitives. */
export async function finishPreparedCheckpoint(
  work: string,
  run: string,
  receipt: Record<string, any>,
  onPhase: (phase: string) => void,
): Promise<CheckpointResult> {
  let phase: string;
  onPhase((phase = 'validate'));
  receipt.phase = phase;
  await writeAtomicText(
    join(run, 'controller.json'),
    jsonText(receipt, 2) + '\n',
  );
  const validation = await validateCurator(work);
  receipt.validatedAt = new Date().toISOString();
  if (!validation.review) fail('CURATOR_REVIEW_REQUIRED');
  onPhase((phase = 'review-policy'));
  const report = validation.review.report;
  if (report.anomalies.length || report.uncertainties.length) {
    receipt.phase = phase;
    receipt.status = 'blocked';
    receipt.code = 'CURATOR_CHECKPOINT_REVIEW_REQUIRED';
    await writeAtomicText(
      join(run, 'controller.json'),
      jsonText(receipt, 2) + '\n',
    );
    return {
      status: 'blocked',
      through: receipt.through,
      code: receipt.code,
      phase,
      cause: 'Curator declared unresolved anomalies or uncertainties.',
      action:
        'Review the pending proposal explicitly; no automatic apply or worker retry.',
      evidence: run,
    };
  }
  onPhase((phase = 'apply'));
  Object.assign(receipt, {
    phase,
    seal: validation.seal,
    applyStartedAt: new Date().toISOString(),
  });
  await writeAtomicText(
    join(run, 'controller.json'),
    jsonText(receipt, 2) + '\n',
  );
  await applyCurator(work, validation.seal, true);
  const envelope = await readJson(join(work, 'apply.json'));
  const resultApplied = applied(envelope.record);
  receipt.status = 'applied';
  receipt.completedAt = new Date().toISOString();
  await writeAtomicText(
    join(run, 'controller.json'),
    jsonText(receipt, 2) + '\n',
  );
  return resultApplied;
}
