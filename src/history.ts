export interface Transition {
  summary: string;
  topics: string[];
  transition: string;
}

const fail = (): never => {
  throw Object.assign(new Error('CURATOR_HISTORY_INVALID'), {
    code: 'CURATOR_HISTORY_INVALID',
  });
};
const identifier = (n: number) => 'H' + String(n).padStart(6, '0');
const event = (n: number) => 'E' + String(n).padStart(3, '0');
const indexLine =
  /^- \[(H\d{6,})\]\(history\/(H\d{6,})\.md\) · `([^`]+)` · `E(\d{3,})\.\.E(\d{3,})` · .+$/;

export interface HistorySegment {
  id: string;
  from: number;
  through: number;
  /** Window file of an indexed segment; absent for inline segments written before windows. */
  window?: string;
}

/**
 * HISTORY.md holds inline segments (older format, explicit boundaries) followed by one index
 * line per later checkpoint, whose detail lives in an immutable history/H000000.md window.
 */
export function historySegments(text: string, through: number) {
  const markers = [
    ...text.matchAll(/^<!-- knownex-history:(H\d+):(begin|end) -->$/gm),
  ];
  if (
    (text.match(/knownex-history:/g) ?? []).length !== markers.length ||
    markers.length % 2
  )
    fail();
  const segments: HistorySegment[] = [];
  for (let i = 0; i < markers.length; i += 2) {
    const start = markers[i]!,
      end = markers[i + 1]!;
    const id = identifier(segments.length + 1);
    if (
      start[1] !== id ||
      end[1] !== id ||
      start[2] !== 'begin' ||
      end[2] !== 'end'
    )
      fail();
    const body = text.slice(start.index! + start[0].length, end.index);
    const range = body.match(/^- Eventi: `E(\d+)\.\.E(\d+)`$/m);
    const date = body.match(/^- Data: `([^`]+)`$/m)?.[1];
    const from = Number(range?.[1]),
      to = Number(range?.[2]);
    if (
      !range ||
      !Number.isSafeInteger(from) ||
      from < 1 ||
      to < from ||
      to > through ||
      (segments.length && from <= segments.at(-1)!.through) ||
      !date ||
      !Number.isFinite(Date.parse(date)) ||
      !body.includes(`\n## ${id}\n`) ||
      !body.includes('\n### STATE precedente\n\n> ')
    )
      fail();
    // Fonte (a feed link) only exists in segments written before provenance became a label.
    for (const label of ['Argomenti', 'Descrizione', 'Transizione'])
      if (!new RegExp('^- ' + label + ': .+$', 'm').test(body)) fail();
    segments.push({ id, from, through: to });
  }
  const last = markers.at(-1);
  const tail = last ? text.slice(last.index! + last[0].length) : text;
  for (const [line] of tail.matchAll(/^- \[H.*$/gm)) {
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
      fail();
    segments.push({ id, from, through: to, window: `history/${id}.md` });
  }
  return segments;
}

function checkDetails(details: Transition) {
  if (
    !details ||
    typeof details.summary !== 'string' ||
    typeof details.transition !== 'string' ||
    !Array.isArray(details.topics) ||
    !details.topics.length ||
    [details.summary, details.transition, ...details.topics].some(
      (s) =>
        typeof s !== 'string' || !s.trim() || /[\r\n]|knownex-history:/.test(s),
    )
  )
    fail();
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
  const id = identifier(historySegments(history, through).length + 1),
    name = `history/${id}.md`,
    range = `${event(from)}..${event(through)}`,
    topics = details.topics.join('; ');
  return {
    name,
    index:
      (history.endsWith('\n') ? '' : '\n') +
      `- [${id}](${name}) · \`${date}\` · \`${range}\` · ${topics} — ${details.summary}\n`,
    text:
      `# ${id} — ${topics}\n\n- Data: \`${date}\`\n- Eventi: \`${range}\`\n` +
      `- Argomenti: ${topics}\n- Descrizione: ${details.summary}\n` +
      `- Transizione: ${details.transition}\n\n## Note scritte\n\n` +
      (notes.length
        ? notes.map(([label, href]) => `- [${label}](${href})`).join('\n')
        : '- nessuna') +
      `\n\n## STATE risultante\n\n${state}`,
  };
}
