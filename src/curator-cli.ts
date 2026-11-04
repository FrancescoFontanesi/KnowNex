import { parseArgs } from 'node:util';
import {
  initCurator,
  prepareCurator,
  validateCurator,
  applyCurator,
  requestCurator,
  abandonCurator,
} from './curator.ts';

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') {
    console.log(
      'Usage: knownex curate <init|request|prepare|validate|apply|abandon> --work <directory> [--memory <source> --feed <jsonl> --through <n>] [--milestone <key>] [--directive <file> --request <id> --through <n> --context <note,note> --artifacts <path,path>] [--confirm <seal>] [--run <id>]',
    );
  } else {
    const options =
      command === 'init'
        ? ['work', 'memory', 'feed', 'through']
        : command === 'abandon'
          ? ['work', 'run']
          : command === 'request'
            ? ['work', 'milestone']
            : command === 'prepare'
              ? [
                  'work',
                  'directive',
                  'through',
                  'context',
                  'artifacts',
                  'request',
                ]
              : command === 'apply'
                ? ['work', 'confirm']
                : command === 'validate'
                  ? ['work']
                  : [];
    if (!options.length)
      throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
    const { values, tokens } = parseArgs({
      args,
      options: Object.fromEntries(
        options.map((n) => [n, { type: 'string' as const }]),
      ),
      strict: true,
      allowPositionals: false,
      tokens: true,
    });
    const names = tokens.filter((t) => t.kind === 'option').map((t) => t.name);
    if (
      new Set(names).size !== names.length ||
      !values.work?.trim() ||
      Object.values(values).some((v) => !v?.trim() || v.includes('\0'))
    )
      throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
    let result;
    if (command === 'init') {
      if (!values.memory || !values.feed || !values.through)
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      // Seeding may represent no events; positive cutoffs must use the consent workflow.
      if (Number(values.through) !== 0)
        throw Object.assign(new Error(), { code: 'CURATOR_CONSENT_REQUIRED' });
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
    } else if (command === 'request') {
      if (!values.milestone)
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      result = await requestCurator(values.work, values.milestone);
    } else if (command === 'prepare') {
      if (!values.directive)
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      result = await prepareCurator(values.work, values.directive, {
        request: values.request,
        requireConsent: true,
        ...(values.through === undefined
          ? {}
          : { through: Number(values.through) }),
        context: values.context?.split(',') ?? [],
        artifacts: values.artifacts?.split(',') ?? [],
      });
    } else if (command === 'validate')
      result = await validateCurator(values.work);
    else {
      if (!values.confirm)
        throw Object.assign(new Error(), { code: 'CURATOR_ARGUMENT_INVALID' });
      result = await applyCurator(values.work, values.confirm, true);
    }
    console.log(JSON.stringify(result));
  }
} catch (error) {
  const value = (error as NodeJS.ErrnoException).code;
  const code =
    typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)
      ? value
      : 'CURATOR_FAILED';
  console.error(JSON.stringify({ status: 'error', code }));
  process.exitCode = 1;
}
