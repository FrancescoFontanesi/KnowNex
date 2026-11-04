import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyMemory } from './curator.ts';

const begin = '<!-- knownex:start -->';
const end = '<!-- knownex:end -->';
const policy = `${begin}
## KnowNex continuity

Conversazione acquisita automaticamente: non chiedere all'utente cosa salvare.
Riusa STATE da SessionStart; quando serve usa knownex-recall selettivamente.
STATE e autorevole fino al checkpoint confermato; eventi successivi possono cambiarlo.
Per continuita usa knownex-recall e knownex pending selettivamente, senza prepare,
consensi, deleghe o scritture: la riconciliazione e solo nel contesto corrente.
Se STATE manca o il pending e incompleto, dichiara i limiti senza fingere completezza.
STATE rappresenta il presente, HISTORY le transizioni, Knowledge il dettaglio tematico.
Preserva obiettivi, decisioni attive, prerequisiti, blocker e attivita critiche aperte.
Aggiorna Knowledge per argomento, integrando piu momenti senza note per turno.
Nei resoconti significativi chiarisci quando pertinenti risultati, decisioni,
evidenze/verifiche, limiti/incertezze, problemi aperti e prossime azioni.
Niente template, sezioni obbligatorie o riepiloghi per turno; non scrivere testo
solo per KnowNex. Mantieni naturale il dialogo anche nelle conversazioni non tecniche.
Riconosci autonomamente milestone: decisione/supersession, risultato verificato,
cambio di focus, handoff o compattazione imminente con lavoro significativo.
Usa knownex-handoff: proponi il checkpoint ai milestone e chiedi una sola conferma Si/No.
Prima del curator serve un Si utente acquisito e legato alla richiesta; No, dubbio
o silenzio rimandano senza perdere pending. Non ripetere la stessa domanda dopo No
senza un nuovo milestone significativo o una richiesta manuale di checkpoint.
Poi pending di progetto, direttiva semantica, una sola delega
al curator economico configurato, prepare → validate → apply con sigillo.
Non materializzare per turno; niente retry LLM automatici o test stateless.
Su indisponibilita/fallimento preserva pending e continua il task; non inventare conferme.
Un batch attivo per workspace. Non leggere interi archivi o rileggere STATE gia disponibile.
${end}
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

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
// Only the exact generated S3 assets are adoptable without an ownership manifest.
// Source archive SHA-256: 202f9d61b8d45037c5c16699db7f53ea5f5857ea7e3ef01c87fe5a4a3b5bdcb9.
const s3Hashes: Record<string, string> = {
  '.agents/skills/knownex-handoff/SKILL.md':
    'f10588eb4f9ddab3b92c6d848082caeb4c1a421c4b543d8521e237bffcc86f9b',
  '.agents/skills/knownex-curator/SKILL.md':
    '6c29d4489ee13ec0cc30b922bf49bbff74f3585e249cabd47445f19a778fe0d3',
  '.agents/skills/knownex-recall/SKILL.md':
    '092f9a12a30e2ba6c319505378a33c7df036730c0b0e79501b71ac01c7a7e3de',
  '.knownex/docs/CURATOR.md':
    'cd40c30bed2cea5443d94d1fdb2545f5b8580495cd8dad4a2ee9692f508c9fdc',
  '.knownex/docs/MEMORY-CONTRACT.md':
    '2cbcd4094dc916ad59c0ccae0721e98f34bde4bc8a055bdc6c05148b1af12e7c',
  '.knownex/docs/STORAGE-DURABILITY.md':
    '87f95ed4bfa66e299ecc83db2cccc00f01776ecb3c564f0366075f1f9e8c397e',
  '.knownex/docs/NAVIGATOR.md':
    '03c7bf5948616e43e97028b0e8b438e419f868afdafeb9ac1439a566112120d5',
  '.codex/hooks/knownex-stop.cjs':
    '1fd69fb0975278581764ce8519ab7bd3db8e34e6d03c5e29340c774e041e8d75',
  '.codex/hooks/knownex-feed.cjs':
    '1fb4e70c53af4645efe990f0d32a277335f639e2fa84ef9da84d1dcdef336804',
  '.codex/hooks.json':
    '0b9dc4ac892320a439b9fcc6e0ba233a92edb7ca0c2311eabfa6c7b08fd35f9a',
  '.knownex/START.md':
    '8dd841614602447afce35bf029e7be3a77eb0f2c18faa621b58a2f31ee28768b',
};
const skillNames = ['knownex-handoff', 'knownex-curator', 'knownex-recall'];
const docNames = [
  'CURATOR.md',
  'MEMORY-CONTRACT.md',
  'STORAGE-DURABILITY.md',
  'NAVIGATOR.md',
  'RUNTIME.md',
  'CHECKPOINT-CONSENT.md',
];

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

/** Project-only bootstrap: preflight conflicts, then create missing files exclusively. */
export async function initWorkspace(directory: string) {
  await mkdir(resolve(directory), { recursive: true });
  const root = await realpath(directory);
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
  for (const name of skillNames) {
    files.set(
      `.agents/skills/${name}/SKILL.md`,
      (
        await readFile(
          join(packageRoot, '.agents/skills', name, 'SKILL.md'),
          'utf8',
        )
      )
        .replaceAll('../../../docs/', '../../../.knownex/docs/')
        .replace(
          'Il binario è `knownex`; dalla repository puoi usare `npm start -- memory ...`\ndopo la build, con gli stessi argomenti.',
          'Nel progetto usa `npm exec --offline -- knownex memory ...`, con gli stessi argomenti.',
        ),
    );
  }
  for (const name of docNames) {
    files.set(
      '.knownex/docs/' + name,
      (await readFile(join(packageRoot, 'docs', name), 'utf8'))
        .replaceAll('../.agents/skills/', '../../.agents/skills/')
        .replaceAll(
          'npm run curate --',
          'npm exec --offline -- knownex curate',
        ),
    );
  }
  for (const name of ['stop', 'feed', 'session']) {
    files.set(
      `.codex/hooks/knownex-${name}.cjs`,
      "const { resolve, join } = require('node:path');\n" +
        "const root = resolve(__dirname, '../..');\n" +
        'process.env.KNOWNEX_WORKSPACE = root;\n' +
        "process.env.KNOWNEX_PROJECT_FEED = '1';\n" +
        `require(join(root, 'node_modules/knownex/.codex/hooks/${name}.cjs'));\n`,
    );
  }
  const hook = (name: string, timeout: number) => ({
    type: 'command',
    command: `node ".codex/hooks/knownex-${name}.cjs"`,
    timeout,
  });
  files.set(
    '.codex/hooks.json',
    JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [hook('session', 10)] }],
          UserPromptSubmit: [{ hooks: [hook('feed', 10)] }],
          Stop: [{ hooks: [hook('stop', 10), hook('feed', 10)] }],
          SessionEnd: [{ hooks: [hook('stop', 3)] }],
        },
      },
      null,
      2,
    ) + '\n',
  );
  files.set(
    '.knownex/START.md',
    '# KnowNex runtime\n\n' +
      'Avvia Codex dalla radice del progetto e approva gli hook quando richiesto.\n' +
      'SessionStart (anche dopo compact) rende disponibili STATE e pending di progetto.\n' +
      'Il principale propone checkpoint ai milestone e attende il consenso Si/No prima del curator.\n' +
      'CLI locale: npm exec --offline -- knownex runtime\n' +
      'Feed unico: .knownex/feed/project.jsonl. Seed: memory/. Confermata: .knownex/curator/memory.\n' +
      'Nessun LLM dagli hook. Nessuna materializzazione garantita dopo SessionEnd.\n',
  );
  const editable = new Set([
    'memory/STATE.md',
    'memory/HISTORY.md',
    '.knownex/feed/project.jsonl',
    '.gitignore',
  ]);
  files.set('memory/STATE.md', emptyMemory['STATE.md']!);
  files.set('memory/HISTORY.md', emptyMemory['HISTORY.md']!);
  files.set('.knownex/feed/project.jsonl', '');
  files.set('AGENTS.md', policy);
  files.set(
    '.gitignore',
    'node_modules/\n.knownex/\n.codex/hooks/events.jsonl\n.codex/hooks/feed-events.jsonl\n',
  );
  const missing: string[] = [],
    preserved: string[] = [];
  const updates = new Map<string, { before: string; after: string }>();
  const manifestName = '.knownex/install.json';
  await safePath(root, manifestName);
  let manifestBefore: string | undefined;
  let previous = s3Hashes;
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
    '.knownex/feed',
    '.knownex/captures',
    'memory/knowledge',
  ];
  for (const name of directories) await safePath(root, name);
  for (const [name, content] of files) {
    await safePath(root, name);
    try {
      const current = await readFile(join(root, name), 'utf8');
      if (name === 'AGENTS.md') {
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
        if (previous[name] !== hash(current)) fail('BOOTSTRAP_CONFLICT', name);
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
            .filter(([name]) => !editable.has(name) && name !== 'AGENTS.md')
            .map(([name, content]) => [name, hash(content)]),
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
    warnings: (await readdir(join(root, '.knownex/feed'))).some((name) =>
      /^[a-f0-9]{64}\.jsonl$/.test(name),
    )
      ? ['LEGACY_SESSION_FEEDS']
      : [],
  };
}
