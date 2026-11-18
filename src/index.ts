#!/usr/bin/env node
if (process.argv[2] === 'taxonomy') {
  process.argv.splice(2, 1);
  await import('./cli/taxonomy-cli.ts');
} else if (process.argv[2] === 'curate') {
  process.argv.splice(2, 1);
  await import('./cli/curator-cli.ts');
} else {
  await import('./cli/cli.ts');
}
