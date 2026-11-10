import { readFile } from 'node:fs/promises';
import { measureRuntime } from '../scripts/measure.ts';

const fail = (message) => {
  throw new Error(message);
};
const sum = (values) => {
  if (!values.length || values.some((v) => typeof v !== 'number')) return null;
  const total = values.reduce((a, b) => a + b, 0);
  if (!Number.isSafeInteger(total)) fail('METRIC_OVERFLOW');
  return total;
};
export const statuses = [
  'completed',
  'failed',
  'timeout',
  'policy_blocked',
  'interrupted',
];
export const phases = ['creation', 'consultation', 'other'];
const fields = [
  'input_tokens',
  'cached_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
  'cache_write_input_tokens',
  'total_tokens',
];

export function totals(turns) {
  const result = Object.fromEntries(
    fields.map((key) => [key, sum(turns.map((t) => t.usage?.[key] ?? null))]),
  );
  result.uncached_input_tokens =
    result.input_tokens !== null && result.cached_input_tokens !== null
      ? result.input_tokens - result.cached_input_tokens
      : null;
  return {
    ...result,
    modelResponses: sum(turns.map((t) => t.modelResponses)),
    coverage:
      turns.length && turns.every((t) => t.coverage === 'complete')
        ? 'complete'
        : turns.length
          ? 'partial'
          : 'unavailable',
  };
}
export function unionMs(intervals) {
  if (!intervals.length) return null;
  const ordered = intervals
    .map(([a, b]) => [Date.parse(a), Date.parse(b)])
    .sort((a, b) => a[0] - b[0]);
  if (
    ordered.some(
      ([a, b]) => !Number.isFinite(a) || !Number.isFinite(b) || b < a,
    )
  )
    fail('INVALID_INTERVAL');
  let total = 0,
    [start, end] = ordered[0];
  for (const [a, b] of ordered.slice(1)) {
    if (a > end) {
      total += end - start;
      start = a;
    }
    end = Math.max(end, b);
  }
  return total + end - start;
}
function commandOf(call) {
  // Orchestrator JavaScript is opaque: never eval it or count mentions as commands.
  if (!/(^|[._])exec_command$/.test(call.name ?? '')) return null;
  try {
    const args =
      typeof call.arguments === 'string'
        ? JSON.parse(call.arguments)
        : call.arguments;
    return typeof args?.cmd === 'string' ? args.cmd : null;
  } catch {
    return null;
  }
}
export function navigation(command) {
  if (!command || /[\r\n;|&<>`]/.test(command)) return null;
  const m = command.match(
    /^(?:npm(?:\.cmd)? exec --offline -- knownex|knownex|node "?[^"\r\n]*[\\/]dist[\\/]index\.js"?) memory (state|find|read|category)(?:\s+(.*))?$/,
  );
  if (!m) return null;
  const target = (m[2] ?? '').match(/^("[^"]*"|'[^']*'|\S+)/)?.[0] ?? null;
  return {
    operation: m[1],
    target,
    document:
      m[1] === 'state'
        ? 'STATE'
        : m[1] === 'category'
          ? 'taxonomy'
          : target?.replaceAll('"', '').startsWith('H')
            ? 'HISTORY'
            : target?.includes('kn-') || target?.includes('knowledge/')
              ? 'Knowledge'
              : 'unknown',
  };
}

export async function nativeMetrics(file, spec, expected) {
  if (
    !spec.threadId ||
    !['principal', 'curator', 'other'].includes(spec.role) ||
    !Array.isArray(spec.turns) ||
    !spec.turns.length
  )
    fail('TRACE_SCOPE_REQUIRED');
  if (
    new Set(spec.turns.map((t) => t.id)).size !== spec.turns.length ||
    spec.turns.some(
      (t) =>
        !t.id || !phases.includes(t.phase) || typeof t.operation !== 'string',
    )
  )
    fail('TURN_SCOPE_INVALID');
  const bytes = await readFile(file),
    end = bytes.lastIndexOf(10) + 1;
  const rows = new TextDecoder('utf-8', { fatal: true })
    .decode(bytes.subarray(0, end))
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const meta = rows.find((r) => r.type === 'session_meta')?.payload;
  if (meta?.id !== spec.threadId) fail('TRACE_ID_MISMATCH');
  const selected = new Map(spec.turns.map((t) => [t.id, t]));
  const items = [],
    contexts = [],
    calls = new Map(),
    outputs = new Map(),
    events = [];
  let current = null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i],
      p = row.payload;
    if (row.type === 'turn_context') {
      current = p?.turn_id;
      contexts.push(p);
    }
    if (row.type === 'event_msg' && p?.type === 'task_started')
      current = p.turn_id;
    if (row.type === 'event_msg' && selected.has(p?.turn_id))
      events.push({ line: i + 1, ...row });
    if (row.type !== 'response_item' || !selected.has(current)) continue;
    const item = {
      line: i + 1,
      turnId: current,
      timestamp: row.timestamp,
      ...p,
    };
    items.push(item);
    if (['function_call', 'custom_tool_call'].includes(p?.type)) {
      if (!p.call_id) fail('TOOL_ID_MISSING');
      const prior = calls.get(p.call_id);
      if (
        prior &&
        (JSON.stringify(prior.payload) !== JSON.stringify(p) ||
          prior.item.turnId !== current)
      )
        fail('TOOL_ID_CONFLICT');
      calls.set(p.call_id, prior ?? { payload: p, item });
    }
    if (['function_call_output', 'custom_tool_call_output'].includes(p?.type)) {
      if (!p.call_id) fail('TOOL_ID_MISSING');
      const prior = outputs.get(p.call_id);
      if (prior && JSON.stringify(prior.payload) !== JSON.stringify(p))
        fail('TOOL_OUTPUT_CONFLICT');
      outputs.set(p.call_id, prior ?? { payload: p, item });
    }
  }
  const turns = [];
  for (const scope of spec.turns) {
    const measured = await measureRuntime(file, scope.id);
    const actual = contexts.filter((c) => c.turn_id === scope.id);
    const modelMatch =
      actual.length > 0 &&
      actual.every(
        (c) => c.model === expected.model && c.effort === expected.reasoning,
      );
    if (measured.threads.some((t) => t !== spec.threadId))
      fail('USAGE_THREAD_MISMATCH');
    const start = events.find(
      (r) =>
        r.payload.type === 'task_started' && r.payload.turn_id === scope.id,
    );
    const finish = events.findLast(
      (r) =>
        r.payload.type === 'task_complete' && r.payload.turn_id === scope.id,
    );
    const startedAt =
      typeof start?.timestamp === 'string' &&
      Number.isFinite(Date.parse(start.timestamp))
        ? start.timestamp
        : null;
    const endedAt =
      typeof finish?.timestamp === 'string' &&
      Number.isFinite(Date.parse(finish.timestamp))
        ? finish.timestamp
        : null;
    const validClock =
      startedAt && endedAt && Date.parse(endedAt) >= Date.parse(startedAt);
    turns.push({
      ...scope,
      role: spec.role,
      threadId: spec.threadId,
      coverage: measured.coverage,
      usage: measured.totals,
      modelResponses: measured.modelResponses,
      duplicates: measured.duplicates,
      modelMatch,
      actualContexts: actual,
      startedAt: validClock ? startedAt : null,
      endedAt: validClock ? endedAt : null,
      wallMs: validClock ? unionMs([[startedAt, endedAt]]) : null,
      usageLines: measured.records,
    });
  }
  const tools = [...calls.values()].map(({ payload, item }) => {
    const output = outputs.get(payload.call_id)?.item,
      command = commandOf(payload),
      nav = navigation(command);
    const elapsed =
      item.timestamp && output?.timestamp
        ? Date.parse(output.timestamp) - Date.parse(item.timestamp)
        : null;
    return {
      callId: payload.call_id,
      name: payload.name ?? 'unknown',
      turnId: item.turnId,
      line: item.line,
      outputLine: output?.line ?? null,
      command,
      navigation: nav,
      latencyMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
      serializedOutputUtf8Bytes:
        output && Object.hasOwn(output, 'output')
          ? Buffer.byteLength(
              typeof output.output === 'string'
                ? output.output
                : JSON.stringify(output.output ?? null),
            )
          : null,
      modelDeliveredBytes: null,
    };
  });
  return {
    threadId: spec.threadId,
    role: spec.role,
    roleAttribution:
      'observer declaration; native identity verified, semantic purpose not inferred',
    nativeSource: meta.source ?? null,
    nativeSessionMeta: meta,
    turns,
    tools,
    trailingBytes: bytes.length - end,
    events,
    unscopedResponseItems:
      rows.filter((r) => r.type === 'response_item').length - items.length,
  };
}

export function aggregate(traces) {
  const turns = traces.flatMap((t) =>
      t.turns.map((turn) => ({ ...turn, evidenceFile: t.file })),
    ),
    tools = traces.flatMap((t) =>
      t.tools.map((tool) => ({
        ...tool,
        threadId: t.threadId,
        evidenceFile: t.file,
      })),
    ),
    byType = {};
  for (const tool of tools) byType[tool.name] = (byType[tool.name] ?? 0) + 1;
  const nav = tools.filter((t) => t.navigation),
    seen = new Set();
  let rereads = 0;
  for (const t of nav.filter((t) =>
    ['read', 'state'].includes(t.navigation.operation),
  )) {
    const key = JSON.stringify(t.navigation);
    if (seen.has(key)) rereads++;
    seen.add(key);
  }
  const grouped = (key, values) =>
    Object.fromEntries(
      values.map((value) => [
        value,
        totals(turns.filter((t) => t[key] === value)),
      ]),
    );
  return {
    tokens: totals(turns),
    byRole: grouped('role', ['principal', 'curator', 'other']),
    bySession: grouped('threadId', [...new Set(turns.map((t) => t.threadId))]),
    byPhase: grouped('phase', phases),
    byOperation: grouped('operation', [
      ...new Set(turns.map((t) => t.operation)),
    ]),
    turns,
    toolCalls: traces.length ? tools.length : null,
    toolCallsByType: byType,
    tools,
    recognizedNavigationCalls: traces.length ? nav.length : null,
    navigationCoverage: !traces.length
      ? 'unavailable'
      : tools.every((t) => t.command !== null)
        ? 'direct-shell-only; other direct tools may also read memory'
        : 'partial; opaque calls not interpreted',
    recognizedExactRereads: traces.length ? rereads : null,
    serializedToolOutputBytes: sum(
      tools.map((t) => t.serializedOutputUtf8Bytes),
    ),
    recognizedNavigationLatencyMs: sum(nav.map((t) => t.latencyMs)),
    activeTurnUnionMs:
      turns.length && turns.every((t) => t.startedAt && t.endedAt)
        ? unionMs(turns.map((t) => [t.startedAt, t.endedAt]))
        : null,
    byPhaseWallMs: Object.fromEntries(
      phases.map((phase) => {
        const selected = turns.filter((t) => t.phase === phase);
        return [
          phase,
          selected.length && selected.every((t) => t.startedAt && t.endedAt)
            ? unionMs(selected.map((t) => [t.startedAt, t.endedAt]))
            : null,
        ];
      }),
    ),
    missing: {
      modelDeliveredTokens: 'not observable from local trace export',
      modelDeliveredBytes: null,
      actualBackendNavigationTime: null,
      automaticMs: null,
      humanWaitMs: null,
      coldStartMs: null,
      monetaryCost: null,
      curatorDelegations:
        'requires explicit verified child trace mapping; tool mentions are not delegations',
      failedSearches: null,
      injectedStateReads: null,
      retriesAndCorrections:
        'not inferred from counter differences; inspect native events and explicit review evidence',
    },
  };
}
