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

/** Explicit boundaries allow reading one segment without rewriting earlier history. */
export function historySegments(text: string, through: number) {
  const markers = [
    ...text.matchAll(/^<!-- knownex-history:(H\d+):(begin|end) -->$/gm),
  ];
  if (
    (text.match(/knownex-history:/g) ?? []).length !== markers.length ||
    markers.length % 2
  )
    fail();
  const segments: { id: string; from: number; through: number }[] = [];
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
    for (const label of ['Fonte', 'Argomenti', 'Descrizione', 'Transizione'])
      if (!new RegExp('^- ' + label + ': .+$', 'm').test(body)) fail();
    segments.push({ id, from, through: to });
  }
  return segments;
}

export function historyAppendix(
  history: string,
  state: string,
  from: number,
  through: number,
  date: string,
  source: string,
  details: Transition,
) {
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
  const id = identifier(historySegments(history, through).length + 1);
  const event = (n: number) => 'E' + String(n).padStart(3, '0');
  return (
    `${history.endsWith('\n') ? '\n' : '\n\n'}<!-- knownex-history:${id}:begin -->\n## ${id}\n\n` +
    `- Data: \`${date}\`\n- Eventi: \`${event(from)}..${event(through)}\`\n` +
    `- Fonte: [${event(from)}–${event(through)}](${source})\n` +
    `- Argomenti: ${details.topics.join('; ')}\n- Descrizione: ${details.summary}\n` +
    `- Transizione: ${details.transition}\n\n### STATE precedente\n\n` +
    state
      .split('\n')
      .map((line) => '> ' + line)
      .join('\n') +
    `\n<!-- knownex-history:${id}:end -->\n`
  );
}
