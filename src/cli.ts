import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { syncSession, CaptureError } from './capture.ts';
import { ReaderError } from './reader.ts';
import { memoryState, memoryFind, memoryRead } from './navigator.ts';
import type { MemoryScope } from './navigator.ts';
import { initWorkspace } from './bootstrap.ts';
import {
  runtimeStatus,
  workspaceDirectory,
  requestCheckpoint,
  runtimePending,
} from './runtime.ts';

const syncUsage = 'Usage: knownex sync --source <jsonl> --destination <file>';
const memoryUsage = [
  'Usage: knownex memory state [--memory <directory>]',
  '       knownex memory find "<query>" [--type history|knowledge] [--memory <directory>]',
  '       knownex memory read <id> [--memory <directory>]',
].join('\n');
const initUsage = 'Usage: knownex init [--workspace <directory>]';
const usage =
  syncUsage +
  '\n' +
  initUsage +
  '\nUsage: knownex runtime\nUsage: knownex checkpoint [--milestone <key>]' +
  '\nUsage: knownex pending [--workspace <directory>] [--from <sequence> --through <sequence> | --cursor <token>] [--limit <1..20>]' +
  '\n' +
  memoryUsage +
  '\n       knownex curate <init|request|prepare|validate|apply|abandon> [options]';

class UsageError extends Error {}

function parseCommand(args: string[]) {
  try {
    if (args[0] !== 'sync') throw new UsageError();
    const { values, tokens } = parseArgs({
      args: args.slice(1),
      options: { source: { type: 'string' }, destination: { type: 'string' } },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
    if (
      tokens.filter((token) => token.kind === 'option').length !== 2 ||
      !values.source?.trim() ||
      !values.destination?.trim() ||
      values.source.includes('\0') ||
      values.destination.includes('\0')
    )
      throw new UsageError();
    return {
      source: resolve(values.source),
      destination: resolve(values.destination),
    };
  } catch {
    throw new UsageError();
  }
}

async function main(args: string[]) {
  if (
    args.length === 0 ||
    (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) ||
    (args.length === 2 &&
      ['sync', 'memory', 'init', 'checkpoint', 'pending'].includes(args[0]!) &&
      args[1] === '--help') ||
    (args.length === 3 &&
      args[0] === 'memory' &&
      ['state', 'find', 'read'].includes(args[1]!) &&
      args[2] === '--help')
  ) {
    console.log(
      args[0] === 'sync'
        ? syncUsage
        : args[0] === 'memory'
          ? memoryUsage
          : args[0] === 'init'
            ? initUsage
            : usage,
    );
    return;
  }
  if (args[0] === 'pending') {
    let values: Record<string, string | undefined>;
    try {
      const parsed = parseArgs({
        args: args.slice(1),
        tokens: true,
        options: Object.fromEntries(
          ['workspace', 'from', 'through', 'limit', 'cursor'].map((name) => [
            name,
            { type: 'string' as const },
          ]),
        ),
      });
      const names = parsed.tokens
        .filter((t) => t.kind === 'option')
        .map((t) => t.name);
      values = parsed.values;
      if (
        new Set(names).size !== names.length ||
        Object.values(values).some((v) => !v?.trim() || v.includes('\0')) ||
        ['from', 'through', 'limit'].some(
          (name) => values[name] !== undefined && !/^\d+$/.test(values[name]!),
        )
      )
        throw new UsageError();
    } catch {
      throw new UsageError();
    }
    console.log(
      JSON.stringify(
        await runtimePending(values.workspace ?? workspaceDirectory(), {
          from: values.from === undefined ? undefined : Number(values.from),
          through:
            values.through === undefined ? undefined : Number(values.through),
          limit: values.limit === undefined ? undefined : Number(values.limit),
          cursor: values.cursor,
        }),
      ),
    );
    return;
  }
  if (args[0] === 'checkpoint') {
    let milestone: string | undefined;
    try {
      const { values, tokens } = parseArgs({
        args: args.slice(1),
        options: { milestone: { type: 'string' } },
        tokens: true,
      });
      if (
        tokens.length > 1 ||
        (values.milestone !== undefined && !values.milestone.trim())
      )
        throw new UsageError();
      milestone = values.milestone;
    } catch {
      throw new UsageError();
    }
    console.log(
      JSON.stringify(await requestCheckpoint(workspaceDirectory(), milestone)),
    );
    return;
  }
  if (args[0] === 'runtime') {
    if (args.length !== 1) throw new UsageError();
    console.log(JSON.stringify(await runtimeStatus(workspaceDirectory())));
    return;
  }
  if (args[0] === 'init') {
    let workspace: string;
    try {
      const { values, tokens } = parseArgs({
        args: args.slice(1),
        options: { workspace: { type: 'string' } },
        strict: true,
        allowPositionals: false,
        tokens: true,
      });
      if (
        tokens.length > 1 ||
        (values.workspace !== undefined &&
          (!values.workspace.trim() || values.workspace.includes('\0')))
      )
        throw new UsageError();
      workspace = resolve(values.workspace ?? '.');
    } catch {
      throw new UsageError();
    }
    console.log(JSON.stringify(await initWorkspace(workspace)));
    return;
  }
  if (args[0] === 'memory') {
    const command = parseMemoryCommand(args.slice(1));
    if (command.operation === 'state')
      console.log(
        JSON.stringify({
          status: 'ok',
          content: await memoryState(command.memory),
        }),
      );
    else if (command.operation === 'read')
      console.log(
        JSON.stringify({
          status: 'ok',
          ...(await memoryRead(command.memory, command.value!)),
        }),
      );
    else {
      const results = await memoryFind(
        command.memory,
        command.value!,
        command.scope,
      );
      console.log(
        JSON.stringify({
          status: results.length ? 'ok' : 'not_found',
          results,
        }),
      );
    }
    return;
  }
  const { source, destination } = parseCommand(args);
  if (!(await stat(source)).isFile()) {
    throw Object.assign(new Error(), { code: 'SOURCE_NOT_FILE' });
  }
  if (!(await stat(dirname(destination))).isDirectory()) {
    throw Object.assign(new Error(), {
      code: 'DESTINATION_PARENT_NOT_DIRECTORY',
    });
  }
  try {
    if (!(await stat(destination)).isFile()) {
      throw Object.assign(new Error(), { code: 'DESTINATION_NOT_FILE' });
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
      throw error;
  }
  const { appended, recoveredBytes } = await syncSession(source, destination);
  console.log(JSON.stringify({ status: 'ok', appended, recoveredBytes }));
}

function parseMemoryCommand(args: string[]) {
  try {
    const [operation, ...rest] = args;
    if (!operation || !['state', 'find', 'read'].includes(operation))
      throw new UsageError();
    const { values, positionals, tokens } = parseArgs({
      args: rest,
      options: {
        memory: { type: 'string' },
        ...(operation === 'find' ? { type: { type: 'string' as const } } : {}),
      },
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
    const names = tokens.filter((t) => t.kind === 'option').map((t) => t.name);
    if (
      new Set(names).size !== names.length ||
      positionals.length !== (operation === 'state' ? 0 : 1) ||
      [...positionals, ...Object.values(values)].some(
        (v) => typeof v !== 'string' || !v.trim() || v.includes('\0'),
      ) ||
      (values.type !== undefined &&
        values.type !== 'history' &&
        values.type !== 'knowledge')
    )
      throw new UsageError();
    return {
      operation,
      memory: resolve(values.memory ?? 'memory'),
      value: positionals[0],
      scope: values.type as MemoryScope | undefined,
    };
  } catch {
    throw new UsageError();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const code =
    error instanceof UsageError
      ? 'INVALID_ARGUMENTS'
      : error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string'
        ? error.code
        : process.argv[2] === 'memory'
          ? 'MEMORY_FAILED'
          : 'SYNC_FAILED';
  const offset =
    error instanceof CaptureError || error instanceof ReaderError
      ? error.offset
      : undefined;
  // Never print exception messages: parsers and I/O errors may contain user data.
  const file =
    code.startsWith('BOOTSTRAP_') &&
    error instanceof Error &&
    'file' in error &&
    typeof error.file === 'string'
      ? error.file
      : undefined;
  console.error(JSON.stringify({ status: 'error', code, offset, file }));
  process.exitCode =
    error instanceof UsageError ||
    [
      'MEMORY_QUERY_INVALID',
      'MEMORY_INVALID_ID',
      'MEMORY_INVALID_SCOPE',
    ].includes(code)
      ? 2
      : 1;
}
