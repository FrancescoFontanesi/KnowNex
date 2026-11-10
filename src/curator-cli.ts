import { transportJson } from './artifact-io.ts';
import { checkpoint } from './checkpoint-controller.ts';
import { nativeCheckpoint, delegationResult } from './native-checkpoint.ts';
import {
  canonicalWork,
  resolveWorkArgument,
  workspaceLayout,
} from './layout.ts';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  abandonCurator,
} from './curator.ts';

let nativeCommand = false;
try {
  const [command, ...args] = process.argv.slice(2);
  nativeCommand = command === 'native';
  if (!command || command === '--help') {
    console.log(
      'Usage: knownex curate <native|checkpoint|init|prepare|validate|apply|abandon> --work <directory> [native: --stage prepare --authorization captured-user-invocation | --stage complete --run ID --proposal-sha256 HASH --review-sha256 HASH] [checkpoint: external worker; --directive <file> --artifacts <path,path>] [--memory <source> --feed <jsonl> --through <n>] [--autonomous --directive <file> --through <n> --context <note,note> --artifacts <path,path>] [validate: --summary] [--confirm <seal>] [--run <id>]',
    );
  } else {
    const options =
      command === 'native'
        ? [
            'work',
            'stage',
            'authorization',
            'run',
            'proposal-sha256',
            'review-sha256',
          ]
        : command === 'checkpoint'
          ? ['work', 'directive', 'artifacts']
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
        ...(command === 'validate'
          ? { summary: { type: 'boolean' as const } }
          : {}),
      },
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
    const { autonomous, summary, ...strings } = parsed;
    const values = strings as Record<string, string | undefined>;
    const names = tokens.filter((t) => t.kind === 'option').map((t) => t.name);
    if (
      new Set(names).size !== names.length ||
      !values.work?.trim() ||
      Object.values(values).some(
        (v) => typeof v === 'string' && (!v.trim() || v.includes('\0')),
      )
    )
      throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
    const originalWork = values.work!;
    values.work = resolveWorkArgument(originalWork);
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
    if (command === 'native') {
      if (
        !['prepare', 'complete'].includes(values.stage ?? '') ||
        (values.stage === 'prepare' &&
          (values.run ||
            values['proposal-sha256'] ||
            values['review-sha256'])) ||
        (values.stage === 'complete' &&
          (values.authorization ||
            !values.run ||
            !/^[a-f0-9]{64}$/.test(values['proposal-sha256'] ?? '') ||
            !/^[a-f0-9]{64}$/.test(values['review-sha256'] ?? '')))
      )
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      result = await nativeCheckpoint(values.work, {
        stage: values.stage as 'prepare' | 'complete',
        authorization: values.authorization,
        run: values.run,
        proposalSha256: values['proposal-sha256'],
        reviewSha256: values['review-sha256'],
      });
      if (!['SUCCESS', 'READY'].includes(result.status)) process.exitCode = 1;
    } else if (command === 'checkpoint') {
      result = await checkpoint(values.work, {
        directive: values.directive,
        artifacts: values.artifacts?.split(','),
      });
      if (result.status !== 'applied') process.exitCode = 1;
    } else if (command === 'init') {
      if (!values.memory || !values.feed || !values.through)
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      // Seeding may represent no events; positive cutoffs must use the manual handoff.
      if (Number(values.through) !== 0)
        throw Object.assign(new Error(), { code: 'CURATOR_HANDOFF_REQUIRED' });
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
        requireInvocation: true,
        ...(autonomous ? { autonomous: true } : {}),
        ...(values.through === undefined
          ? {}
          : { through: Number(values.through) }),
        context: values.context?.split(',') ?? [],
        artifacts: values.artifacts?.split(',') ?? [],
      });
    } else if (command === 'validate') {
      const validated = await validateCurator(values.work);
      result = validated;
      if (summary && validated.review) {
        const { report } = validated.review;
        result = {
          ...validated,
          review: {
            ...validated.review,
            report: {
              ...report,
              critical: report.critical.map((c, index) => ({
                index,
                textChange:
                  c.before === c.after
                    ? 'unchanged'
                    : !c.before
                      ? 'added'
                      : !c.after
                        ? 'removed'
                        : 'changed',
                reason: c.reason,
                sources: c.sources,
              })),
            },
          },
        };
      }
    } else {
      if (!values.confirm)
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      result = await applyCurator(values.work, values.confirm, true);
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
