#!/usr/bin/env node
if (process.argv[2] === 'taxonomy') {
  process.argv.splice(2, 1);
  await import('./taxonomy-cli.ts');
} else if (process.argv[2] === 'curate') {
  process.argv.splice(2, 1);
  await import('./curator-cli.ts');
} else {
  await import('./cli.ts');
}
