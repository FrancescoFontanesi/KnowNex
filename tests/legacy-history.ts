import { historySegments, type Transition } from '../src/history.ts';

const pad = (prefix: string, n: number, width: number) =>
  prefix + String(n).padStart(width, '0');

/**
 * Inline HISTORY segment in the format written before history windows. Production only
 * reads it now; tests build it to check that older memories stay readable.
 */
export function historyAppendix(
  history: string,
  state: string,
  from: number,
  through: number,
  date: string,
  details: Transition,
) {
  const id = pad('H', historySegments(history, through).length + 1, 6);
  return (
    `${history.endsWith('\n') ? '\n' : '\n\n'}<!-- knownex-history:${id}:begin -->\n## ${id}\n\n` +
    `- Data: \`${date}\`\n- Eventi: \`${pad('E', from, 3)}..${pad('E', through, 3)}\`\n` +
    `- Argomenti: ${details.topics.join('; ')}\n- Descrizione: ${details.summary}\n` +
    `- Transizione: ${details.transition}\n\n### STATE precedente\n\n` +
    state
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n') +
    `\n<!-- knownex-history:${id}:end -->\n`
  );
}
