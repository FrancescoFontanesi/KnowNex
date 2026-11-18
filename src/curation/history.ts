import { fail } from '../shared/check.ts';
export interface Transition {
  summary: string;
  topics: string[];
  transition: string;
}

const identifier = (n: number) => 'H' + String(n).padStart(6, '0');
const event = (n: number) => 'E' + String(n).padStart(3, '0');
const indexLine =
  /^- \[(H\d{6,})\]\(history\/(H\d{6,})\.md\) · `([^`]+)` · `E(\d{3,})\.\.E(\d{3,})` · .+$/;

/** HISTORY.md holds one index line per checkpoint; its detail lives in history/H000000.md. */
export function historySegments(text: string, through: number) {
  const segments: {
    id: string;
    from: number;
    through: number;
    window: string;
  }[] = [];
  for (const [line] of text.matchAll(/^- \[H.*$/gm)) {
    const m = indexLine.exec(line),
      id = identifier(segments.length + 1);
    const from = Number(m?.[4]),
      to = Number(m?.[5]);
    if (
      !m ||
      m[1] !== id ||
      m[2] !== id ||
      event(from) !== 'E' + m[4] ||
      event(to) !== 'E' + m[5] ||
      from < 1 ||
      to < from ||
      to > through ||
      (segments.length && from <= segments.at(-1)!.through) ||
      !Number.isFinite(Date.parse(m[3]!))
    )
      fail('CURATOR_HISTORY_INVALID');
    segments.push({ id, from, through: to, window: `history/${id}.md` });
  }
  return segments;
}

/** The HISTORY id the next checkpoint will get; its Knowledge folder uses the same id. */
export const nextHistoryId = (history: string, through: number) =>
  identifier(historySegments(history, through).length + 1);

function checkDetails(details: Transition) {
  if (
    !details ||
    typeof details.summary !== 'string' ||
    typeof details.transition !== 'string' ||
    !Array.isArray(details.topics) ||
    !details.topics.length ||
    [details.summary, details.transition, ...details.topics].some(
      (s) => typeof s !== 'string' || !s.trim() || /[\r\n]/.test(s),
    )
  )
    fail('CURATOR_HISTORY_INVALID');
}

/**
 * One checkpoint as an index line plus a window. The window is self-contained: metadata,
 * the revisions written by that checkpoint and the STATE it produced. Links in `notes`,
 * `transition` and `state` must already be relative to the history/ directory.
 */
export function historyWindow(
  history: string,
  from: number,
  through: number,
  date: string,
  details: Transition,
  notes: [label: string, href: string][],
  state: string,
) {
  checkDetails(details);
  const id = nextHistoryId(history, through),
    name = `history/${id}.md`,
    range = `${event(from)}..${event(through)}`,
    topics = details.topics.join('; ');
  return {
    name,
    index:
      (history.endsWith('\n') ? '' : '\n') +
      `- [${id}](${name}) · \`${date}\` · \`${range}\` · ${topics} — ${details.summary}\n`,
    text:
      `# ${id} — ${topics}\n\n- Date: \`${date}\`\n- Events: \`${range}\`\n` +
      `- Topics: ${topics}\n- Description: ${details.summary}\n` +
      `- Transition: ${details.transition}\n\n## Notes written\n\n` +
      (notes.length
        ? notes.map(([label, href]) => `- [${label}](${href})`).join('\n')
        : '- none') +
      `\n\n## Resulting STATE\n\n${state}`,
  };
}
