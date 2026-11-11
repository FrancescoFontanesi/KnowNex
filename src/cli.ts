import { transportJson } from './artifact-io.ts';
import { nativePreflight } from './native-preflight.ts';
import { workspaceLayout } from './layout.ts';
import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { syncSession, CaptureError } from './capture.ts';
import { ReaderError } from './reader.ts';
import {
  memoryState,
  memoryFind,
  memoryRead,
  memoryCategory,
  memoryHistory,
} from './navigator.ts';
import type { MemoryScope } from './navigator.ts';
import { initWorkspace } from './bootstrap.ts';
import {
  runtimeStatus,
  workspaceDirectory,
  runtimePending,
} from './runtime.ts';

const syncUsage = 'Usage: knownex sync --source <jsonl> --destination <file>';
const memoryUsage = [
  'Usage: knownex memory state [--memory <directory>]',
  '       knownex memory find "<query>" [--type history|knowledge] [--memory <directory>]',
  '       knownex memory read <id[@revision]|reference>[#section] [--at <checkpoint-sequence|H-ID>] [--memory <directory>]',
  '       knownex memory category <key> [--limit <1..20> --cursor <token>] [--memory <directory>]',
  '       knownex memory history [--last <1..50>] [--before <H-ID>] [--memory <directory>]',
].join('\n');
const initUsage = 'Usage: knownex init [--workspace <directory>]';
const usage =
  syncUsage +
  '\n' +
  initUsage +
  '\nUsage: knownex runtime [--summary]' +
  '\nUsage: knownex preflight [--workspace <directory>] (read-only native hook approval)' +
  '\nUsage: knownex pending [--workspace <directory>] [--from <sequence> --through <sequence> | --cursor <token>] [--limit <1..20>] [--include-administrative]' +
  '\n' +
  memoryUsage +
  '\n       knownex curate <native|init|prepare|validate|apply|abandon|read|write|complete> [options]' +
  '\n       knownex taxonomy <prepare|validate|apply|rebuild> [options]';

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
      ['sync', 'memory', 'init', 'pending', 'preflight'].includes(args[0]!) &&
      args[1] === '--help') ||
    (args.length === 3 &&
      args[0] === 'memory' &&
      ['state', 'find', 'read', 'category', 'history'].includes(args[1]!) &&
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
    let includeAdministrative: boolean | undefined;
    try {
      const parsed = parseArgs({
        args: args.slice(1),
        tokens: true,
        options: {
          'include-administrative': { type: 'boolean' },
          ...Object.fromEntries(
            ['workspace', 'from', 'through', 'limit', 'cursor'].map((name) => [
              name,
              { type: 'string' as const },
            ]),
          ),
        },
      });
      const names = parsed.tokens
        .filter((t) => t.kind === 'option')
        .map((t) => t.name);
      const { 'include-administrative': include, ...strings } = parsed.values;
      includeAdministrative = include as boolean | undefined;
      values = strings as Record<string, string | undefined>;
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
      transportJson(
        await runtimePending(values.workspace ?? workspaceDirectory(), {
          from: values.from === undefined ? undefined : Number(values.from),
          through:
            values.through === undefined ? undefined : Number(values.through),
          limit: values.limit === undefined ? undefined : Number(values.limit),
          cursor: values.cursor,
          includeAdministrative,
        }),
      ),
    );
    return;
  }
  if (args[0] === 'runtime') {
    if (args.length !== 1 && !(args.length === 2 && args[1] === '--summary'))
      throw new UsageError();
    const status = await runtimeStatus(workspaceDirectory());
    if (args[1] === '--summary') {
      const { state: _state, ...summary } = status as typeof status & {
        state?: string;
      };
      console.log(transportJson(summary));
    } else console.log(transportJson(status));
    return;
  }
  if (args[0] === 'init' || args[0] === 'preflight') {
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
    const result =
      args[0] === 'preflight'
        ? await nativePreflight(workspace)
        : await initWorkspace(workspace);
    console.log(transportJson(result));
    if (result.status === 'blocked') process.exitCode = 1;
    return;
  }
  if (args[0] === 'memory') {
    const command = parseMemoryCommand(args.slice(1));
    let memory = command.memory;
    if (!memory) {
      const root = workspaceDirectory();
      let project = false;
      try {
        await stat(resolve(root, '.knownex'));
        project = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      if (project) {
        const state = await runtimeStatus(root);
        if (state.status !== 'ok')
          throw Object.assign(new Error(), { code: state.code });
        memory = state.memory ?? workspaceLayout(root).memory;
      } else memory = resolve(root, 'memory');
    }
    if (command.operation === 'state')
      console.log(
        transportJson({
          status: 'ok',
          content: await memoryState(memory),
        }),
      );
    else if (command.operation === 'read')
      console.log(
        transportJson({
          status: 'ok',
          ...(await memoryRead(memory, command.value!, { at: command.at })),
        }),
      );
    else if (command.operation === 'history')
      console.log(
        transportJson({
          status: 'ok',
          results: await memoryHistory(memory, {
            ...(command.last === undefined
              ? {}
              : { last: Number(command.last) }),
            ...(command.before === undefined ? {} : { before: command.before }),
          }),
        }),
      );
    else if (command.operation === 'category')
      console.log(
        transportJson(
          await memoryCategory(memory, command.value!, {
            limit:
              command.limit === undefined ? undefined : Number(command.limit),
            cursor: command.cursor,
          }),
        ),
      );
    else {
      const results = await memoryFind(memory, command.value!, command.scope);
      console.log(
        transportJson({
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
  console.log(transportJson({ status: 'ok', appended, recoveredBytes }));
}

function parseMemoryCommand(args: string[]) {
  try {
    const [operation, ...rest] = args;
    if (
      !operation ||
      !['state', 'find', 'read', 'category', 'history'].includes(operation)
    )
      throw new UsageError();
    const { values, positionals, tokens } = parseArgs({
      args: rest,
      options: {
        memory: { type: 'string' },
        ...(operation === 'find' ? { type: { type: 'string' as const } } : {}),
        ...(operation === 'read' ? { at: { type: 'string' as const } } : {}),
        ...(operation === 'category'
          ? {
              limit: { type: 'string' as const },
              cursor: { type: 'string' as const },
            }
          : {}),
        ...(operation === 'history'
          ? {
              last: { type: 'string' as const },
              before: { type: 'string' as const },
            }
          : {}),
      },
      strict: true,
      allowPositionals: true,
      tokens: true,
    });
    const names = tokens.filter((t) => t.kind === 'option').map((t) => t.name);
    if (
      new Set(names).size !== names.length ||
      positionals.length !==
        (operation === 'state' || operation === 'history' ? 0 : 1) ||
      (values.last !== undefined &&
        !/^[1-9]\d*$/.test(values.last as string)) ||
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
      memory: values.memory ? resolve(values.memory) : undefined,
      value: positionals[0],
      scope: values.type as MemoryScope | undefined,
      at: values.at as string | undefined,
      limit: values.limit as string | undefined,
      cursor: values.cursor as string | undefined,
      last: values.last as string | undefined,
      before: values.before as string | undefined,
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
  console.error(transportJson({ status: 'error', code, offset, file }));
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
