import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { initialize, start, collect, evaluate, compare } from './harness.mjs';
import { exampleInputs } from './example.mjs';

const output = resolve(
  process.argv[2] ?? '.local/evaluation-demo-' + Date.now(),
);
await mkdir(output, { recursive: true, mode: 0o700 });
const runs = [];
for (const condition of ['demonstration-one', 'demonstration-two']) {
  const input = await exampleInputs(
    join(output, condition + '-input'),
    condition,
  );
  const experiment = join(output, condition);
  await initialize(input.config, experiment);
  const run = await start(experiment);
  await collect(experiment, run.id, input.capture);
  await evaluate(experiment, run.id, input.review);
  runs.push(run.run);
}
console.log(JSON.stringify(await compare(runs, join(output, 'comparison'))));
