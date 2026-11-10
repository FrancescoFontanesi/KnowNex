#!/usr/bin/env node
import { parseArgs } from 'node:util';
import {
  initialize,
  start,
  collect,
  evaluate,
  report,
  compare,
} from './harness.mjs';

const usage = `Read-only evaluation harness (Node 24.11+)
  init --config FILE --out DIRECTORY
  start --experiment DIRECTORY
  collect --experiment DIRECTORY --run ID --capture FILE
  evaluate --experiment DIRECTORY --run ID --review FILE
  report --experiment DIRECTORY --run ID
  compare --runs RUN_DIRECTORY,RUN_DIRECTORY --out DIRECTORY
No command starts Codex, a checkpoint, recovery, or a model.`;
try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help') console.log(usage);
  else {
    const names = {
      init: ['config', 'out'],
      start: ['experiment'],
      collect: ['experiment', 'run', 'capture'],
      evaluate: ['experiment', 'run', 'review'],
      report: ['experiment', 'run'],
      compare: ['runs', 'out'],
    }[command];
    if (!names) throw new Error('INVALID_COMMAND');
    const { values, tokens } = parseArgs({
      args,
      options: Object.fromEntries(names.map((n) => [n, { type: 'string' }])),
      tokens: true,
    });
    if (
      tokens.length !== names.length ||
      new Set(tokens.map((t) => t.name)).size !== names.length ||
      names.some((n) => !values[n]?.trim())
    )
      throw new Error('INVALID_ARGUMENTS');
    const result =
      command === 'init'
        ? await initialize(values.config, values.out)
        : command === 'start'
          ? await start(values.experiment)
          : command === 'collect'
            ? await collect(values.experiment, values.run, values.capture)
            : command === 'evaluate'
              ? await evaluate(values.experiment, values.run, values.review)
              : command === 'report'
                ? await report(values.experiment, values.run)
                : await compare(values.runs.split(','), values.out);
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(
    JSON.stringify({
      status: 'error',
      code: /^[A-Z0-9_]+$/.test(error.message)
        ? error.message
        : 'HARNESS_FAILED',
    }),
  );
  process.exitCode = 1;
}
