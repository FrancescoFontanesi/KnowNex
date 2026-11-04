import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { readJsonl } from './reader.ts';
import { appendFeedEvent } from './feed.ts';
import type { FeedInput, FeedEvent } from './feed.ts';

const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= 256;
const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const fail = (code: string): never => {
  throw Object.assign(new Error(code), { code });
};

/** Select only completed textual commentary in this Stop's session and turn. */
export async function readCommentary(
  path: string,
  sessionId: string,
  turnId: string,
) {
  if (!id(sessionId) || !id(turnId)) fail('INVALID_HOOK_PAYLOAD');
  const transcriptPath = await realpath(path);
  // ponytail: full read per Stop; reuse S1 snapshot validation, no second cursor store.
  const { records, cursor } = await readJsonl(transcriptPath);
  const events: FeedInput[] = [],
    issues = new Set<string>();
  let session = false,
    legacy = false,
    contextTurn: string | undefined,
    offset = 0;
  for (const record of records) {
    const r = record.value,
      bytes = Buffer.byteLength(record.raw) + 1;
    const at = offset;
    offset += bytes;
    if (!object(r) || !object(r.payload)) continue;
    const p = r.payload;
    if (r.type === 'session_meta') {
      const ids = [p.session_id, p.id].filter(id);
      if (!ids.length || ids.some((v) => v !== sessionId))
        fail('COMMENTARY_SESSION_MISMATCH');
      session = true;
      legacy = p.history_mode === 'legacy';
      contextTurn = undefined;
      continue;
    }
    if (r.type === 'turn_context') {
      contextTurn = id(p.turn_id) ? p.turn_id : undefined;
      continue;
    }
    if (
      r.type === 'compacted' ||
      (r.type === 'event_msg' &&
        ['task_started', 'task_complete'].includes(p.type as string))
    )
      contextTurn = undefined;
    if (
      r.type !== 'response_item' ||
      p.type !== 'message' ||
      p.role !== 'assistant' ||
      p.phase !== 'commentary'
    )
      continue;
    if (!session) fail('COMMENTARY_SESSION_MISSING');
    const retained =
      object(r.metadata) && object(r.metadata.retained_source)
        ? r.metadata.retained_source
        : undefined;
    const retainedId =
      retained && object(retained.id) ? retained.id : undefined;
    let messageId: string | undefined, messageTurn: string | undefined;
    let turnSource: 'retained' | 'turn_context';
    if (retained) {
      if (
        retained.complete !== true ||
        !retainedId ||
        retainedId.role !== 'assistant' ||
        !id(retainedId.turn_id)
      ) {
        issues.add('COMMENTARY_IDENTITY_UNVERIFIED');
        continue;
      }
      messageTurn = retainedId.turn_id;
      messageId = id(retainedId.message_id)
        ? retainedId.message_id
        : id(p.id)
          ? p.id
          : undefined;
      if (
        id(retainedId.message_id) &&
        id(p.id) &&
        retainedId.message_id !== p.id
      ) {
        issues.add('COMMENTARY_IDENTITY_MISMATCH');
        continue;
      }
      turnSource = 'retained';
    } else {
      // A paginated historical item must never inherit a surrounding current turn.
      if (!legacy || !contextTurn) {
        issues.add('COMMENTARY_IDENTITY_UNVERIFIED');
        continue;
      }
      messageTurn = contextTurn;
      messageId = id(p.id) ? p.id : undefined;
      turnSource = 'turn_context';
    }
    if (messageTurn !== turnId) continue;
    if (!messageId) {
      issues.add('COMMENTARY_IDENTITY_UNVERIFIED');
      continue;
    }
    if (
      (p.status !== undefined && p.status !== 'completed') ||
      (!retained && p.status !== 'completed')
    ) {
      issues.add('COMMENTARY_INCOMPLETE');
      continue;
    }
    if (
      !Array.isArray(p.content) ||
      !p.content.length ||
      p.content.some(
        (c) =>
          !object(c) || c.type !== 'output_text' || typeof c.text !== 'string',
      )
    ) {
      issues.add('COMMENTARY_CONTENT_UNSUPPORTED');
      continue;
    }
    const text = p.content.map((c) => (c as { text: string }).text).join('');
    events.push({
      type: 'assistant_commentary',
      sessionId,
      turnId,
      messageId,
      text,
      hook: 'Stop',
      source: {
        transcriptPath,
        fileId: cursor.fileId,
        snapshotHash: cursor.prefixHash,
        recordOffset: at,
        recordBytes: bytes,
        recordHash: sha(record.raw),
        turnSource,
        ...(Number.isSafeInteger(r.ordinal) && (r.ordinal as number) >= 0
          ? { ordinal: r.ordinal as number }
          : {}),
        ...(id(retained?.revision)
          ? { retainedRevision: retained.revision }
          : {}),
      },
    });
  }
  if (!session) fail('COMMENTARY_SESSION_MISSING');
  return { events, issues: [...issues] };
}

/** Diagnostics never include message content; native final capture remains independent. */
export async function captureCommentary(
  directory: string,
  path: unknown,
  sessionId: string,
  turnId: string,
  project = false,
) {
  let appended = 0,
    matched = 0;
  const issues = new Set<string>();
  try {
    if (typeof path !== 'string' || !path.trim())
      fail('MISSING_TRANSCRIPT_PATH');
    const selected = await readCommentary(path as string, sessionId, turnId);
    for (const code of selected.issues) issues.add(code);
    matched = selected.events.length;
    for (const event of selected.events) {
      try {
        appended += (await appendFeedEvent(directory, event, project)).appended;
      } catch (error) {
        issues.add(safeCode(error));
      }
    }
  } catch (error) {
    issues.add(safeCode(error));
  }
  return {
    commentaryAppended: appended,
    commentaryMatched: matched,
    commentaryIssues: [...issues],
  };
}

function safeCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : 'COMMENTARY_CAPTURE_FAILED';
}

/** Reorder only within contiguous turns. Physical sequences remain authoritative. */
export function projectFeedEvents(events: FeedEvent[]) {
  const ordered: FeedEvent[] = [],
    issues = new Set<string>(),
    seen = new Set<string>();
  for (let i = 0; i < events.length;) {
    const first = events[i]!,
      key = JSON.stringify([first.sessionId, first.turnId]);
    const group: FeedEvent[] = [];
    while (
      i < events.length &&
      events[i]!.sessionId === first.sessionId &&
      events[i]!.turnId === first.turnId
    )
      group.push(events[i++]!);
    if (seen.has(key)) issues.add('TURN_ORDER_AMBIGUOUS');
    seen.add(key);
    const commentary = group.filter((e) => e.type === 'assistant_commentary');
    const snapshots = new Set(
      commentary.map((e) =>
        JSON.stringify([e.source?.fileId, e.source?.snapshotHash]),
      ),
    );
    if (snapshots.size > 1) issues.add('COMMENTARY_ORDER_AMBIGUOUS');
    else
      commentary.sort(
        (a, b) => a.source!.recordOffset - b.source!.recordOffset,
      );
    ordered.push(
      ...group.filter((e) => e.type === 'user_message'),
      ...commentary,
      ...group.filter((e) => e.type === 'assistant_final'),
    );
  }
  return { events: ordered, issues: [...issues] };
}
