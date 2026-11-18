import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url));

function invoke(args: string[]) {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: 'utf8',
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}

test('CLI shows the syntax without side effects, also through --help', () => {
  for (const [args, first] of [
    [[], 'Usage: knownex init'],
    [['--help'], 'Usage: knownex init'],
    [['-h'], 'Usage: knownex init'],
    [['runtime', '--help'], 'Usage: knownex runtime [--summary]'],
    [['memory', '--help'], 'Usage: knownex memory state'],
    [['memory', 'event', '--help'], 'Usage: knownex memory state'],
  ] as const) {
    const result = invoke([...args]);
    assert.equal(result.status, 0, args.join(' '));
    assert.equal(result.stderr, '');
    assert.ok(result.stdout.startsWith(first), args.join(' '));
    assert.doesNotMatch(result.stdout, /knownex (sync|preflight)/);
  }
  assert.match(invoke(['memory', 'event', '--help']).stdout, /memory event/);
  assert.equal(invoke(['runtime', '--help']).stdout.split('\n').length, 2);
});

test('CLI rejects removed or unknown commands, extra options and arguments with exit 2', () => {
  for (const args of [
    ['unknown'],
    ['watch'],
    ['sync', '--source', 'a', '--destination', 'b'],
    ['preflight'],
    ['--help', 'extra'],
    ['runtime', '--unknown'],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 2, args.join(' '));
    assert.equal(result.stdout, '');
    assert.deepEqual(JSON.parse(result.stderr), {
      status: 'error',
      code: 'INVALID_ARGUMENTS',
    });
  }
});
