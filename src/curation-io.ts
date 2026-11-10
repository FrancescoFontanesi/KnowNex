import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
  jsonText,
  readArtifact,
  sha256,
  writeExclusiveFiles,
} from './artifact-io.ts';
export { transportJson } from './artifact-io.ts';

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x);
async function runAt(run: string) {
  if (
    (await realpath(run)) !== resolve(run) ||
    (await lstat(run)).isSymbolicLink()
  )
    fail('CURATOR_IO_UNSAFE_RUN');
  const record = JSON.parse((await readArtifact(join(run, 'run.json'))).text);
  if (record.id !== basename(run)) fail('CURATOR_IO_UNSAFE_RUN');
  return record;
}
/** Official Curator reader. Only the input names frozen for this run are readable. */
export async function readCurationInput(run: string, name: string) {
  const record = await runAt(run);
  if (
    !/^(inputs\.json|packet\.json|SKILL\.md|MEMORY-CONTRACT\.md|base\/(STATE\.md|HISTORY\.md|knowledge\/[a-z0-9-]+\.md))$/.test(
      name,
    )
  ) {
    const target = resolve(run, 'base', decodeURIComponent(name));
    if (!Array.isArray(record.external) || !record.external.includes(target))
      fail('CURATOR_IO_INPUT_NOT_AUTHORIZED');
    return readArtifact(target);
  }
  let expected: string | undefined;
  if (record.autonomous) {
    const manifest = await readArtifact(join(run, 'inputs.json'));
    if (manifest.sha256 !== record.inputManifestSha256)
      fail('CURATOR_INPUTS_CHANGED');
    if (name === 'inputs.json') return manifest;
    expected = JSON.parse(manifest.text).files[name]?.sha256;
    if (!expected) fail('CURATOR_IO_INPUT_NOT_AUTHORIZED');
  } else if (
    name.startsWith('base/knowledge/') &&
    !record.context?.includes(name.slice(5))
  )
    fail('CURATOR_IO_INPUT_NOT_AUTHORIZED');
  const artifact = await readArtifact(join(run, name));
  if (expected && artifact.sha256 !== expected) fail('CURATOR_INPUTS_CHANGED');
  return artifact;
}
export function stateEvidence(
  state: string,
  startLine: number,
  endLine = startLine,
) {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > state.split('\n').length
  )
    fail('CURATOR_IO_EVIDENCE_INVALID');
  return { sha256: sha256(state), startLine, endLine };
}
/** No controller transcription: the Curator passes objects directly from Node REPL. */
export async function writeCurationArtifacts(
  run: string,
  proposal: unknown,
  review?: unknown,
) {
  const work = dirname(dirname(run));
  if (basename(dirname(run)) !== 'runs') fail('CURATOR_IO_UNSAFE_RUN');
  const record = await runAt(run),
    pending = JSON.parse((await readArtifact(join(work, 'pending.json'))).text);
  if (pending.id !== record.id) fail('CURATOR_IO_RUN_NOT_PENDING');
  if (!object(proposal)) fail('CURATOR_PROPOSAL_INVALID');
  const text = jsonText(proposal, 2) + '\n',
    proposalSha256 = sha256(text);
  if (record.autonomous && !object(review)) fail('CURATOR_REVIEW_REQUIRED');
  const entries: { path: string; text: string }[] = [];
  if (review !== undefined) {
    if (!object(review) || ![1, 2].includes(review.version as number))
      fail('CURATOR_REVIEW_INVALID');
    if (
      review.proposalSha256 !== undefined &&
      review.proposalSha256 !== proposalSha256
    )
      fail('CURATOR_IO_PROPOSAL_HASH_MISMATCH');
    entries.push({
      path: join(run, 'review.json'),
      text: jsonText({ ...review, proposalSha256 }, 2) + '\n',
    });
  }
  // Proposal is the commit point. A killed writer that only published review cannot validate.
  entries.push({ path: join(run, 'proposal.json'), text });
  const receipts = await writeExclusiveFiles(entries);
  return {
    proposal: receipts.at(-1)!,
    ...(review !== undefined ? { review: receipts[0]! } : {}),
  };
}
