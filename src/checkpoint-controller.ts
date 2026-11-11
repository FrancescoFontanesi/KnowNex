import { join } from 'node:path';
import { validateCurator, applyCurator } from './curator.ts';
import { jsonText, readArtifact, writeAtomicText } from './artifact-io.ts';

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
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const readJson = async (p: string) => JSON.parse((await readArtifact(p)).text);
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
  await applyCurator(work, validation.seal);
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
