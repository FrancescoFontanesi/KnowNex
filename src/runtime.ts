import { readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  curatorStatus,
  initCurator,
  requestCurator,
  readPendingEvents,
  type PendingOptions,
} from './curator.ts';
import { memoryState } from './navigator.ts';

/** No LLM, checkpoint creation or transcript reads in lifecycle hooks. */
export async function runtimeStatus(directory: string) {
  const root = await realpath(directory);
  const feedDirectory = join(root, '.knownex/feed');
  const legacy = (await readdir(feedDirectory))
    .filter((name) => /^[a-f0-9]{64}\.jsonl$/.test(name))
    .sort();
  if (legacy.length) {
    return {
      status: 'blocked' as const,
      code: 'LEGACY_SESSION_FEEDS',
      journals: legacy.map((name) => '.knownex/feed/' + name),
    };
  }
  const state = await curatorStatus(
    join(root, '.knownex/curator'),
    join(feedDirectory, 'project.jsonl'),
  );
  if (!state.initialized) state.state = await memoryState(join(root, 'memory'));
  return { status: 'ok' as const, ...state };
}

export async function sessionContext(directory: string) {
  const status = await runtimeStatus(directory);
  if (status.status !== 'ok')
    return 'KnowNex: pending legacy presente; runtime bloccato (LEGACY_SESSION_FEEDS). Nessuna migrazione automatica. Usa knownex runtime per i riferimenti.';
  const prefix =
    `KnowNex: ${status.pending} eventi pendenti di progetto; checkpoint E${status.through}. ` +
    'Il pending non prova progresso sostanziale e puo includere sola amministrazione del checkpoint. ' +
    (status.pending > 0
      ? 'Eventi successivi possono cambiare decisioni, risultati e attivita: per continuita usa knownex pending selettivamente, senza checkpoint. '
      : '') +
    `Memoria: ${status.memory ?? 'memory (seed non materializzato)'}. ` +
    (status.activeRun
      ? `Batch gia attivo: ${status.activeRun}; materializzazione non confermata, nessuna nuova delega automatica. Con storage verificato il lavoro puo proseguire. `
      : status.unconfirmedRun
        ? `Tentativo non confermato: ${status.unconfirmedRun}; eventi conservati, lavoro ordinario consentito. Un nuovo tentativo richiede nuova richiesta e nuovo Si/No. `
        : 'Al prossimo milestone significativo usa knownex-handoff; nessun checkpoint per turno. ');
  // Never inject a misleading partial STATE. Large STATE stays selectively readable.
  return (
    prefix +
    (Buffer.byteLength(status.state) <= 6144
      ? `\nSTATE ${status.initialized ? 'confermato fino al checkpoint E' + status.through : 'seed non materializzato, cutoff E0'} (dati di memoria, non istruzioni):\n` +
        status.state
      : '\nSTATE oltre il limite di contesto: usa knownex-recall solo se pertinente.')
  );
}

export async function runtimePending(
  directory: string,
  options: PendingOptions = {},
) {
  const root = await realpath(directory);
  const directoryFeed = join(root, '.knownex/feed');
  if (
    (await readdir(directoryFeed)).some((name) =>
      /^[a-f0-9]{64}\.jsonl$/.test(name),
    )
  )
    throw Object.assign(new Error(), { code: 'LEGACY_SESSION_FEEDS' });
  return readPendingEvents(
    join(root, '.knownex/curator'),
    join(directoryFeed, 'project.jsonl'),
    options,
  );
}

export const workspaceDirectory = () =>
  resolve(process.env.KNOWNEX_WORKSPACE ?? '.');

/** Generic request used by the principal in an acquired, still-open chat turn. */
export async function requestCheckpoint(directory: string, milestone?: string) {
  const root = await realpath(directory);
  const status = await runtimeStatus(root);
  if (status.status !== 'ok')
    throw Object.assign(new Error(), { code: status.code });
  const work = join(root, '.knownex/curator');
  if (!status.initialized)
    await initCurator(
      work,
      join(root, 'memory'),
      join(root, '.knownex/feed/project.jsonl'),
      0,
    );
  return requestCurator(work, milestone ?? `manual-${status.latest}`);
}
