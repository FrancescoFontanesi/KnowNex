import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { platform } from 'node:os';
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import type { PathLike, Mode } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
export function utf8Bytes(text: string): Buffer {
  // Buffer replaces lone surrogates. Reject them rather than silently changing text.
  if (Buffer.from(text, 'utf8').toString('utf8') !== text)
    fail('KNOWNEX_UTF8_INVALID');
  return Buffer.from(text, 'utf8');
}
export function decodeUtf8(bytes: Uint8Array, stripBOM = false): string {
  try {
    return new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: !stripBOM,
    }).decode(bytes);
  } catch {
    return fail('KNOWNEX_UTF8_INVALID');
  }
}
export const sha256 = (value: string | Uint8Array) =>
  createHash('sha256')
    .update(typeof value === 'string' ? utf8Bytes(value) : value)
    .digest('hex');
export const readUtf8 = async (file: PathLike) =>
  decodeUtf8(await readFile(file));
export function jsonText(value: unknown, space?: 2): string {
  try {
    const text = JSON.stringify(
      value,
      (key, v: unknown) => {
        utf8Bytes(key);
        if (typeof v === 'string') utf8Bytes(v);
        return v;
      },
      space,
    );
    if (text === undefined) fail('KNOWNEX_JSON_INVALID');
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'KNOWNEX_UTF8_INVALID')
      throw error;
    return fail('KNOWNEX_JSON_INVALID');
  }
}
// ASCII-safe JSON transport only; artifact serialization and existing hashes are unchanged.
export const transportJson = (value: unknown) =>
  jsonText(value).replace(
    /[\u007f-\uffff]/g,
    (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'),
  );
export async function writeFile(
  file: PathLike,
  value: string | Uint8Array,
  options?: { mode?: Mode; flag?: string },
) {
  await fsWriteFile(
    file,
    typeof value === 'string' ? utf8Bytes(value) : value,
    options,
  );
}
export async function readArtifact(file: string) {
  const initial = await lstat(file);
  if (initial.isSymbolicLink() || !initial.isFile())
    fail('KNOWNEX_ARTIFACT_UNSAFE_PATH');
  const canonical = await realpath(file);
  const bytes = await readFile(file),
    text = decodeUtf8(bytes);
  if (
    (await lstat(file)).isSymbolicLink() ||
    (await realpath(file)) !== canonical
  )
    fail('KNOWNEX_ARTIFACT_UNSAFE_PATH');
  return { path: file, bytes: bytes.length, sha256: sha256(bytes), text };
}
export async function syncPath(file: string) {
  const handle = await open(file, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function syncDirectory(directory: string) {
  const handle = await open(directory, platform() === 'win32' ? 'r+' : 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function stage(file: string, text: string, temporary = dirname(file)) {
  const bytes = utf8Bytes(text),
    temp = join(temporary, randomUUID() + '.tmp');
  let created = false;
  try {
    const handle = await open(temp, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const actual = await readFile(temp);
    if (!actual.equals(bytes)) fail('KNOWNEX_ARTIFACT_WRITE_MISMATCH');
    const identity = await lstat(temp, { bigint: true });
    return {
      temp,
      path: file,
      bytes: actual.length,
      sha256: sha256(actual),
      dev: identity.dev,
      ino: identity.ino,
      published: false,
    };
  } catch (error) {
    if (created)
      await unlink(temp).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    throw error;
  }
}
export async function writeAtomicText(
  file: string,
  text: string,
  temporary = dirname(file),
) {
  const staged = await stage(file, text, temporary);
  try {
    await rename(staged.temp, file);
    await syncPath(file);
    await syncDirectory(dirname(file));
    if (temporary !== dirname(file)) await syncDirectory(temporary);
  } finally {
    await unlink(staged.temp).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}
export async function writeExclusiveFiles(
  entries: { path: string; text: string }[],
) {
  if (new Set(entries.map((e) => resolve(e.path))).size !== entries.length)
    fail('KNOWNEX_ARTIFACT_DUPLICATE_PATH');
  const staged: Awaited<ReturnType<typeof stage>>[] = [];
  try {
    for (const e of entries) {
      if ((await lstat(dirname(e.path))).isSymbolicLink())
        fail('KNOWNEX_ARTIFACT_UNSAFE_PATH');
      staged.push(
        await stage(
          join(await realpath(dirname(e.path)), basename(e.path)),
          e.text,
        ),
      );
    }
    for (const s of staged) {
      // link publishes the complete inode atomically and cannot overwrite an existing target.
      await link(s.temp, s.path);
      s.published = true;
      await syncDirectory(dirname(s.path));
    }
    return staged.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  } catch (error) {
    for (const s of staged.slice().reverse())
      if (s.published) {
        const actual = await lstat(s.path, { bigint: true }).catch((e) => {
          if (e.code !== 'ENOENT') throw e;
          return null;
        });
        if (
          actual &&
          !actual.isSymbolicLink() &&
          actual.dev === s.dev &&
          actual.ino === s.ino
        ) {
          await unlink(s.path);
          await syncDirectory(dirname(s.path));
        }
      }
    throw error;
  } finally {
    for (const s of staged)
      await unlink(s.temp).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
  }
}
