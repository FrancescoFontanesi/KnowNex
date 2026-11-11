import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const sha256 = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const decode = (bytes: Buffer) =>
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const fingerprint = (bytes: Buffer) => ({
  bytes: bytes.length,
  sha256: sha256(bytes),
});
function fail(code: string): never {
  throw new Error(code);
}

export async function measureContext(run: string) {
  const files: Record<string, Buffer> = {};
  for (const name of [
    'packet.json',
    'WINDOW.md',
    'SKILL.md',
    'inputs.json',
    'MEMORY-CONTRACT.md',
  ])
    try {
      files[name] = await readFile(join(run, name));
    } catch (e) {
      // inputs.json is absent in legacy runs; MEMORY-CONTRACT.md only exists in them.
      if (
        (e as NodeJS.ErrnoException).code !== 'ENOENT' ||
        !['inputs.json', 'MEMORY-CONTRACT.md'].includes(name)
      )
        throw e;
    }
  const packet = JSON.parse(decode(files['packet.json']!));
  if (
    !Number.isSafeInteger(packet.from) ||
    !Number.isSafeInteger(packet.through) ||
    packet.from < 1 ||
    packet.through < packet.from ||
    !Array.isArray(packet.events) ||
    packet.events.length !== packet.through - packet.from + 1 ||
    !packet.context ||
    typeof packet.context['STATE.md'] !== 'string' ||
    typeof packet.directive !== 'string'
  )
    fail('MEASUREMENT_PACKET_INVALID');
  const contexts: Record<string, { bytes: number; sha256: string }> = {};
  for (const [name, text] of Object.entries(packet.context)) {
    if (typeof text !== 'string') fail('MEASUREMENT_PACKET_INVALID');
    contexts[name] = fingerprint(Buffer.from(text));
  }
  let pendingTextBytes = 0;
  for (const event of packet.events) {
    if (typeof event.text !== 'string') fail('MEASUREMENT_PACKET_INVALID');
    pendingTextBytes += Buffer.byteLength(event.text);
  }
  return {
    version: 1,
    kind: 'prepared_context',
    run: resolve(run),
    from: packet.from,
    through: packet.through,
    events: packet.events.length,
    pendingTextBytes,
    directiveTextBytes: Buffer.byteLength(packet.directive),
    stateTextBytes: contexts['STATE.md']!.bytes,
    knowledgeTextBytes: Object.entries(contexts)
      .filter(([n]) => n.startsWith('knowledge/'))
      .reduce((sum, [, v]) => sum + v.bytes, 0),
    contextTextBytes: Object.values(contexts).reduce(
      (sum, v) => sum + v.bytes,
      0,
    ),
    contexts,
    files: Object.fromEntries(
      Object.entries(files).map(([n, b]) => [n, fingerprint(b)]),
    ),
    delivery: 'prepared; reading and model delivery require separate evidence',
  };
}

const required = ['input_tokens', 'output_tokens', 'total_tokens'] as const;
const optional = [
  'cached_input_tokens',
  'cache_write_input_tokens',
  'reasoning_output_tokens',
] as const;
const fields = [...required, ...optional];
type Usage = Record<(typeof fields)[number], number | null>;
function usage(value: unknown): Usage {
  if (!value || typeof value !== 'object') fail('MEASUREMENT_USAGE_INVALID');
  const raw = value as Record<string, unknown>;
  const result = {} as Usage;
  for (const field of fields) {
    const n = raw[field];
    if (
      n === undefined &&
      optional.includes(field as (typeof optional)[number])
    )
      result[field] = null;
    else if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
      result[field] = n;
    else fail('MEASUREMENT_USAGE_INVALID');
  }
  if (
    result.total_tokens !== result.input_tokens! + result.output_tokens! ||
    (result.cached_input_tokens ?? 0) > result.input_tokens! ||
    (result.reasoning_output_tokens ?? 0) > result.output_tokens!
  )
    fail('MEASUREMENT_USAGE_INVALID');
  return result;
}

export async function measureRuntime(source: string, turn: string) {
  const bytes = await readFile(source),
    end = bytes.lastIndexOf(10) + 1;
  const responses = new Map<string, Usage>(),
    signatures = new Map<string, string>(),
    threads = new Set<string>();
  let started = false,
    completed = false,
    duplicates = 0;
  let last: Usage | null = null;
  const records: { line: number; responseId: string }[] = [];
  const lines = decode(bytes.subarray(0, end)).split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const row = JSON.parse(lines[i]!);
    const p = row.payload;
    if (row.type === 'event_msg' && p?.turn_id === turn) {
      if (p.type === 'task_started') started = true;
      if (p.type === 'task_complete') completed = true;
    }
    // token_count mirrors cumulative counters; never add it to per-response usage.
    if (row.type !== 'token_usage_record' || p?.turn_id !== turn) continue;
    if (typeof p.response_id !== 'string' || typeof p.thread_id !== 'string')
      fail('MEASUREMENT_USAGE_INVALID');
    const current = usage(p.usage),
      cumulative = p.turn_token_usage ? usage(p.turn_token_usage) : null;
    const signature = JSON.stringify({
      thread: p.thread_id,
      current,
      cumulative,
    });
    const previous = responses.get(p.response_id);
    if (previous) {
      if (signatures.get(p.response_id) !== signature)
        fail('MEASUREMENT_USAGE_CONFLICT');
      duplicates++;
      continue;
    }
    responses.set(p.response_id, current);
    signatures.set(p.response_id, signature);
    threads.add(p.thread_id);
    records.push({ line: i + 1, responseId: p.response_id });
    last = cumulative;
  }
  const totals = responses.size
    ? (Object.fromEntries(
        fields.map((field) => [
          field,
          [...responses.values()].some((v) => v[field] === null)
            ? null
            : [...responses.values()].reduce((sum, v) => sum + v[field]!, 0),
        ]),
      ) as Usage)
    : null;
  if (
    totals &&
    fields.some((f) => totals[f] !== null && !Number.isSafeInteger(totals[f]))
  )
    fail('MEASUREMENT_USAGE_INVALID');
  const countersMatch =
    !!totals && !!last && required.every((f) => totals[f] === last[f]);
  return {
    version: 1,
    kind: 'runtime_usage',
    source: resolve(source),
    sourceFingerprint: fingerprint(bytes),
    turn,
    threads: [...threads],
    available: !!totals,
    coverage: !totals
      ? 'unavailable'
      : started &&
          completed &&
          countersMatch &&
          threads.size === 1 &&
          end === bytes.length
        ? 'complete'
        : 'partial',
    started,
    completed,
    trailingBytes: bytes.length - end,
    countersMatch,
    modelResponses: totals ? responses.size : null,
    duplicates,
    records,
    totals,
    monetaryCost: null,
  };
}

async function measureTool(log: string, command: string, args: string[]) {
  const result = spawnSync(command, args, {
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? Buffer.alloc(0),
    stderr = result.stderr ?? Buffer.alloc(0);
  const record = {
    version: 1,
    kind: 'command',
    id: randomUUID(),
    capturedAt: new Date().toISOString(),
    argv: [command, ...args],
    exitCode: result.status,
    signal: result.signal,
    complete: !result.error,
    spawnError: result.error
      ? ((result.error as NodeJS.ErrnoException).code ?? 'UNKNOWN')
      : null,
    stdout: fingerprint(stdout),
    stderr: fingerprint(stderr),
  };
  await appendFile(log, JSON.stringify(record) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  return result.status ?? 1;
}

async function main(args: string[]) {
  const mode = args.shift();
  if (mode === 'tool') {
    const { values, positionals } = parseArgs({
      args,
      allowPositionals: true,
      options: { log: { type: 'string' } },
    });
    if (!values.log || !positionals[0]) fail('MEASUREMENT_ARGUMENTS');
    return measureTool(values.log, positionals[0], positionals.slice(1));
  }
  const { values } = parseArgs({
    args,
    options: {
      run: { type: 'string' },
      source: { type: 'string' },
      turn: { type: 'string' },
      output: { type: 'string' },
    },
  });
  const result =
    mode === 'context' && values.run
      ? await measureContext(values.run)
      : mode === 'runtime' && values.source && values.turn
        ? await measureRuntime(values.source, values.turn)
        : fail('MEASUREMENT_ARGUMENTS');
  const text = JSON.stringify(result, null, 2) + '\n';
  if (values.output)
    await writeFile(values.output, text, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  process.stdout.write(text);
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    const code =
      error instanceof Error && /^MEASUREMENT_[A-Z_]+$/.test(error.message)
        ? error.message
        : 'MEASUREMENT_FAILED';
    process.stderr.write(JSON.stringify({ status: 'error', code }) + '\n');
    process.exitCode = 1;
  }
}
