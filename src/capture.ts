import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { ReaderError, readJsonl } from './reader.ts';
import { acquireJournalLock } from './journal-lock.ts';
import type { ReadCursor } from './reader.ts';

interface Block {
  version: 1 | 2;
  /** Absent in legacy blocks: generation 1 is implicit. */
  generation?: number;
  sessionId?: string;
  transition?: 'FILE_CHANGED';
  source: string;
  from: number;
  previous: string | null;
  records: string[];
  cursor: ReadCursor;
}

export class CaptureError extends Error {
  readonly code:
    | 'LOG_CORRUPT'
    | 'SOURCE_MISMATCH'
    | 'DESTINATION_IS_SOURCE'
    | 'DESTINATION_BUSY'
    | 'DESTINATION_CHANGED';
  /** Byte offset in the destination journal. */
  readonly offset: number;

  constructor(code: CaptureError['code'], offset = 0) {
    super(`${code} at journal byte ${offset}`);
    this.name = 'CaptureError';
    this.code = code;
    this.offset = offset;
  }
}

const active = new Set<string>();
const hexHash = /^[a-f0-9]{64}$/;
const checksum = (block: Block) =>
  createHash('sha256').update(JSON.stringify(block)).digest('hex');

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function integer(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function decodeFrame(bytes: Buffer, offset: number) {
  try {
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const frame: unknown = JSON.parse(text);
    if (!object(frame) || !object(frame.block)) throw new Error();
    const b = frame.block;
    if (
      (b.version !== 1 && b.version !== 2) ||
      (b.version === 1 &&
        (b.generation !== undefined ||
          b.sessionId !== undefined ||
          b.transition !== undefined)) ||
      (b.version === 2 &&
        (!integer(b.generation) ||
          b.generation < 2 ||
          typeof b.sessionId !== 'string' ||
          b.sessionId.trim().length === 0 ||
          (b.transition !== undefined && b.transition !== 'FILE_CHANGED'))) ||
      typeof b.source !== 'string' ||
      !isAbsolute(b.source) ||
      !integer(b.from) ||
      !(
        b.previous === null ||
        (typeof b.previous === 'string' && hexHash.test(b.previous))
      ) ||
      !Array.isArray(b.records) ||
      !b.records.every(
        (r: unknown) => typeof r === 'string' && !r.includes('\n'),
      ) ||
      !object(b.cursor) ||
      !integer(b.cursor.offset) ||
      typeof b.cursor.fileId !== 'string' ||
      b.cursor.fileId.length === 0 ||
      typeof b.cursor.prefixHash !== 'string' ||
      !hexHash.test(b.cursor.prefixHash) ||
      typeof frame.checksum !== 'string' ||
      !hexHash.test(frame.checksum)
    )
      throw new Error();
    const block = b as unknown as Block;
    if (checksum(block) !== frame.checksum) throw new Error();
    for (const raw of block.records) JSON.parse(raw);
    return { block, checksum: frame.checksum };
  } catch {
    throw new CaptureError('LOG_CORRUPT', offset);
  }
}

/** Identity must be anchored by the first record and agree with every session_meta. */
function sessionIdentity(records: string[]): string | undefined {
  let id: string | undefined;
  for (const [index, raw] of records.entries()) {
    const value: unknown = JSON.parse(raw);
    if (index === 0 || (object(value) && value.type === 'session_meta')) {
      if (
        !object(value) ||
        value.type !== 'session_meta' ||
        !object(value.payload) ||
        typeof value.payload.id !== 'string' ||
        value.payload.id.trim().length === 0
      )
        return undefined;
      if (id !== undefined && id !== value.payload.id) return undefined;
      id = value.payload.id;
    }
  }
  return id;
}

function recover(bytes: Buffer) {
  let cursor: ReadCursor | undefined;
  let source: string | undefined;
  let previous: string | null = null;
  let confirmed = 0;
  let hash = createHash('sha256');
  let generation = 1;
  let records: string[] = [];
  let end: number;
  while ((end = bytes.indexOf(10, confirmed)) !== -1) {
    const frame = decodeFrame(bytes.subarray(confirmed, end), confirmed);
    const block = frame.block;
    const nextGeneration = block.generation ?? 1;
    const transition = nextGeneration === generation + 1;
    if (transition) {
      if (
        block.transition !== 'FILE_CHANGED' ||
        block.from !== 0 ||
        block.sessionId !== sessionIdentity(records) ||
        block.sessionId !== sessionIdentity(block.records)
      ) {
        throw new CaptureError('LOG_CORRUPT', confirmed);
      }
      hash = createHash('sha256');
      records = [];
    } else if (
      nextGeneration !== generation ||
      block.transition !== undefined
    ) {
      throw new CaptureError('LOG_CORRUPT', confirmed);
    }
    let offset = transition ? 0 : (cursor?.offset ?? 0);
    if (
      block.previous !== previous ||
      block.from !== offset ||
      (source !== undefined && block.source !== source) ||
      (!transition &&
        cursor !== undefined &&
        (block.cursor.fileId !== cursor.fileId || block.records.length === 0))
    )
      throw new CaptureError('LOG_CORRUPT', confirmed);
    for (const raw of block.records) {
      offset += Buffer.byteLength(raw) + 1;
      hash.update(raw).update('\n');
      records.push(raw);
    }
    if (block.version === 2 && block.sessionId !== sessionIdentity(records)) {
      throw new CaptureError('LOG_CORRUPT', confirmed);
    }
    if (
      offset !== block.cursor.offset ||
      hash.copy().digest('hex') !== block.cursor.prefixHash
    ) {
      throw new CaptureError('LOG_CORRUPT', confirmed);
    }
    cursor = block.cursor;
    generation = nextGeneration;
    source = block.source;
    previous = frame.checksum;
    confirmed = end + 1;
  }
  return {
    cursor,
    source,
    previous,
    confirmed,
    generation,
    records,
    sessionId: sessionIdentity(records),
  };
}

/**
 * Append original complete source lines and their checkpoint in one journal frame.
 * destination is a file in an existing directory. A canonical-path lock excludes
 * other processes; overlapping calls in this process also reject file aliases.
 * A final unterminated suffix is uncommitted and is discarded only after the
 * source and the committed journal have been validated. Committed bytes remain intact.
 * sync() requests OS persistence; this does not promise power-loss atomicity.
 */
export async function syncSession(
  source: string,
  destination: string,
): Promise<{
  appended: number;
  cursor: ReadCursor;
  recoveredBytes: number;
}> {
  const sourcePath = await realpath(source);
  const sourceInfo = await stat(sourcePath, { bigint: true });
  // Append-only handles on Windows cannot truncate an uncommitted suffix.
  const file = await open(
    destination,
    constants.O_RDWR | constants.O_CREAT,
    0o600,
  );
  let key: string | undefined;
  let release: (() => Promise<void>) | undefined;
  try {
    let initial = await file.stat({ bigint: true });
    if (initial.dev === sourceInfo.dev && initial.ino === sourceInfo.ino) {
      throw new CaptureError('DESTINATION_IS_SOURCE');
    }
    if (!initial.isFile()) throw new CaptureError('DESTINATION_CHANGED');
    const identity = `${initial.dev}:${initial.ino}:${initial.birthtimeNs}`;
    if (active.has(identity)) throw new CaptureError('DESTINATION_BUSY');
    active.add(identity);
    key = identity;
    release = await acquireJournalLock((await realpath(destination)) + '.lock');
    initial = await file.stat({ bigint: true });

    const bytes = await file.readFile();
    const state = recover(bytes);
    if (state.source !== undefined && state.source !== sourcePath) {
      throw new CaptureError('SOURCE_MISMATCH');
    }
    let result;
    let generation = state.generation;
    let transition = false;
    try {
      result = await readJsonl(sourcePath, state.cursor);
    } catch (error) {
      if (
        !(error instanceof ReaderError) ||
        error.code !== 'FILE_CHANGED' ||
        state.cursor === undefined ||
        state.sessionId === undefined
      )
        throw error;
      result = await readJsonl(sourcePath);
      if (
        sessionIdentity(result.records.map((record) => record.raw)) !==
        state.sessionId
      ) {
        throw new CaptureError('SOURCE_MISMATCH');
      }
      generation += 1;
      transition = true;
    }
    if (
      generation > 1 &&
      sessionIdentity(
        transition
          ? result.records.map((record) => record.raw)
          : state.records.concat(result.records.map((record) => record.raw)),
      ) !== state.sessionId
    ) {
      throw new CaptureError('SOURCE_MISMATCH');
    }
    const recoveredBytes = bytes.length - state.confirmed;
    const block: Block = {
      version: generation === 1 ? 1 : 2,
      ...(generation > 1 ? { generation, sessionId: state.sessionId } : {}),
      ...(transition ? { transition: 'FILE_CHANGED' as const } : {}),
      source: sourcePath,
      from: transition ? 0 : (state.cursor?.offset ?? 0),
      previous: state.previous,
      records: result.records.map((record) => record.raw),
      cursor: result.cursor,
    };
    const frame =
      state.cursor === undefined || result.records.length > 0
        ? Buffer.from(
            JSON.stringify({ block, checksum: checksum(block) }) + '\n',
          )
        : undefined;

    const current = await stat(destination, { bigint: true });
    const opened = await file.stat({ bigint: true });
    if (
      current.dev !== initial.dev ||
      current.ino !== initial.ino ||
      current.birthtimeNs !== initial.birthtimeNs ||
      current.size !== initial.size ||
      current.mtimeNs !== initial.mtimeNs ||
      opened.size !== initial.size ||
      opened.mtimeNs !== initial.mtimeNs
    )
      throw new CaptureError('DESTINATION_CHANGED', state.confirmed);

    if (recoveredBytes > 0) await file.truncate(state.confirmed);
    if (frame) {
      let offset = 0;
      while (offset < frame.length) {
        const { bytesWritten } = await file.write(
          frame,
          offset,
          frame.length - offset,
          state.confirmed + offset,
        );
        if (bytesWritten === 0)
          throw new Error('Journal write made no progress');
        offset += bytesWritten;
      }
    }
    // Also flush a recovered complete frame after a previous uncertain write outcome.
    await file.sync();
    return {
      appended: result.records.length,
      cursor: result.cursor,
      recoveredBytes,
    };
  } finally {
    try {
      await file.close();
    } finally {
      try {
        await release?.();
      } finally {
        if (key !== undefined) active.delete(key);
      }
    }
  }
}
