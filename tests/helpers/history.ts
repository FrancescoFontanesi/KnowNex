import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { historyWindow, type Transition } from '../../src/curation/history.ts';

/**
 * Appends one checkpoint to a standalone memory as the runtime writes it: the index line goes
 * into the returned HISTORY text, the window into memory/history/. Returns both.
 */
export async function appendHistory(
  memory: string,
  history: string,
  state: string,
  from: number,
  through: number,
  date: string,
  details: Transition,
) {
  const entry = historyWindow(history, from, through, date, details, [], state);
  await mkdir(join(memory, 'history'), { recursive: true });
  await writeFile(join(memory, entry.name), entry.text);
  return { history: history + entry.index, ...entry };
}
