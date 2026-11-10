import { resolveWorkArgument } from './layout.ts';
import { parseArgs } from 'node:util';
import {
  prepareTaxonomy,
  validateTaxonomy,
  applyTaxonomy,
  rebuildTaxonomy,
} from './curator.ts';
const help =
  'Usage: knownex taxonomy <prepare|validate|apply|rebuild> --work <directory> [--run <id>] [--confirm <seal> --approval-event <sequence>]';
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') console.log(help);
  else {
    const names =
      command === 'prepare' || command === 'rebuild'
        ? ['work']
        : command === 'validate'
          ? ['work', 'run']
          : command === 'apply'
            ? ['work', 'run', 'confirm', 'approval-event']
            : [];
    if (!names.length)
      throw Object.assign(new Error(), { code: 'TAXONOMY_ARGUMENT_INVALID' });
    const { values, tokens } = parseArgs({
      args,
      options: Object.fromEntries(
        names.map((n) => [n, { type: 'string' as const }]),
      ),
      tokens: true,
    });
    if (
      tokens.length !== names.length ||
      new Set(tokens.filter((t) => t.kind === 'option').map((t) => t.name))
        .size !== names.length ||
      names.some((n) => !values[n]?.trim() || values[n]!.includes('\0')) ||
      (values['approval-event'] !== undefined &&
        !/^\d+$/.test(values['approval-event']))
    )
      throw Object.assign(new Error(), { code: 'TAXONOMY_ARGUMENT_INVALID' });
    values.work = resolveWorkArgument(values.work!);
    const result =
      command === 'prepare'
        ? await prepareTaxonomy(values.work!)
        : command === 'validate'
          ? await validateTaxonomy(values.work!, values.run!)
          : command === 'apply'
            ? await applyTaxonomy(
                values.work!,
                values.run!,
                values.confirm!,
                Number(values['approval-event']),
              )
            : await rebuildTaxonomy(values.work!);
    console.log(JSON.stringify(result));
  }
} catch (e) {
  const code = (e as NodeJS.ErrnoException).code;
  console.error(
    JSON.stringify({
      status: 'error',
      code:
        typeof code === 'string' && /^[A-Z_]+$/.test(code)
          ? code
          : 'TAXONOMY_FAILED',
    }),
  );
  process.exitCode = 1;
}
