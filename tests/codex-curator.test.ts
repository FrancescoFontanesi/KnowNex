import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { codexCuratorArgs, runCodexCurator } from '../src/codex-curator.ts';

async function fixture(t: test.TestContext, body: string) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'knownex-exec-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, 'fake.mjs'),
    module = join(root, 'io.js'),
    requestFile = join(root, 'request.txt');
  await writeFile(module, '// deterministic fixture\n');
  await writeFile(
    requestFile,
    'Frozen references only.\nINPUT_REFERENCES_JSON\n' +
      JSON.stringify({ io: { module: pathToFileURL(module).href } }),
  );
  await writeFile(script, body, 'utf8');
  return {
    input: { run: root, requestFile, workspace: root },
    config: {
      binary: process.execPath,
      model: 'gpt-6.1-terra',
      reasoning: 'medium',
      provider: 'existing-provider',
      auth: 'chatgpt' as const,
    },
    script,
  };
}
test('native launcher uses one exec, configured model/provider and scoped workspace without auth bypass', async (t) => {
  const f = await fixture(
    t,
    `const a=process.argv.slice(2);if(!a.includes('exec')||a[a.indexOf('--model')+1]!=='gpt-6.1-terra')process.exit(3);let prompt='';for await(const b of process.stdin)prompt+=b;if(!prompt.includes('INPUT_REFERENCES_JSON'))process.exit(4);const p={path:'proposal',sha256:'a'.repeat(64),bytes:4},r={path:'review',sha256:'b'.repeat(64),bytes:5};for(const v of [{type:'thread.started',thread_id:'fixture-thread'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:JSON.stringify({proposal:p,review:r})}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:4,output_tokens:2}}])console.log(JSON.stringify(v));`,
  );
  const args = codexCuratorArgs(
    f.input,
    f.config,
    join(f.input.run, 'schema.json'),
  );
  assert.equal(args[args.indexOf('--cd') + 1], f.input.run);
  assert.ok(args.includes('model_provider="existing-provider"'));
  assert.ok(args.includes('hooks'));
  assert.ok(args.includes('multi_agent'));
  assert.ok(
    !args.some(
      (a) => a.includes('bypass') || a === '--oss' || a === '--local-provider',
    ),
  );
  const result = await runCodexCurator(f.input, f.config, {
    prefixArgs: [f.script],
  });
  assert.equal(result.proposal.bytes, 4);
  const meta = JSON.parse(
    await readFile(join(f.input.run, 'worker.json'), 'utf8'),
  );
  assert.equal(meta.threadId, 'fixture-thread');
  assert.equal(meta.requestedModel, 'gpt-6.1-terra');
  assert.deepEqual(meta.usage, {
    input_tokens: 10,
    cached_input_tokens: 4,
    output_tokens: 2,
  });
});
for (const [kind, body, code] of [
  [
    'failed',
    `console.log(JSON.stringify({type:'turn.failed',error:{message:'PRIVATE_WORKER_DIAGNOSTIC'}}));`,
    'CURATOR_WORKER_FAILED',
  ],
  [
    'partial',
    `process.stdout.write('{"type":"turn.completed"');`,
    'CURATOR_WORKER_OUTPUT_INCOMPLETE',
  ],
  ['invalid', `console.log('not json');`, 'CURATOR_WORKER_OUTPUT_INVALID'],
  [
    'timeout',
    `process.stdin.resume();setTimeout(()=>{},10000);`,
    'CURATOR_WORKER_TIMEOUT',
  ],
] as const)
  test('native launcher stops without retry on ' + kind, async (t) => {
    const f = await fixture(t, body);
    await assert.rejects(
      runCodexCurator(f.input, f.config, {
        prefixArgs: [f.script],
        timeoutMs: kind === 'timeout' ? 100 : 5000,
      }),
      new RegExp(code),
    );
    const meta = JSON.parse(
      await readFile(join(f.input.run, 'worker.json'), 'utf8'),
    );
    assert.equal(meta.code, code);
  });
