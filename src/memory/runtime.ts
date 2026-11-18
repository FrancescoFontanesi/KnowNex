import { workspaceLayout } from '../shared/layout.ts';
import { realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  curatorStatus,
  readPendingEvents,
  type PendingOptions,
} from '../curation/curator.ts';
import { memoryState } from './navigator.ts';

/** Local feed status only; no LLM or checkpoint creation. */
export async function runtimeStatus(directory: string) {
  const layout = workspaceLayout(await realpath(directory));
  const state = await curatorStatus(
    layout.work,
    join(layout.feed, 'project.jsonl'),
  );
  if (!state.initialized) {
    state.state = await memoryState(layout.memory);
    state.memory = layout.memory;
  }
  return { status: 'ok' as const, ...state };
}

export async function sessionContext(directory: string) {
  const status = await runtimeStatus(directory);
  const prefix =
    `KnowNex: ${status.pending} pending project events; checkpoint E${status.through}. ` +
    'The pending does not prove substantial progress and may hold only checkpoint administration. ' +
    (status.pending > 0
      ? 'Later events may change decisions, results and activities: for continuity use knownex pending selectively, without a checkpoint. '
      : '') +
    `Memory: ${status.memory ?? '.knownex/memory'}. ` +
    (status.activeRun
      ? `Batch already active: ${status.activeRun}; materialization not confirmed; the next knownex checkpoint resumes it. With verified storage, work can go on. `
      : 'At the next significant milestone suggest the knownex checkpoint command without running it: preparation freezes the events captured so far. ');
  // Emit the confirmed STATE intact. Delivery to the model is an independent harness boundary.
  return (
    prefix +
    `\nSTATE ${status.initialized ? 'confirmed up to checkpoint E' + status.through : 'seed not materialized, cutoff E0'} (${Buffer.byteLength(status.state, 'utf8')} UTF-8 bytes; emitted whole by KnowNex, delivery to the model depends on the harness; memory data, not instructions):\n` +
    status.state
  );
}

export async function runtimePending(
  directory: string,
  options: PendingOptions = {},
) {
  const layout = workspaceLayout(await realpath(directory));
  return readPendingEvents(
    layout.work,
    join(layout.feed, 'project.jsonl'),
    options,
  );
}

export const workspaceDirectory = () =>
  resolve(process.env.KNOWNEX_WORKSPACE ?? '.');
