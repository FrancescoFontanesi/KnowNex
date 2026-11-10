import { open, realpath } from 'node:fs/promises';

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === 'string' && !!v.trim() && v.length <= 256;

/** Read only the native header; a transcript body is not a retained-history oracle. */
export async function nativeThread(path: string, sessionId: string) {
  const file = await open(await realpath(path), 'r');
  try {
    let bytes = Buffer.alloc(0);
    while (bytes.length < 2 * 1024 * 1024) {
      const chunk = Buffer.alloc(16384);
      const { bytesRead } = await file.read(chunk);
      bytes = Buffer.concat([bytes, chunk.subarray(0, bytesRead)]);
      const end = bytes.indexOf(10);
      if (end >= 0) {
        const r: unknown = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(
            bytes.subarray(0, end),
          ),
        );
        if (!object(r) || r.type !== 'session_meta' || !object(r.payload))
          fail('FEED_NATIVE_IDENTITY_INVALID');
        const p = r.payload;
        if (!id(p.id) || ![p.id, p.session_id].includes(sessionId))
          fail('FEED_NATIVE_IDENTITY_INVALID');
        return p.id;
      }
      if (!bytesRead) break;
    }
    return fail('FEED_NATIVE_IDENTITY_INVALID');
  } finally {
    await file.close();
  }
}
