import { randomUUID } from 'node:crypto';
import { link, open, readFile, unlink, writeFile } from 'node:fs/promises';

interface Owner {
  pid: number;
  token: string;
}

function code(error: unknown): string | undefined {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

function lockError(value: string): Error & { code: string } {
  return Object.assign(new Error(value), { code: value });
}

async function owner(path: string): Promise<Owner> {
  const text = await readFile(path, 'utf8');
  try {
    const value = JSON.parse(text);
    if (
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(value.token)
    )
      throw new Error();
    return { pid: value.pid, token: value.token };
  } catch {
    throw lockError('LOCK_CORRUPT');
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return code(error) !== 'ESRCH';
  }
}

/**
 * Publish immutable ownership with an atomic hard link: no empty lock is visible.
 * A generation-specific recovery gate prevents two reapers deleting a new lock.
 * A crash during recovery leaves the gate for explicit inspection, never steals
 * a live lock. PID reuse is treated conservatively as busy.
 */
export async function acquireJournalLock(
  path: string,
): Promise<() => Promise<void>> {
  const mine: Owner = { pid: process.pid, token: randomUUID() };
  const candidate = `${path}.${mine.token}.tmp`;
  await writeFile(candidate, JSON.stringify(mine), { flag: 'wx', mode: 0o600 });
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(candidate, path);
        acquired = true;
        break;
      } catch (error) {
        if (code(error) !== 'EEXIST') throw error;
      }
      let previous: Owner;
      try {
        previous = await owner(path);
      } catch (error) {
        if (code(error) === 'ENOENT') continue;
        throw error;
      }
      if (alive(previous.pid)) throw lockError('DESTINATION_BUSY');
      const gatePath = `${path}.reap-${previous.token}`;
      let gate;
      try {
        gate = await open(gatePath, 'wx', 0o600);
      } catch (error) {
        if (code(error) === 'EEXIST') throw lockError('DESTINATION_BUSY');
        throw error;
      }
      try {
        try {
          const current = await owner(path);
          if (current.token === previous.token && !alive(current.pid))
            await unlink(path);
        } catch (error) {
          if (code(error) !== 'ENOENT') throw error;
        }
      } finally {
        await gate.close();
        await unlink(gatePath);
      }
    }
    if (!acquired) throw lockError('DESTINATION_BUSY');
  } finally {
    await unlink(candidate);
  }
  return async () => {
    if ((await owner(path)).token !== mine.token)
      throw lockError('LOCK_CHANGED');
    await unlink(path);
  };
}
