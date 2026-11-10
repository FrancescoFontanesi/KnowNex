import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initialize } from './harness.mjs';
import {
  source,
  memory,
  facts,
  scenarios,
  assessmentPolicy,
} from './retrieval-fixture.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const put = (file, value) =>
  writeFile(
    file,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
    { flag: 'wx' },
  );
const inside = (a, b) => {
  const r = relative(a, b);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
};

// No model, native RPC, checkpoint or global configuration changes.
export async function prepareRetrieval(output) {
  const root = resolve(output);
  if (inside(repository, root) || inside(root, repository))
    throw new Error('OUTPUT_MUST_BE_ISOLATED');
  await mkdir(root); // Deliberately refuses reuse of an existing experiment.
  const inputs = join(root, 'inputs'),
    workspace = join(root, 'workspaces/cold');
  await mkdir(inputs);
  const npmCli =
    process.env.npm_execpath ??
    join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  function npm(args, cwd) {
    const result = spawnSync(process.execPath, [npmCli, ...args], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        'FIXTURE_INSTALL_FAILED: ' + (result.error?.message ?? result.stderr),
      );
    return result.stdout;
  }
  const distribution = join(root, 'distribution');
  await mkdir(distribution);
  // The caller builds first. npm owns bin linking; a raw copy is not an install.
  const packed = JSON.parse(
    npm(
      [
        'pack',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        distribution,
      ],
      repository,
    ),
  );
  const archive = join(distribution, packed[0].filename);
  const workspaces = {};
  for (const scenario of scenarios) {
    const project = join(root, 'workspaces', scenario.id);
    workspaces[scenario.id] = project;
    await mkdir(project, { recursive: true });
    npm(
      [
        'install',
        '--offline',
        '--no-save',
        '--package-lock=false',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        archive,
      ],
      project,
    );
    npm(['exec', '--offline', '--', 'knownex', 'init'], project);
    const git = spawnSync('git', ['init'], {
      cwd: project,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (git.error || git.status !== 0)
      throw new Error('FIXTURE_GIT_INIT_FAILED');
    const mem = join(project, '.knownex/memory');
    for (const [name, text] of Object.entries(memory)) {
      await mkdir(dirname(join(mem, name)), { recursive: true });
      await writeFile(join(mem, name), text);
    }
  }
  await put(join(inputs, 'ledger.md'), source);
  await put(join(inputs, 'scenarios.json'), {
    version: 1,
    synthetic: true,
    scenarios,
    assessmentPolicy,
  });
  const pkg = JSON.parse(
    await readFile(
      join(workspace, 'node_modules/knownex/package.json'),
      'utf8',
    ),
  );
  // Capture hooks append test conversations. Never share their pending feed
  // between scenarios or mistake a previous test answer for project knowledge.
  await mkdir(join(root, 'experiments'));
  for (const scenario of scenarios) {
    const oracleFile = scenario.id + '.oracle.json';
    await put(join(inputs, oracleFile), {
      version: 1,
      id: 'meridian-' + scenario.id + '-v1',
      facts: facts.filter((f) => scenario.facts.includes(f.id)),
    });
    const config = {
      version: 1,
      scenario: 'meridian-' + scenario.id,
      condition: 'hand-authored-seed',
      workload: 'meridian-v1-' + scenario.id,
      comparisonGroup: 'meridian-v1-' + scenario.id,
      instructionPolicy: 'ordinary-knownex; no conversation; private oracle',
      transport: 'native-codex',
      model: 'gpt-6.1-sol',
      reasoning: 'medium',
      knownexVersion: pkg.version,
      synthetic: true,
      workspace: workspaces[scenario.id],
      groundTruth: oracleFile,
      sources: [
        { id: 'ledger', path: 'ledger.md' },
        { id: 'scenario', path: 'scenarios.json' },
        {
          id: 'fixture-code',
          path: fileURLToPath(
            new URL('./retrieval-fixture.mjs', import.meta.url),
          ),
        },
        { id: 'preparation-code', path: fileURLToPath(import.meta.url) },
      ],
      snapshotPaths: [
        '.knownex',
        '.codex',
        '.agents/skills',
        'AGENTS.md',
        'node_modules/knownex',
        '.git/config',
        '.git/HEAD',
      ],
      controlPaths: ['AGENTS.md', '.codex', '.agents/skills', '.git/config'],
      environment: {
        codexVersion: null,
        hooksApproved: null,
        stateDeliveryVerified: false,
      },
      limits: {
        modelCalls: 0,
        note: 'Preparation only. Create a new frozen protocol with authorized limits before any LLM test.',
      },
    };
    const configFile = join(inputs, scenario.id + '.config.json');
    await put(configFile, config);
    await initialize(configFile, join(root, 'experiments', scenario.id));
  }
  return {
    root,
    workspace,
    workspaces,
    scenarios: scenarios.length,
    inferenceStarted: false,
    checkpointStarted: false,
  };
}

export async function inventory(root) {
  const files = {};
  async function visit(dir, prefix = '') {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      const name = prefix + item.name;
      if (item.isSymbolicLink()) throw new Error('UNSAFE_FIXTURE_PATH');
      if (item.isDirectory()) await visit(join(dir, item.name), name + '/');
      else files[name] = sha(await readFile(join(dir, item.name)));
    }
  }
  await visit(root);
  return files;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.length !== 3)
    throw new Error(
      'Usage: node evaluation/retrieval.mjs <new-external-directory>',
    );
  console.log(JSON.stringify(await prepareRetrieval(process.argv[2]), null, 2));
}
