import { decodeUtf8, utf8Bytes } from './artifact-io.ts';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireJournalLock } from './journal-lock.ts';

export interface FeedInput {
  type: 'user_message' | 'assistant_final' | 'assistant_commentary';
  sessionId: string;
  turnId: string;
  text: string;
  hook: string;
  nativeThreadId?: string | null;
  messageId?: string;
  source?: {
    transcriptPath: string;
    fileId: string;
    snapshotHash: string;
    recordOffset: number;
    recordBytes: number;
    recordHash: string;
    turnSource: 'retained' | 'turn_context';
    ordinal?: number;
    retainedRevision?: string;
  };
}

export interface FeedEvent extends FeedInput {
  sequence: number;
  capturedAt: string;
}

export class FeedError extends Error {
  readonly code:
    'FEED_INVALID_EVENT' | 'FEED_CORRUPT' | 'FEED_CONFLICT' | 'FEED_CHANGED';
  constructor(code: FeedError['code']) {
    super(code);
    this.name = 'FeedError';
    this.code = code;
  }
}

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

export function isFeedInput(value: unknown): value is FeedInput {
  if (
    object(value) &&
    value.nativeThreadId !== undefined &&
    value.nativeThreadId !== null &&
    !identifier(value.nativeThreadId)
  )
    return false;
  if (object(value) && value.type === 'assistant_commentary') {
    const s = value.source;
    if (
      !identifier(value.messageId) ||
      !object(s) ||
      Object.keys(s).some(
        (k) =>
          ![
            'transcriptPath',
            'fileId',
            'snapshotHash',
            'recordOffset',
            'recordBytes',
            'recordHash',
            'turnSource',
            'ordinal',
            'retainedRevision',
          ].includes(k),
      ) ||
      typeof s.transcriptPath !== 'string' ||
      !s.transcriptPath.trim() ||
      s.transcriptPath.includes('\0') ||
      !identifier(s.fileId) ||
      typeof s.snapshotHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(s.snapshotHash) ||
      typeof s.recordHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(s.recordHash) ||
      !Number.isSafeInteger(s.recordOffset) ||
      (s.recordOffset as number) < 0 ||
      !Number.isSafeInteger(s.recordBytes) ||
      (s.recordBytes as number) < 1 ||
      !['retained', 'turn_context'].includes(s.turnSource as string) ||
      (s.ordinal !== undefined &&
        (!Number.isSafeInteger(s.ordinal) || (s.ordinal as number) < 0)) ||
      (s.retainedRevision !== undefined && !identifier(s.retainedRevision))
    )
      return false;
  }
  return (
    object(value) &&
    ['user_message', 'assistant_final', 'assistant_commentary'].includes(
      value.type as string,
    ) &&
    identifier(value.sessionId) &&
    identifier(value.turnId) &&
    typeof value.text === 'string' &&
    identifier(value.hook)
  );
}

export const feedIdentity = (event: FeedInput) =>
  JSON.stringify([
    event.type,
    event.sessionId,
    event.turnId,
    ...(event.type === 'assistant_commentary' ? [event.messageId] : []),
  ]);

function recover(bytes: Buffer, sessionId?: string) {
  const events = new Map<string, FeedEvent>();
  let previous: string | null = null,
    confirmed = 0,
    sequence = 0,
    end: number;
  while ((end = bytes.indexOf(10, confirmed)) !== -1) {
    try {
      const frame: unknown = JSON.parse(
        decodeUtf8(bytes.subarray(confirmed, end), true),
      );
      if (
        !object(frame) ||
        !object(frame.block) ||
        frame.block.version !== 1 ||
        frame.block.previous !== previous ||
        typeof frame.checksum !== 'string' ||
        frame.checksum !== hash(JSON.stringify(frame.block))
      )
        throw new Error();
      const event = frame.block.event;
      if (
        !isFeedInput(event) ||
        !object(event) ||
        (sessionId !== undefined && event.sessionId !== sessionId) ||
        event.sequence !== sequence + 1 ||
        !Number.isSafeInteger(event.sequence) ||
        typeof event.capturedAt !== 'string' ||
        new Date(event.capturedAt).toISOString() !== event.capturedAt ||
        events.has(feedIdentity(event))
      )
        throw new Error();
      events.set(feedIdentity(event), event as unknown as FeedEvent);
      sequence++;
      previous = frame.checksum;
      confirmed = end + 1;
    } catch {
      throw new FeedError('FEED_CORRUPT');
    }
  }
  return { events, previous, confirmed, sequence };
}

/**
 * Append under sha256(sessionId).jsonl, or project.jsonl in explicit project mode.
 * Native identity is type/session/turn; commentary also requires messageId.
 * Identical text for that identity is a no-op; changed text conflicts.
 * LF commits the whole checksummed frame. Recovery discards only an incomplete
 * final frame, after validating committed data and the incoming event.
 * The shared process lock fails explicitly when occupied; there is no polling.
 * OS flush is requested, without a power-loss or forced-termination guarantee.
 */
export async function appendFeedEvent(
  directory: string,
  input: FeedInput,
  project = false,
) {
  if (!isFeedInput(input)) throw new FeedError('FEED_INVALID_EVENT');
  // Copy the contract before awaiting: the caller cannot mutate the pending write.
  const value: FeedInput = {
    type: input.type,
    sessionId: input.sessionId,
    turnId: input.turnId,
    text: input.text,
    hook: input.hook,
    ...(input.nativeThreadId !== undefined
      ? { nativeThreadId: input.nativeThreadId }
      : {}),
    ...(input.type === 'assistant_commentary'
      ? { messageId: input.messageId!, source: { ...input.source! } }
      : {}),
  };
  await mkdir(directory, { recursive: true });
  const destination = join(
    await realpath(directory),
    project ? 'project.jsonl' : hash(value.sessionId) + '.jsonl',
  );
  const release = await acquireJournalLock(destination + '.lock');
  let file;
  try {
    file = await open(destination, constants.O_RDWR | constants.O_CREAT, 0o600);
    const initial = await file.stat({ bigint: true });
    if (!initial.isFile()) throw new FeedError('FEED_CHANGED');
    const bytes = await file.readFile();
    const state = recover(bytes, project ? undefined : value.sessionId);
    const existing = state.events.get(feedIdentity(value));
    if (existing && existing.text !== value.text)
      throw new FeedError('FEED_CONFLICT');
    if (!Number.isSafeInteger(state.sequence + 1))
      throw new FeedError('FEED_CORRUPT');
    const event: FeedEvent = existing ?? {
      ...value,
      sequence: state.sequence + 1,
      capturedAt: new Date().toISOString(),
    };
    const block = { version: 1, previous: state.previous, event };
    const frame = existing
      ? undefined
      : utf8Bytes(
          JSON.stringify({ block, checksum: hash(JSON.stringify(block)) }) +
            '\n',
        );
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
      throw new FeedError('FEED_CHANGED');
    const recoveredBytes = bytes.length - state.confirmed;
    if (recoveredBytes > 0) await file.truncate(state.confirmed);
    if (frame) {
      let written = 0;
      while (written < frame.length) {
        const result = await file.write(
          frame,
          written,
          frame.length - written,
          state.confirmed + written,
        );
        if (result.bytesWritten === 0)
          throw new Error('Feed write made no progress');
        written += result.bytesWritten;
      }
    }
    await file.sync();
    return {
      appended: existing ? 0 : 1,
      sequence: event.sequence,
      recoveredBytes,
    };
  } finally {
    try {
      await file?.close();
    } finally {
      await release();
    }
  }
}
