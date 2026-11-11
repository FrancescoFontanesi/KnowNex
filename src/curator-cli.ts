import { transportJson, decodeUtf8, utf8Bytes } from './artifact-io.ts';
import { preparedCheckpoint, delegationResult } from './native-checkpoint.ts';
import { readCurationInput, writeCurationDraft } from './curation-io.ts';
import {
  canonicalWork,
  resolveWorkArgument,
  workspaceLayout,
} from './layout.ts';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  abandonCurator,
} from './curator.ts';

function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function integer(value: string) {
  const n = Number(value);
  if (!/^(0|[1-9]\d*)$/.test(value) || !Number.isSafeInteger(n))
    fail('CURATOR_ARGUMENT_INVALID');
  return n;
}
let nativeCommand = false;
try {
  const [command, ...args] = process.argv.slice(2);
  nativeCommand = command === 'native';
  if (!command || command === '--help') {
    console.log(
      'Usage: knownex curate <native|init|prepare|validate|apply|abandon> --work <directory> [native: --stage prepare | --stage complete --run ID] [--memory <source> --feed <jsonl> --through <n>] [--autonomous --directive <file> --through <n> --context <note,note> --artifacts <path,path>] [--confirm <seal>] [--run <id>]\nPortable: knownex curate read --run <directory> --input <name> [--offset <byte> --limit <bytes> --sha256 <hash>]\n          knownex curate write --run <directory>   (assembles <run>/draft)\n          knownex curate complete --run <directory>',
    );
  } else {
    const options =
      command === 'read'
        ? ['run', 'input', 'offset', 'limit', 'sha256']
        : command === 'write'
          ? ['run']
          : command === 'complete'
            ? ['run']
            : command === 'native'
              ? ['work', 'stage', 'run']
              : command === 'init'
                ? ['work', 'memory', 'feed', 'through']
                : command === 'abandon'
                  ? ['work', 'run']
                  : command === 'prepare'
                    ? ['work', 'directive', 'through', 'context', 'artifacts']
                    : command === 'apply'
                      ? ['work', 'confirm']
                      : command === 'validate'
                        ? ['work']
                        : [];
    if (!options.length)
      throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
    const { values: parsed, tokens } = parseArgs({
      args,
      options: {
        ...Object.fromEntries(
          options.map((n) => [n, { type: 'string' as const }]),
        ),
        ...(command === 'prepare'
          ? { autonomous: { type: 'boolean' as const } }
          : {}),
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
    const { autonomous, ...strings } = parsed;
    const values = strings as Record<string, string | undefined>;
    const names = tokens.filter((t) => t.kind === 'option').map((t) => t.name);
    if (
      new Set(names).size !== names.length ||
      (!['read', 'write', 'complete'].includes(command) &&
        !values.work?.trim()) ||
      Object.values(values).some(
        (v) => typeof v === 'string' && (!v.trim() || v.includes('\0')),
      )
    )
      throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
    const originalWork = values.work!;
    values.work = originalWork ? resolveWorkArgument(originalWork) : '';
    if (command === 'init') {
      const root = resolve(
        values.work,
        canonicalWork(values.work) ? '../../..' : '../..',
      );
      const layout = workspaceLayout(root);
      if (
        ['.knownex/seed', '.knownex/memory'].some(
          (p) => resolve(root, p) === resolve(values.memory!),
        )
      )
        values.memory = layout.memory;
      if (
        [
          '.knownex/feed/project.jsonl',
          '.knownex/internal/feed/project.jsonl',
        ].some((p) => resolve(root, p) === resolve(values.feed!))
      )
        values.feed = resolve(layout.feed, 'project.jsonl');
    }
    let result;
    if (['read', 'write', 'complete'].includes(command)) {
      if (!values.run || (command === 'read' && !values.input))
        fail('CURATOR_ARGUMENT_INVALID');
      if (command === 'read') {
        const run = resolve(values.run!);
        const artifact = await readCurationInput(run, values.input!);
        const offset = values.offset === undefined ? 0 : integer(values.offset);
        const limit =
          values.limit === undefined ? undefined : integer(values.limit);
        if (
          (values.sha256 && !/^[a-f0-9]{64}$/.test(values.sha256)) ||
          (offset > 0 && !values.sha256)
        )
          fail('CURATOR_ARGUMENT_INVALID');
        if (values.sha256 && values.sha256 !== artifact.sha256)
          fail('CURATOR_INPUTS_CHANGED');
        const bytes = utf8Bytes(artifact.text);
        if (
          offset > bytes.length ||
          limit === 0 ||
          (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80)
        )
          fail('CURATOR_IO_RANGE_INVALID');
        let end =
          limit === undefined
            ? bytes.length
            : Math.min(bytes.length, offset + limit);
        while (
          end > offset &&
          end < bytes.length &&
          (bytes[end]! & 0xc0) === 0x80
        )
          end--;
        if (end === offset && offset < bytes.length)
          fail('CURATOR_IO_RANGE_INVALID');
        result = {
          ...artifact,
          runId: basename(run),
          input: values.input,
          text: decodeUtf8(bytes.subarray(offset, end)),
          offset,
          nextOffset: end,
          complete: end === bytes.length,
        };
      } else {
        const run = resolve(values.run!);
        if (basename(dirname(run)) !== 'runs') fail('CURATOR_IO_UNSAFE_RUN');
        if (command === 'write') result = await writeCurationDraft(run);
        else {
          result = await preparedCheckpoint(dirname(dirname(run)), {
            stage: 'complete',
            run: basename(run),
          });
          if (result.status !== 'SUCCESS') process.exitCode = 1;
        }
      }
    } else if (command === 'native') {
      if (
        !['prepare', 'complete'].includes(values.stage ?? '') ||
        (values.stage === 'prepare' && values.run) ||
        (values.stage === 'complete' && !values.run)
      )
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      result = await preparedCheckpoint(values.work, {
        stage: values.stage as 'prepare' | 'complete',
        run: values.run,
      });
      if (!['SUCCESS', 'READY'].includes(result.status)) process.exitCode = 1;
    } else if (command === 'init') {
      if (!values.memory || !values.feed || !values.through)
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      // Seeding may represent no events; positive cutoffs must use the manual handoff.
      if (Number(values.through) !== 0)
        throw Object.assign(new Error(), {
          code: 'CURATOR_CHECKPOINT_INVALID',
        });
      result = await initCurator(
        values.work,
        values.memory,
        values.feed,
        Number(values.through),
      );
    } else if (command === 'abandon') {
      if (!values.run)
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      result = await abandonCurator(values.work, values.run);
    } else if (command === 'prepare') {
      result = await prepareCurator(values.work, values.directive, {
        ...(autonomous ? { autonomous: true } : {}),
        ...(values.through === undefined
          ? {}
          : { through: Number(values.through) }),
        context: values.context?.split(',') ?? [],
        artifacts: values.artifacts?.split(',') ?? [],
      });
    } else if (command === 'validate') {
      result = await validateCurator(values.work);
    } else {
      if (!values.confirm)
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      result = await applyCurator(values.work, values.confirm);
    }
    console.log(transportJson(result));
  }
} catch (error) {
  const value = (error as NodeJS.ErrnoException).code;
  const code =
    typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
      ? value
      : 'CURATOR_FAILED';
  console.error(
    transportJson(
      nativeCommand
        ? delegationResult({
            status: 'error',
            through: null,
            code,
            phase: 'arguments',
          })
        : { status: 'error', code },
    ),
  );
  process.exitCode = 1;
}
