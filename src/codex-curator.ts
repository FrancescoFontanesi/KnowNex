import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decodeUtf8,
  jsonText,
  readArtifact,
  utf8Bytes,
  writeExclusiveFiles,
  writeFile,
} from './artifact-io.ts';

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
const object = (v: unknown): v is Record<string, any> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
export interface CodexWorkerConfig {
  binary: string;
  model: string;
  reasoning: string;
  provider: string;
  auth: 'chatgpt';
}
export interface WorkerInput {
  run: string;
  requestFile: string;
  workspace: string;
}

/** Read-only native RPCs: never starts a model turn or replaces current credentials/provider. */
export async function inspectCodexWorker(
  workspace: string,
  binary = process.env.KNOWNEX_CODEX_BIN || 'codex',
): Promise<CodexWorkerConfig> {
  if (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY)
    fail('CURATOR_WORKER_API_AUTH_UNSUPPORTED');
  const child = spawn(binary, ['app-server', '--stdio'], {
    cwd: workspace,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = Buffer.alloc(0),
    next = 0;
  const pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  const stop = (code: string) => {
    for (const p of pending.values())
      p.reject(Object.assign(new Error(code), { code }));
    pending.clear();
    child.kill();
  };
  child.stderr.resume();
  const closed = new Promise<void>((resolve) =>
    child.once('close', () => resolve()),
  );
  child.on('error', () => stop('CURATOR_WORKER_UNAVAILABLE'));
  child.stdin.on('error', () => stop('CURATOR_WORKER_UNAVAILABLE'));
  child.on('exit', () => stop('CURATOR_WORKER_UNAVAILABLE'));
  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (let end; (end = buffer.indexOf(10)) >= 0;) {
      const line = buffer.subarray(0, end);
      buffer = buffer.subarray(end + 1);
      try {
        const r = JSON.parse(decodeUtf8(line));
        if (pending.has(r.id)) {
          const p = pending.get(r.id)!;
          pending.delete(r.id);
          r.error
            ? p.reject(
                Object.assign(
                  new Error('CURATOR_WORKER_PROTOCOL_UNSUPPORTED'),
                  { code: 'CURATOR_WORKER_PROTOCOL_UNSUPPORTED' },
                ),
              )
            : p.resolve(r.result);
        }
      } catch {
        stop('CURATOR_WORKER_PROTOCOL_UNSUPPORTED');
      }
    }
  });
  const call = (method: string, params: object) =>
    new Promise<any>((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      child.stdin.write(
        utf8Bytes(JSON.stringify({ id, method, params }) + '\n'),
      );
    });
  const timer = setTimeout(() => stop('CURATOR_WORKER_PROBE_TIMEOUT'), 15000);
  try {
    await call('initialize', {
      clientInfo: { name: 'knownex_checkpoint', version: '1' },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write('{"method":"initialized"}\n');
    const account = await call('account/read', { refreshToken: false });
    if (account.account?.type !== 'chatgpt')
      fail('CURATOR_WORKER_AUTH_UNSUPPORTED');
    const { config } = await call('config/read', { includeLayers: false });
    const model = config?.agents?.default_subagent_model,
      reasoning = config?.agents?.default_subagent_reasoning_effort;
    if (
      typeof model !== 'string' ||
      !model ||
      typeof reasoning !== 'string' ||
      !reasoning
    )
      fail('CURATOR_WORKER_MODEL_NOT_CONFIGURED');
    const models = await call('model/list', {}),
      entry = models.data?.find(
        (m: any) => m.model === model || m.id === model,
      );
    if (
      !entry?.supportedReasoningEfforts?.some(
        (r: any) => r.reasoningEffort === reasoning,
      )
    )
      fail('CURATOR_WORKER_MODEL_UNAVAILABLE');
    const servers = await call('mcpServerStatus/list', {}),
      node = servers.data?.find((s: any) => s.name === 'node_repl');
    if (!node?.tools?.js) fail('CURATOR_WORKER_NODE_REPL_UNAVAILABLE');
    if (typeof config.model_provider !== 'string' || !config.model_provider)
      fail('CURATOR_WORKER_PROVIDER_UNAVAILABLE');
    return {
      binary,
      model,
      reasoning,
      provider: config.model_provider,
      auth: 'chatgpt',
    };
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    // EOF lets the ephemeral server shut down its MCP children before forced termination.
    let shutdown: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closed,
      new Promise<void>((resolve) => {
        shutdown = setTimeout(resolve, 1000);
      }),
    ]);
    clearTimeout(shutdown);
    if (child.exitCode === null && child.signalCode === null) child.kill();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}

export function codexCuratorArgs(
  input: WorkerInput,
  config: CodexWorkerConfig,
  schema: string,
) {
  return [
    'exec',
    '--json',
    '--color',
    'never',
    '--model',
    config.model,
    '-c',
    'model_reasoning_effort=' + JSON.stringify(config.reasoning),
    '-c',
    'model_provider=' + JSON.stringify(config.provider),
    '--sandbox',
    'workspace-write',
    '--disable',
    'hooks',
    '--disable',
    'multi_agent',
    '--disable',
    'multi_agent_v2',
    '--skip-git-repo-check',
    '--cd',
    input.run,
    '--output-schema',
    schema,
    '-',
  ];
}
const receiptSchema = {
  type: 'object',
  properties: {
    path: { type: 'string' },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    bytes: { type: 'integer', minimum: 0 },
  },
  required: ['path', 'sha256', 'bytes'],
  additionalProperties: false,
};

/** One native exec, awaited inside Node. The caller never receives worker stdout or semantic documents. */
export async function runCodexCurator(
  input: WorkerInput,
  config: CodexWorkerConfig,
  options: { timeoutMs?: number; prefixArgs?: string[] } = {},
) {
  const schema = join(input.run, 'worker-result-schema.json'),
    events = join(input.run, 'worker-events.jsonl'),
    errors = join(input.run, 'worker-stderr.log');
  await writeExclusiveFiles([
    {
      path: schema,
      text:
        jsonText(
          {
            type: 'object',
            properties: { proposal: receiptSchema, review: receiptSchema },
            required: ['proposal', 'review'],
            additionalProperties: false,
          },
          2,
        ) + '\n',
    },
    { path: events, text: '' },
    { path: errors, text: '' },
  ]);
  const request = await readArtifact(input.requestFile);
  try {
    const references = JSON.parse(
      request.text.split('INPUT_REFERENCES_JSON\n')[1]!,
    );
    const module = new URL(references.io.module);
    if (module.protocol !== 'file:' || !module.pathname.endsWith('.js'))
      throw Error();
    await readArtifact(fileURLToPath(module));
  } catch {
    fail('CURATOR_WORKER_IO_MODULE_UNAVAILABLE');
  }
  // Worker hooks would otherwise ingest its own curation into the user's project feed.
  const prompt =
    request.text +
    '\nYou are the Curator worker, not the checkpoint controller. Write artifacts only through the canonical Node REPL API. Do not call checkpoint/prepare/validate/apply, modify confirmed memory or spawn other agents. Return only the exact proposal/review receipts from the I/O API.\n';
  const startedAt = new Date().toISOString(),
    child = spawn(
      config.binary,
      [
        ...(options.prefixArgs ?? []),
        ...codexCuratorArgs(input, config, schema),
      ],
      { cwd: input.run, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
  let pending = Buffer.alloc(0),
    writes = Promise.resolve(),
    threadId: string | undefined,
    final: string | undefined,
    completed = false,
    failure: string | undefined,
    usage: unknown;
  const stop = (code: string) => {
    failure ??= code;
    child.kill('SIGKILL');
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  };
  const consume = (line: Buffer) => {
    try {
      const value = JSON.parse(decodeUtf8(line));
      if (!object(value)) throw Error();
      if (value.type === 'thread.started') threadId = value.thread_id;
      if (value.type === 'turn.completed') {
        completed = true;
        usage = value.usage;
      }
      if (value.type === 'turn.failed' || value.type === 'error')
        stop('CURATOR_WORKER_FAILED');
      if (
        value.type === 'item.completed' &&
        value.item?.type === 'agent_message'
      )
        final = value.item.text;
    } catch {
      stop('CURATOR_WORKER_OUTPUT_INVALID');
    }
  };
  child.stdout.on('data', (chunk: Buffer) => {
    writes = writes
      .then(() => writeFile(events, chunk, { flag: 'a' }))
      .catch(() => stop('CURATOR_WORKER_IO_FAILED'));
    pending = Buffer.concat([pending, chunk]);
    for (let end; (end = pending.indexOf(10)) >= 0;) {
      consume(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    writes = writes
      .then(() => writeFile(errors, chunk, { flag: 'a' }))
      .catch(() => stop('CURATOR_WORKER_IO_FAILED'));
  });
  child.on('error', () => stop('CURATOR_WORKER_UNAVAILABLE'));
  child.stdin.on('error', () => stop('CURATOR_WORKER_INTERRUPTED'));
  const timer = setTimeout(
    () => stop('CURATOR_WORKER_TIMEOUT'),
    options.timeoutMs ?? 900000,
  );
  let exit: number | null = null;
  try {
    child.stdin.end(utf8Bytes(prompt));
    exit = await new Promise<number | null>((resolve) =>
      child.once('close', resolve),
    );
    await writes;
    if (pending.length) failure ??= 'CURATOR_WORKER_OUTPUT_INCOMPLETE';
    await writeExclusiveFiles([
      {
        path: join(input.run, 'worker.json'),
        text:
          jsonText(
            {
              requestedModel: config.model,
              requestedReasoning: config.reasoning,
              provider: config.provider,
              auth: config.auth,
              threadId,
              usage,
              startedAt,
              endedAt: new Date().toISOString(),
              exit,
              code: failure,
              events,
              stderr: errors,
            },
            2,
          ) + '\n',
      },
    ]);
    if (failure) fail(failure);
    if (exit !== 0) fail('CURATOR_WORKER_FAILED');
    if (!completed || !final) fail('CURATOR_WORKER_OUTPUT_INCOMPLETE');
    try {
      return JSON.parse(final);
    } catch {
      return fail('CURATOR_WORKER_OUTPUT_INVALID');
    }
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  }
}
