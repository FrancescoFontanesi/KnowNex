import { workspaceLayout } from '../shared/layout.ts';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../shared/artifact-io.ts';
import { object } from '../shared/check.ts';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyMemory } from '../curation/curator.ts';

const begin = '<!-- knownex:start -->';
const end = '<!-- knownex:end -->';
/** The usage block init writes into a workspace's AGENTS.md/CLAUDE.md (not this repo's AGENTS.md). */
export const policy = `<!-- knownex:start -->

## KnowNex continuity

Hooks capture the conversation automatically. Do not ask the user what to save and do not write artificial summaries to feed the memory. These instructions are in English, but they do not set the language: talk with the user in the language they use.

### Context and recall

- **STATE** is the automatic handoff when a new session starts in the same workspace: reuse it with the conversation context, without re-injecting it every turn or checking it periodically. After a compact STATE is not emitted again: the conversation summary already holds it.
- STATE is the project state up to the last confirmed checkpoint. Later events may have changed it.
- If the available context is enough, go on without Recall. Read a note already linked from STATE directly with \`npm exec --offline -- knownex memory read\`: it is a single read.
- Delegate history (HISTORY, windows, revisions and events), taxonomy and searches for unknown references to a subagent with its own context, which follows the \`knownex-recall\` skill (\`.agents/skills/knownex-recall/SKILL.md\`) read-only and returns facts, references, provenance and limits. Pass a precise request and the references you already know, not the whole conversation. If the harness has no subagents, say so.
- STATE holds the present, Knowledge the topic details, HISTORY the transitions. Do not explore whole archives without need.
- Reuse information and documents already retrieved during the turn. Do not repeat reads just to confirm.
- If the context is incomplete, the pending is partial or some information is missing, state the limits without inventing facts.

### Checkpoint

Keep the conversation natural. State decisions, results, evidence and open problems when they matter to the task, without templates or mandatory sections.

At significant milestones (superseded decisions, verified results, changes of focus, handoffs or relevant compactions) suggest in one line to run the checkpoint, for example \`npm exec --offline -- knownex checkpoint --codex -m gpt-6.1-sol -r medium\`, and keep working. The user decides the checkpoint: run it only on their explicit request, as a background command, and report only the outcome. Curation happens in a separate session: do not read or change the memory yourself to curate it.
<!-- knownex:end -->
`;

function instructions(current: string) {
  const starts = current.split(begin).length - 1;
  const ends = current.split(end).length - 1;
  if (!starts && !ends)
    return current + (current.endsWith('\n') ? '\n' : '\n\n') + policy;
  if (
    starts !== 1 ||
    ends !== 1 ||
    current.indexOf(end) < current.indexOf(begin)
  )
    fail('BOOTSTRAP_AGENTS_INVALID');
  return (
    current.slice(0, current.indexOf(begin)) +
    policy.trimEnd() +
    current.slice(current.indexOf(end) + end.length)
  );
}

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const skillNames = ['knownex-curator', 'knownex-recall', 'knownex-taxonomy'];
// Only the docs the installed skills link to.
const docNames = ['TAXONOMY.md', 'RUNTIME.md'];
function fail(code: string, file?: string): never {
  throw Object.assign(new Error(code), { code, file });
}

/** Reject directory junctions as well as file symlinks before writing project files. */
async function safePath(root: string, name: string) {
  let path = root;
  for (const part of name.split('/')) {
    path = join(path, part);
    try {
      if ((await lstat(path)).isSymbolicLink()) fail('BOOTSTRAP_UNSAFE_PATH');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

export type Provider = 'codex' | 'claude';
const claudeSettingsName = '.claude/settings.json';
/** Adds KnowNex hook groups to a project's Claude settings, keeping every other setting and hook. */
function claudeSettings(current: string) {
  let settings: Record<string, unknown> | undefined;
  try {
    settings = JSON.parse(current || '{}');
  } catch {
    fail('BOOTSTRAP_CLAUDE_SETTINGS_INVALID', claudeSettingsName);
  }
  if (
    !object(settings) ||
    (settings.hooks !== undefined && !object(settings.hooks))
  )
    fail('BOOTSTRAP_CLAUDE_SETTINGS_INVALID', claudeSettingsName);
  const hook = (name: string, timeout: number) => ({
    type: 'command',
    command: `node "$CLAUDE_PROJECT_DIR/.claude/hooks/knownex-${name}.cjs"`,
    timeout,
  });
  const ours: Record<string, unknown[]> = {
    SessionStart: [{ hooks: [hook('session', 10)] }],
    UserPromptSubmit: [{ hooks: [hook('feed', 10)] }],
    Stop: [{ hooks: [hook('feed', 10)] }],
  };
  const hooks: Record<string, unknown> = { ...(settings.hooks as object) };
  // Every event, not only ours: a KnowNex group may sit under any event.
  for (const event of new Set([...Object.keys(hooks), ...Object.keys(ours)])) {
    const existing = hooks[event] ?? [];
    if (!Array.isArray(existing)) {
      if (ours[event])
        fail('BOOTSTRAP_CLAUDE_SETTINGS_INVALID', claudeSettingsName);
      continue;
    }
    // Replace earlier KnowNex groups, keep the user's own hooks for the same event.
    const kept = existing.filter(
      (g) => !JSON.stringify(g).includes('.claude/hooks/knownex-'),
    );
    if (!ours[event] && !kept.length) delete hooks[event];
    else hooks[event] = [...kept, ...(ours[event] ?? [])];
  }
  return JSON.stringify({ ...settings, hooks }, null, 2) + '\n';
}

/** Project-only bootstrap: preflight conflicts, then create missing files exclusively. */
export async function initWorkspace(directory: string, requested?: Provider[]) {
  await mkdir(resolve(directory), { recursive: true });
  const root = await realpath(directory);
  // Without an explicit choice keep the providers already installed (Codex for new workspaces).
  const detected = (['codex', 'claude'] as const).filter((p) =>
    existsSync(join(root, `.${p}/hooks/knownex-feed.cjs`)),
  );
  const providers = requested ?? (detected.length ? detected : ['codex']);
  if (
    !providers.length ||
    providers.some((p) => p !== 'codex' && p !== 'claude')
  )
    fail('BOOTSTRAP_PROVIDER_INVALID');
  const installed = join(root, 'node_modules/knownex');
  try {
    if (
      (await lstat(installed)).isSymbolicLink() ||
      (await realpath(installed)) !== (await realpath(packageRoot))
    )
      fail('BOOTSTRAP_PACKAGE_NOT_LOCAL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      fail('BOOTSTRAP_PACKAGE_NOT_LOCAL');
    throw error;
  }
  const files = new Map<string, string>();
  for (const name of skillNames)
    files.set(
      `.agents/skills/${name}/SKILL.md`,
      (
        await readFile(join(packageRoot, 'skills', name, 'SKILL.md'), 'utf8')
      ).replaceAll('../../docs/', '../../../.knownex/internal/docs/'),
    );
  for (const name of docNames)
    files.set(
      '.knownex/internal/docs/' + name,
      (await readFile(join(packageRoot, 'docs', name), 'utf8'))
        .replaceAll('../skills/', '../../../.agents/skills/')
        // Docs not copied into the workspace stay readable in the installed package.
        .replace(/\]\(([A-Z][A-Z-]*\.md)/g, (link, doc: string) =>
          docNames.includes(doc)
            ? link
            : '](../../../node_modules/knownex/docs/' + doc,
        ),
    );
  files.set(
    '.agents/skills/knownex-taxonomy/agents/openai.yaml',
    await readFile(
      join(packageRoot, 'skills/knownex-taxonomy/agents/openai.yaml'),
      'utf8',
    ),
  );
  // Same package hooks for every provider; the wrapper names the provider.
  for (const provider of providers)
    for (const name of ['feed', 'session'])
      files.set(
        `.${provider}/hooks/knownex-${name}.cjs`,
        "const { resolve, join } = require('node:path');\n" +
          "const root = resolve(__dirname, '../..');\n" +
          'process.env.KNOWNEX_WORKSPACE = root;\n' +
          `process.env.KNOWNEX_PROVIDER = '${provider}';\n` +
          `require(join(root, 'node_modules/knownex/.codex/hooks/${name}.cjs'));\n`,
      );
  const hook = (name: string, timeout: number) => ({
    type: 'command',
    command: `node ".codex/hooks/knownex-${name}.cjs"`,
    timeout,
  });
  if (providers.includes('codex'))
    files.set(
      '.codex/hooks.json',
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              {
                hooks: [{ ...hook('session', 10), additionalContextLimit: 0 }],
              },
            ],
            UserPromptSubmit: [{ hooks: [hook('feed', 10)] }],
            Stop: [{ hooks: [hook('feed', 10)] }],
          },
        },
        null,
        2,
      ) + '\n',
    );
  if (providers.includes('claude')) {
    files.set(claudeSettingsName, claudeSettings(''));
    // Claude Code reads CLAUDE.md, not AGENTS.md: same marked policy block.
    files.set('CLAUDE.md', policy);
  }
  files.set(
    '.knownex/README.md',
    '# KnowNex memory\n\nOpen [STATE](memory/STATE.md) to resume work and [HISTORY](memory/HISTORY.md) for earlier states.\n\n[Knowledge](memory/knowledge/) holds immutable revisions filed by checkpoint, with optional categories. Follow the links from STATE: unchanged notes stay in earlier checkpoints.\n\nTaxonomy, associations and topics are optional organizing views in memory/. internal/ holds feed, runs, journal and receipts: do not edit them by hand.\n\nSessionStart provides STATE; only `knownex checkpoint`, run by the user, produces a new materialization.\n',
  );
  const editable = new Set([
    '.knownex/memory/STATE.md',
    '.knownex/memory/HISTORY.md',
    '.knownex/internal/feed/project.jsonl',
    '.gitignore',
  ]);
  files.set('.knownex/memory/STATE.md', emptyMemory['STATE.md']!);
  files.set('.knownex/memory/HISTORY.md', emptyMemory['HISTORY.md']!);
  files.set('.knownex/internal/feed/project.jsonl', '');
  files.set('AGENTS.md', policy);
  files.set(
    '.gitignore',
    'node_modules/\n.knownex/\n' +
      providers.map((p) => `.${p}/hooks/feed-events.jsonl\n`).join(''),
  );
  const layout = workspaceLayout(root);
  const missing: string[] = [],
    preserved: string[] = [];
  const updates = new Map<string, { before: string; after: string }>();
  const manifestName = '.knownex/internal/install.json';
  await safePath(root, manifestName);
  let manifestBefore: string | undefined;
  let previous: Record<string, string> = {};
  try {
    manifestBefore = await readFile(join(root, manifestName), 'utf8');
    const manifest = JSON.parse(manifestBefore);
    if (
      manifest.version !== 1 ||
      typeof manifest.files !== 'object' ||
      !manifest.files ||
      Array.isArray(manifest.files) ||
      Object.values(manifest.files).some(
        (v) => typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v),
      )
    )
      fail('BOOTSTRAP_MANIFEST_INVALID', manifestName);
    previous = manifest.files;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      fail('BOOTSTRAP_MANIFEST_INVALID', manifestName);
  }
  const directories = [
    relative(root, layout.feed).split('\\').join('/'),
    relative(root, join(layout.memory, 'knowledge')).split('\\').join('/'),
  ];
  for (const name of directories) await safePath(root, name);
  for (const [name, content] of files) {
    await safePath(root, name);
    try {
      const current = await readFile(join(root, name), 'utf8');
      if (name === claudeSettingsName) {
        const next = claudeSettings(current);
        if (next !== current)
          updates.set(name, { before: current, after: next });
        else preserved.push(name);
      } else if (name === 'AGENTS.md' || name === 'CLAUDE.md') {
        const next = instructions(current);
        if (next !== current)
          updates.set(name, { before: current, after: next });
        else preserved.push(name);
      } else if (name === '.gitignore') {
        const lines = new Set(current.split(/\r?\n/));
        const absent = content
          .trimEnd()
          .split('\n')
          .filter((line) => !lines.has(line));
        if (absent.length)
          updates.set(name, {
            before: current,
            after:
              current +
              (current.endsWith('\n') ? '' : '\n') +
              '# KnowNex\n' +
              absent.join('\n') +
              '\n',
          });
        else preserved.push(name);
      } else if (editable.has(name)) preserved.push(name);
      else if (current !== content) {
        if (previous[name] !== sha256(current))
          fail('BOOTSTRAP_CONFLICT', name);
        updates.set(name, { before: current, after: content });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(name);
    }
  }
  async function replace(name: string, before: string, after: string) {
    await safePath(root, name);
    if ((await readFile(join(root, name), 'utf8')) !== before)
      fail('BOOTSTRAP_CONFLICT', name);
    const temporary = join(dirname(join(root, name)), randomUUID() + '.tmp');
    await writeFile(temporary, after, { flag: 'wx', mode: 0o600 });
    await rename(temporary, join(root, name));
  }
  for (const [name, update] of updates)
    await replace(name, update.before, update.after);
  for (const name of missing) {
    await safePath(root, name);
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), files.get(name)!, {
      flag: 'wx',
      mode: 0o600,
    });
  }
  for (const name of directories) {
    await safePath(root, name);
    await mkdir(join(root, name), { recursive: true });
  }
  const version = (
    JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      version: string;
    }
  ).version;
  const manifestText =
    JSON.stringify(
      {
        version: 1,
        packageVersion: version,
        files: Object.fromEntries(
          [...files]
            .filter(
              ([name]) =>
                !editable.has(name) &&
                !['AGENTS.md', 'CLAUDE.md', claudeSettingsName].includes(name),
            )
            .map(([name, content]) => [name, sha256(content)]),
        ),
      },
      null,
      2,
    ) + '\n';
  if (manifestBefore === undefined) {
    await safePath(root, manifestName);
    await writeFile(join(root, manifestName), manifestText, {
      flag: 'wx',
      mode: 0o600,
    });
    missing.push(manifestName);
  } else if (manifestBefore !== manifestText) {
    await replace(manifestName, manifestBefore, manifestText);
    updates.set(manifestName, { before: manifestBefore, after: manifestText });
  }
  return {
    status: 'initialized',
    workspace: root,
    created: missing,
    updated: [...updates.keys()],
    preserved,
    warnings: (await readdir(layout.feed)).some((name) =>
      /^[a-f0-9]{64}\.jsonl$/.test(name),
    )
      ? ['LEGACY_SESSION_FEEDS']
      : [],
    nextSteps: [
      `Open ${root} as a Codex workspace and explicitly trust this path if asked.`,
      'Open /hooks or Review hooks and explicitly approve the KnowNex SessionStart, UserPromptSubmit and Stop hooks. Workspace trust does not replace this approval.',
      'Start a new Codex session to load the skills and the initial context. Init does not change trust or approvals.',
    ],
  };
}
