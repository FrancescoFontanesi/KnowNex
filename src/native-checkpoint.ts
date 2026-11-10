import { join, resolve } from 'node:path';
import { canonicalWork, workspaceLayout } from './layout.ts';
import { acquireJournalLock } from './journal-lock.ts';
import { curatorStatus, initCurator, prepareCurator } from './curator.ts';
import {
  jsonText,
  readArtifact,
  writeAtomicText,
  writeExclusiveFiles,
} from './artifact-io.ts';
import { curatorRequest } from './curator-request-data.ts';
import {
  finishPreparedCheckpoint,
  verifyCurationReceipts,
  type CheckpointResult,
} from './checkpoint-controller.ts';

/** A reference, not permission supplied by the model. The feed remains authoritative. */
export const nativeAuthorization = 'captured-user-invocation';
export interface NativeCheckpointOptions {
  stage: 'prepare' | 'complete';
  authorization?: string;
  run?: string;
  proposalSha256?: string;
  reviewSha256?: string;
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
    ...(result.warnings ? { warnings: result.warnings } : {}),
    ...(result.replayed ? { replayed: true } : {}),
  };
}
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const json = async (p: string) => JSON.parse((await readArtifact(p)).text);

/** Principal coordinates prepare/complete; Curator only materializes the frozen run. */
export async function nativeCheckpoint(
  work: string,
  options: NativeCheckpointOptions,
) {
  work = resolve(work);
  const workspace = resolve(work, canonicalWork(work) ? '../../..' : '../..');
  const layout = workspaceLayout(workspace),
    feed = join(layout.feed, 'project.jsonl');
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
    if (
      options.stage === 'prepare' &&
      options.authorization !== nativeAuthorization
    )
      fail('CURATOR_HANDOFF_REQUIRED');
    // Status completes only already authorized recovery, before any new delegation is claimed.
    let status = await curatorStatus(work, feed);
    through = status.through;
    if (
      options.stage === 'prepare' &&
      (status.handoff.status !== 'available' || status.activeRun)
    )
      fail(
        status.activeRun
          ? 'CURATOR_CHECKPOINT_RETRY_FORBIDDEN'
          : 'CURATOR_HANDOFF_REQUIRED',
      );
    if (!status.initialized) {
      if (options.stage !== 'prepare') fail('CURATOR_NOT_INITIALIZED');
      await initCurator(work, layout.memory, feed, 0);
    }
    release = await acquireJournalLock(join(work, 'controller.lock'));
    if (options.stage === 'prepare') {
      phase = 'prepare';
      const prepared = await prepareCurator(work, undefined, {
        autonomous: true,
        requireInvocation: true,
      });
      if (!prepared.run) fail('CURATOR_CHECKPOINT_BATCH_REQUIRED');
      run = prepared.run;
      const record = await json(join(run, 'run.json'));
      if (!record.authorization) fail('CURATOR_HANDOFF_REQUIRED');
      receipt = {
        version: 1,
        mode: 'native',
        policy: 'initial-invocation-clean-report-v1',
        status: 'prepared',
        phase,
        through,
        authorization: record.authorization,
        startedAt: new Date().toISOString(),
      };
      await writeExclusiveFiles([
        {
          path: join(run, 'controller.json'),
          text: jsonText(receipt, 2) + '\n',
        },
      ]);
      const request = await curatorRequest(run);
      const requestFile = join(run, 'request.txt');
      await writeExclusiveFiles([{ path: requestFile, text: request.text }]);
      return {
        status: 'READY' as const,
        version: 1,
        operation: 'checkpoint' as const,
        workspace,
        runId: record.id,
        run,
        requestFile,
        from: prepared.from,
        through: prepared.through,
      };
    }
    run = join(work, 'runs', options.run!);
    const saved = await json(join(run, 'controller.json'));
    if (
      saved.mode !== 'native' ||
      saved.policy !== 'initial-invocation-clean-report-v1'
    )
      fail('CURATOR_NATIVE_RUN_REQUIRED');
    receipt = saved;
    // Replay is restricted to this run's sealed apply journal, never a worker retry.
    const recover = async () => {
      const journal = await json(join(work, 'apply.json'));
      return (
        journal.record?.runId === options.run &&
        journal.record?.seal === receipt!.seal &&
        journal.record?.after?.sequence === through
      );
    };
    if (!status.activeRun && receipt!.seal && (await recover()))
      return delegationResult({
        status: 'applied',
        through,
        replayed: true,
        warnings: ['CURATOR_SEMANTIC_SELF_REVIEW_ONLY'],
      });
    if (resolve(status.activeRun ?? '') !== run)
      fail('CURATOR_NATIVE_RUN_REQUIRED');
    if (receipt!.status !== 'prepared')
      fail('CURATOR_CHECKPOINT_RETRY_FORBIDDEN');
    const record = await json(join(run, 'run.json'));
    if (
      JSON.stringify(record.authorization) !==
      JSON.stringify(receipt!.authorization)
    )
      fail('CURATOR_HANDOFF_INVALID');
    phase = 'receipt-validation';
    receipt!.status = 'finishing';
    await writeAtomicText(
      join(run, 'controller.json'),
      jsonText(receipt, 2) + '\n',
    );
    const result: Record<string, unknown> = {};
    for (const name of ['proposal', 'review'] as const) {
      const actual = await readArtifact(join(run, name + '.json'));
      result[name] = {
        ...actual,
        sha256:
          options[name === 'proposal' ? 'proposalSha256' : 'reviewSha256'],
      };
    }
    await verifyCurationReceipts(run, result);
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
            warnings: ['CURATOR_SEMANTIC_SELF_REVIEW_ONLY'],
          });
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
      } catch {
        /* Diagnostic persistence cannot authorize publication. */
      }
    return delegationResult({
      status: 'error',
      through,
      code,
      phase,
      cause: 'Native checkpoint stopped; no worker retry is authorized.',
      action:
        'Inspect internal evidence; a new attempt requires a new captured invocation.',
      ...(run ? { evidence: run } : {}),
    });
  } finally {
    await release?.();
  }
}
