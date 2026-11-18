import { transportJson } from '../shared/artifact-io.ts';
import { launchCheckpoint } from '../checkpoint/checkpoint-launcher.ts';
import { workspaceLayout } from '../shared/layout.ts';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  memoryState,
  memoryFind,
  memoryRead,
  memoryCategory,
  memoryHistory,
  memoryEvent,
} from '../memory/navigator.ts';
import type { MemoryScope } from '../memory/navigator.ts';
import { initWorkspace, type Provider } from './bootstrap.ts';
import {
  runtimeStatus,
  workspaceDirectory,
  runtimePending,
} from '../memory/runtime.ts';

const memoryUsage = [
  'Usage: knownex memory state [--memory <directory>]',
  '       knownex memory find "<query>" [--type history|knowledge] [--memory <directory>]',
  '       knownex memory read <id[@revision]|reference>[#section] [--at <checkpoint-sequence|H-ID>] [--memory <directory>]',
  '       knownex memory category <key> [--limit <1..20> --cursor <token>] [--memory <directory>]',
  '       knownex memory history [--last <1..50>] [--before <H-ID>] [--memory <directory>]',
  '       knownex memory event <E017|E015..E016|E015–E016> (max 20 events) [--memory <directory>]',
].join('\n');
const initUsage =
  'Usage: knownex init [--workspace <directory>] [--provider codex|claude|codex,claude]';
const checkpointUsage =
  'Usage: knownex checkpoint (--codex | --claude | --agy) [-m <model>] [-r <effort>] [--through <sequence>] [--workspace <directory>]';
const runtimeUsage = 'Usage: knownex runtime [--summary]';
const usage =
  initUsage +
  '\n' +
  checkpointUsage +
  '\n' +
  runtimeUsage +
  '\nUsage: knownex pending [--workspace <directory>] [--from <sequence> --through <sequence> | --cursor <token>] [--limit <1..20>]' +
  '\n' +
  memoryUsage +
  '\n       knownex curate <init|prepare|validate|apply|abandon|read|write|complete> [options]' +
  '\n       knownex taxonomy <prepare|validate|apply|rebuild> [options]';

class UsageError extends Error {}

async function main(args: string[]) {
  if (
    args.length === 0 ||
    (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) ||
    (args.length === 2 &&
      ['memory', 'init', 'pending', 'runtime', 'checkpoint'].includes(
        args[0]!,
      ) &&
      args[1] === '--help') ||
    (args.length === 3 &&
      args[0] === 'memory' &&
      ['state', 'find', 'read', 'category', 'history', 'event'].includes(
        args[1]!,
      ) &&
      args[2] === '--help')
  ) {
    console.log(
      args[0] === 'memory'
        ? memoryUsage
        : args[0] === 'init'
          ? initUsage
          : args[0] === 'checkpoint'
            ? checkpointUsage
            : args[0] === 'runtime'
              ? runtimeUsage
              : usage,
    );
    return;
  }
  if (args[0] === 'checkpoint') {
    let values;
    try {
      const parsed = parseArgs({
        args: args.slice(1),
        tokens: true,
        options: {
          codex: { type: 'boolean' },
          claude: { type: 'boolean' },
          agy: { type: 'boolean' },
          model: { type: 'string', short: 'm' },
          effort: { type: 'string', short: 'r' },
          through: { type: 'string' },
          workspace: { type: 'string' },
        },
      });
      const names = parsed.tokens
        .filter((t) => t.kind === 'option')
        .map((t) => t.name);
      values = parsed.values;
      if (
        new Set(names).size !== names.length ||
        [values.codex, values.claude, values.agy].filter(Boolean).length !==
          1 ||
        [values.model, values.effort, values.workspace].some(
          (v) => v !== undefined && (!v.trim() || v.includes('\0')),
        ) ||
        (values.through !== undefined &&
          (!/^[1-9]\d*$/.test(values.through) ||
            !Number.isSafeInteger(Number(values.through))))
      )
        throw new UsageError();
    } catch {
      throw new UsageError();
    }
    const result = await launchCheckpoint(
      values.workspace ?? workspaceDirectory(),
      {
        provider: values.codex ? 'codex' : values.claude ? 'claude' : 'agy',
        ...(values.model ? { model: values.model } : {}),
        ...(values.effort ? { effort: values.effort } : {}),
        ...(values.through ? { through: Number(values.through) } : {}),
      },
    );
    console.log(transportJson(result));
    if (result.status !== 'SUCCESS') process.exitCode = 1;
    return;
  }
  if (args[0] === 'pending') {
    let values: Record<string, string | undefined>;
    try {
      const parsed = parseArgs({
        args: args.slice(1),
        tokens: true,
        options: {
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
      values = parsed.values as Record<string, string | undefined>;
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
  if (args[0] === 'init') {
    let workspace: string;
    let providers: Provider[] | undefined;
    try {
      const { values, tokens } = parseArgs({
        args: args.slice(1),
        options: {
          workspace: { type: 'string' },
          provider: { type: 'string' },
        },
        strict: true,
        allowPositionals: false,
        tokens: true,
      });
      const names = tokens.map((t) => (t.kind === 'option' ? t.name : ''));
      const provider = values.provider;
      if (
        new Set(names).size !== names.length ||
        (values.workspace !== undefined &&
          (!values.workspace.trim() || values.workspace.includes('\0'))) ||
        (provider !== undefined &&
          !/^(codex|claude)(,(codex|claude))?$/.test(provider))
      )
        throw new UsageError();
      workspace = resolve(values.workspace ?? '.');
      providers =
        provider === undefined
          ? undefined
          : ([...new Set(provider.split(','))] as Provider[]);
    } catch {
      throw new UsageError();
    }
    console.log(transportJson(await initWorkspace(workspace, providers)));
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
    else if (command.operation === 'event')
      console.log(
        transportJson({
          status: 'ok',
          events: await memoryEvent(memory, command.value!),
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
  throw new UsageError();
}

function parseMemoryCommand(args: string[]) {
  try {
    const [operation, ...rest] = args;
    if (
      !operation ||
      !['state', 'find', 'read', 'category', 'history', 'event'].includes(
        operation,
      )
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
          : 'COMMAND_FAILED';
  // Never print exception messages: parsers and I/O errors may contain user data.
  const file =
    code.startsWith('BOOTSTRAP_') &&
    error instanceof Error &&
    'file' in error &&
    typeof error.file === 'string'
      ? error.file
      : undefined;
  console.error(transportJson({ status: 'error', code, file }));
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
