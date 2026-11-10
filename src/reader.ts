import { decodeUtf8 } from './artifact-io.ts';
import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';

export interface ReadCursor {
  readonly offset: number;
  readonly fileId: string;
  readonly prefixHash: string;
}

export interface JsonlRecord {
  /** Original UTF-8 line, excluding LF; preserves CR and JSON number spelling. */
  readonly raw: string;
  readonly value: unknown;
}

export class ReaderError extends Error {
  readonly code: 'CURSOR_INVALID' | 'FILE_CHANGED' | 'JSONL_MALFORMED';
  readonly offset: number;

  constructor(code: ReaderError['code'], offset: number) {
    super(`${code} at byte ${offset}`);
    this.name = 'ReaderError';
    this.code = code;
    this.offset = offset;
  }
}

function identity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}

async function readBytes(file: FileHandle, offset: number, length: number) {
  const buffer = Buffer.allocUnsafe(length);
  let position = 0;
  while (position < length) {
    const { bytesRead } = await file.read(
      buffer,
      position,
      length - position,
      offset + position,
    );
    if (bytesRead === 0)
      throw new ReaderError('FILE_CHANGED', offset + position);
    position += bytesRead;
  }
  return buffer;
}

async function hashPrefix(file: FileHandle, length: number) {
  const hash = createHash('sha256');
  for (let offset = 0; offset < length; offset += 65536) {
    hash.update(
      await readBytes(file, offset, Math.min(65536, length - offset)),
    );
  }
  return hash;
}

/**
 * Read complete LF-terminated JSON values from a read-only snapshot of a file.
 * Omit the cursor for the first read; serialize the returned cursor unchanged.
 * Errors return no records or cursor: callers retain their previous cursor.
 * Raw lines are authoritative; parsed values can lose JSON number precision.
 * Integrity checks reread the consumed prefix. Concurrent append is supported;
 * arbitrary concurrent rewrites cannot be made atomic without writer cooperation.
 */
export async function readJsonl(
  path: string,
  cursor?: ReadCursor,
): Promise<{ records: JsonlRecord[]; cursor: ReadCursor }> {
  if (
    cursor !== undefined &&
    (cursor === null ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 0 ||
      typeof cursor.fileId !== 'string' ||
      typeof cursor.prefixHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(cursor.prefixHash))
  ) {
    throw new ReaderError('CURSOR_INVALID', 0);
  }

  const file = await open(path, 'r');
  try {
    const initial = await file.stat({ bigint: true });
    const fileId = identity(initial);
    const offset = cursor?.offset ?? 0;
    if (!initial.isFile() || initial.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ReaderError('FILE_CHANGED', offset);
    }
    const size = Number(initial.size);
    if (size < offset || (cursor && cursor.fileId !== fileId)) {
      throw new ReaderError('FILE_CHANGED', offset);
    }

    const hash = await hashPrefix(file, offset);
    if (cursor && hash.copy().digest('hex') !== cursor.prefixHash) {
      throw new ReaderError('FILE_CHANGED', offset);
    }
    if (offset > 0 && (await readBytes(file, offset - 1, 1))[0] !== 10) {
      throw new ReaderError('CURSOR_INVALID', offset);
    }

    const tail = await readBytes(file, offset, size - offset);
    const records: JsonlRecord[] = [];
    let consumed = 0;
    let end: number;
    while ((end = tail.indexOf(10, consumed)) !== -1) {
      try {
        const raw = decodeUtf8(tail.subarray(consumed, end));
        const value: unknown = JSON.parse(raw);
        records.push({ raw, value });
      } catch {
        throw new ReaderError('JSONL_MALFORMED', offset + consumed);
      }
      consumed = end + 1;
    }

    const nextOffset = offset + consumed;
    const prefixHash = hash.update(tail.subarray(0, consumed)).digest('hex');
    if ((await hashPrefix(file, nextOffset)).digest('hex') !== prefixHash) {
      throw new ReaderError('FILE_CHANGED', nextOffset);
    }
    const final = await file.stat({ bigint: true });
    const current = await stat(path, { bigint: true });
    if (
      final.size < initial.size ||
      current.size < initial.size ||
      identity(current) !== fileId
    ) {
      throw new ReaderError('FILE_CHANGED', nextOffset);
    }
    return { records, cursor: { offset: nextOffset, fileId, prefixHash } };
  } finally {
    await file.close();
  }
}
