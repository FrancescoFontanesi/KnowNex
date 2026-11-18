import { join, resolve } from 'node:path';
import { canonicalWork, workspaceLayout } from '../shared/layout.ts';
import { acquireJournalLock } from '../shared/journal-lock.ts';
import {
  applyCurator,
  curatorStatus,
  initCurator,
  prepareCurator,
  validateCurator,
} from '../curation/curator.ts';
import {
  jsonText,
  readArtifact,
  writeAtomicText,
  writeExclusiveFiles,
} from '../shared/artifact-io.ts';
import { readCurationRun } from './curation-io.ts';
import { fail } from '../shared/check.ts';

interface PreparedCheckpointOptions {
  stage: 'prepare' | 'complete';
  run?: string;
  /** prepare: last feed sequence of a new batch (default: everything pending). */
  through?: number;
}
export interface DelegationResult extends Omit<CheckpointResult, 'status'> {
  status: 'SUCCESS' | 'BLOCKED' | 'ERROR';
}
export function delegationResult(result: CheckpointResult): DelegationResult {
  // Explicit projection: never relay a document/report returned by an internal primitive.
  return {
    status:
      result.status === 'applied'
        ? 'SUCCESS'
        : result.status === 'blocked'
          ? 'BLOCKED'
          : 'ERROR',
    through: result.through,
    ...(result.code ? { code: result.code } : {}),
    ...(result.phase ? { phase: result.phase } : {}),
    ...(result.cause ? { cause: result.cause } : {}),
    ...(result.action ? { action: result.action } : {}),
    ...(result.evidence ? { evidence: result.evidence } : {}),
    ...(result.knowledge ? { knowledge: result.knowledge } : {}),
    ...(result.replayed ? { replayed: true } : {}),
  };
}
/** A fault of the machine (a held lock, an errno), not of the delivery: a later run may succeed. */
export const transient = (code: string) =>
  code === 'DESTINATION_BUSY' || /^E[A-Z]+$/.test(code);
const json = async (p: string) => JSON.parse((await readArtifact(p)).text);

interface CheckpointResult {
  status: 'applied' | 'blocked' | 'error';
  through: number | null;
  code?: string;
  phase?: string;
  cause?: string;
  action?: string;
  evidence?: string;
  knowledge?: { created: number; updated: number };
  replayed?: boolean;
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
    ...(replayed ? { replayed: true } : {}),
  };
}
/** Shared publication path: no model launch, unchanged validation/seal/apply primitives. */
async function finishPreparedCheckpoint(
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
  await applyCurator(work, validation.seal);
  const envelope = await json(join(work, 'apply.json'));
  const resultApplied = applied(envelope.record);
  receipt.status = 'applied';
  receipt.completedAt = new Date().toISOString();
  await writeAtomicText(
    join(run, 'controller.json'),
    jsonText(receipt, 2) + '\n',
  );
  return resultApplied;
}

/** Principal coordinates prepare/complete; Curator only materializes the frozen run. */
export async function preparedCheckpoint(
  work: string,
  options: PreparedCheckpointOptions,
) {
  work = resolve(work);
  const workspace = resolve(work, canonicalWork(work) ? '../../..' : '../..');
  const layout =
    options.stage === 'prepare' ? workspaceLayout(workspace) : undefined;
  let feed = layout ? join(layout.feed, 'project.jsonl') : '';
  let phase = 'runtime',
    through: number | null = null,
    run: string | undefined,
    receipt: Record<string, any> | undefined,
    release: (() => Promise<void>) | undefined;
  try {
    if (!['prepare', 'complete'].includes(options.stage))
      fail('CURATOR_ARGUMENT_INVALID');
    if (
      options.stage === 'complete' &&
      (!options.run || !/^[a-z0-9-]+$/.test(options.run))
    )
      fail('CURATOR_ARGUMENT_INVALID');
    if (options.stage === 'complete') {
      run = join(work, 'runs', options.run!);
      feed = (await readCurationRun(run)).base.feed;
    }
    // Status completes only already authorized recovery, before any new delegation is claimed.
    let status = await curatorStatus(work, feed);
    through = status.through;
    if (options.stage === 'prepare' && !status.initialized && !status.pending)
      return delegationResult({ status: 'applied', through, action: 'noop' });
    if (!status.initialized) {
      if (options.stage !== 'prepare') fail('CURATOR_NOT_INITIALIZED');
      await initCurator(work, layout!.memory, feed, 0);
    }
    release = await acquireJournalLock(join(work, 'controller.lock'));
    if (options.stage === 'prepare') {
      phase = 'prepare';
      const prepared = await prepareCurator(work, undefined, {
        autonomous: true,
        ...(options.through !== undefined ? { through: options.through } : {}),
      });
      if (!prepared.run)
        return delegationResult({ status: 'applied', through, action: 'noop' });
      run = prepared.run;
      const record = await json(join(run, 'run.json'));
      let existing;
      try {
        existing = await json(join(run, 'controller.json'));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (existing && existing.policy !== 'frozen-batch-clean-report-v1')
        fail('CURATOR_RUN_REQUIRED');
      if (existing && existing.status !== 'prepared')
        fail('CURATOR_CHECKPOINT_RETRY_FORBIDDEN');
      receipt = existing ?? {
        version: 1,
        policy: 'frozen-batch-clean-report-v1',
        status: 'prepared',
        phase,
        through,
        startedAt: new Date().toISOString(),
      };
      if (!existing)
        await writeExclusiveFiles([
          {
            path: join(run, 'controller.json'),
            text: jsonText(receipt, 2) + '\n',
          },
        ]);
      return {
        status: 'READY' as const,
        version: 1,
        operation: 'checkpoint' as const,
        workspace,
        runId: record.id,
        run,
        from: prepared.from,
        through: prepared.through,
      };
    }
    run = join(work, 'runs', options.run!);
    let saved;
    try {
      saved = await json(join(run, 'controller.json'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (!saved) {
      if (resolve(status.activeRun ?? '') !== run) fail('CURATOR_RUN_REQUIRED');
      saved = {
        version: 1,
        policy: 'frozen-batch-clean-report-v1',
        status: 'prepared',
        phase: 'delivery',
        through,
      };
      await writeExclusiveFiles([
        { path: join(run, 'controller.json'), text: jsonText(saved, 2) + '\n' },
      ]);
    }
    if (saved.policy !== 'frozen-batch-clean-report-v1')
      fail('CURATOR_RUN_REQUIRED');
    // Replay is restricted to this run's sealed apply journal, never a worker retry.
    const recover = async () => {
      const journal = await json(join(work, 'apply.json'));
      return (
        journal.record?.runId === options.run &&
        journal.record?.seal === saved.seal &&
        journal.record?.after?.sequence === through
      );
    };
    if (!status.activeRun && saved.seal && (await recover()))
      return delegationResult({
        status: 'applied',
        through,
        replayed: true,
      });
    if (resolve(status.activeRun ?? '') !== run) fail('CURATOR_RUN_REQUIRED');
    if (saved.status !== 'prepared') fail('CURATOR_CHECKPOINT_RETRY_FORBIDDEN');
    // Until the Curator has delivered both artifacts nothing is consumed: complete can be repeated.
    phase = 'delivery';
    // A Curator may still be writing in parallel: its write holds this lock, so complete
    // either sees a whole delivery and freezes it, or stops busy without consuming the run.
    const releaseDelivery = await acquireJournalLock(
      join(run, 'delivery.lock'),
    );
    try {
      for (const name of ['proposal.json', 'review.json'])
        try {
          await readArtifact(join(run, name));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            fail('CURATOR_WORKER_OUTPUT_INCOMPLETE');
          throw e;
        }
      // From here a failure is final: the run is marked failed and never retried.
      receipt = saved as Record<string, any>;
      receipt.status = 'finishing';
      await writeAtomicText(
        join(run, 'controller.json'),
        jsonText(receipt, 2) + '\n',
      );
    } finally {
      await releaseDelivery();
    }
    const final = await finishPreparedCheckpoint(work, run, receipt!, (p) => {
      phase = p;
    });
    return delegationResult(final);
  } catch (error) {
    const raw = (error as NodeJS.ErrnoException).code,
      code =
        typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(raw)
          ? raw
          : 'CURATOR_CHECKPOINT_FAILED';
    try {
      if (!feed) feed = (await json(join(work, 'checkpoint.json'))).feed;
      const status = await curatorStatus(work, feed);
      through = status.through;
      if (phase === 'apply' && run && receipt?.seal) {
        const journal = await json(join(work, 'apply.json'));
        if (
          journal.record?.runId === options.run &&
          journal.record?.seal === receipt.seal &&
          journal.record?.after?.sequence === through
        )
          return delegationResult({
            status: 'applied',
            through,
            replayed: true,
          });
      }
    } catch {
      through = null;
    }
    // A busy lock or an I/O fault says nothing about the delivery: the batch stays prepared.
    // In apply only a busy lock qualifies, since it stops applyCurator before apply.json exists.
    const retryable =
      transient(code) && (phase !== 'apply' || code === 'DESTINATION_BUSY');
    if (run && receipt)
      try {
        await writeAtomicText(
          join(run, 'controller.json'),
          jsonText(
            {
              ...receipt,
              status: retryable ? 'prepared' : 'failed',
              phase,
              code,
            },
            2,
          ) + '\n',
        );
      } catch {
        /* Diagnostic persistence cannot authorize publication. */
      }
    return delegationResult({
      status: 'error',
      through,
      code,
      phase,
      cause: retryable
        ? 'Checkpoint stopped by a transient failure; the batch stays prepared.'
        : 'Checkpoint stopped; no worker retry is authorized.',
      action: retryable
        ? 'Run the checkpoint again.'
        : 'Inspect internal evidence; withdraw an uncommitted batch before explicitly preparing a new one.',
      ...(run ? { evidence: run } : {}),
    });
  } finally {
    await release?.();
  }
}
