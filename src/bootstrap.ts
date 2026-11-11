import { workspaceLayout } from './layout.ts';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyMemory } from './curator.ts';

const begin = '<!-- knownex:start -->';
const end = '<!-- knownex:end -->';
const policy = `<!-- knownex:start -->

## KnowNex continuity

La conversazione viene acquisita automaticamente dagli hook. Non chiedere all'utente cosa salvare e non produrre riepiloghi artificiali per alimentare la memoria.

### Contesto e recupero

- **STATE** è l'handoff automatico all'avvio di una nuova sessione nello stesso workspace: riusalo con il contesto conversazionale, senza reiniezioni per turno o consultazioni periodiche. Gli hook attuali lo emettono anche dopo compact; questo intervento non ne cambia il comportamento.
- STATE rappresenta lo stato del progetto fino all'ultimo checkpoint confermato. Eventi successivi possono averlo modificato.
- Se il contesto disponibile è sufficiente, prosegui senza Recall. Un riferimento già noto (una nota o una finestra linkata da STATE, un ID \`H…\`) leggilo direttamente con \`npm exec --offline -- knownex memory read\`: è una sola lettura. Per una ricerca (riferimento ignoto, storia, revisioni, pending) delega una richiesta precisa a \`knownex_recaller\`, con workspace, riferimenti già noti e minimo contesto necessario. Usa \`fork_turns="none"\` dove supportato, senza trasferire la conversazione completa.
- Oltre alla lettura di un riferimento noto, il principale non naviga STATE, Knowledge, HISTORY o pending per Recall e non supervisiona i documenti: per le ricerche attende il risultato mirato e prosegue. Se la delega nativa non è disponibile, segnala il limite senza fallback automatico a ricerche dirette, altri ruoli o launcher esterni.
- \`knownex_recaller\` usa la skill \`knownex-recall\` in sola consultazione, senza checkpoint, curatela o altre deleghe. Le sue restrizioni sono comportamentali; i permessi effettivi dipendono dall'harness. Queste istruzioni di delega riguardano il principale, non il Recaller.
- STATE contiene il presente, Knowledge i dettagli tematici, HISTORY le transizioni. Non esplorare interi archivi senza necessità.
- Riutilizza informazioni e documenti già recuperati durante il turno. Non ripetere letture per semplice conferma.
- Se il contesto è incompleto, il pending è parziale o un'informazione manca, dichiarane i limiti senza inventare fatti.

### Continuità e checkpoint

Mantieni naturale la conversazione. Esplicita decisioni, risultati, evidenze e problemi aperti quando pertinenti al task, senza template o sezioni obbligatorie.

Riconosci milestone significative (decisioni sostituite, risultati verificati, cambi di focus, handoff o compattazioni rilevanti). Puoi suggerire \`$knownex-checkpoint\`, continuando il lavoro, ma **solo l'invocazione esplicita dell'utente** autorizza il checkpoint. Un assenso generico non equivale all'invocazione.

Su \`$knownex-checkpoint\` esplicito:

1. Esegui \`curate native --stage prepare\`.
2. Delega una sola volta a \`knownex_curator\`, passando \`requestFile\` e contesto indipendente.
3. Attendi le ricevute e completa con \`curate native --stage complete\`.

Terra esegue la curatela in modalità \`materialize-only\`. Il principale coordina, ma non legge feed, packet, STATE, HISTORY, Knowledge, proposta o review per supervisionarla e non ripete la valutazione semantica.

Non utilizzare il launcher esterno, \`codex exec\`, npm/npx o altre modalità come fallback per il checkpoint. Nessun retry LLM automatico, materializzazione per turno o test stateless.

Un solo batch attivo per workspace. Il comando prepare esplicito congela il batch; il feed non deve contenere un'invocazione o un permesso. Un prepare ripetuto restituisce lo stesso batch attivo, senza autorizzare altre deleghe. Anomalie o incertezze dichiarate impediscono la pubblicazione automatica; l'autoverifica del Curator e i controlli strutturali non garantiscono da soli la completezza semantica.

In caso di indisponibilità o fallimento, preserva il pending, riferisci il limite e prosegui il task senza inventare conferme.
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
const skillNames = [
  'knownex-checkpoint',
  'knownex-curator',
  'knownex-recall',
  'knownex-taxonomy',
];
const docNames = [
  'CURATOR.md',
  'CURATION-WORKFLOW.md',
  'MEMORY-LAYOUT.md',
  'MEMORY-CONTRACT.md',
  'KNOWLEDGE-REVISIONS.md',
  'TAXONOMY.md',
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
  files.set(
    '.codex/config.toml',
    await readFile(join(packageRoot, '.codex/config.toml'), 'utf8'),
  );
  for (const role of ['knownex_curator', 'knownex_recaller']) {
    const name = `.codex/agents/${role}.toml`;
    files.set(name, await readFile(join(packageRoot, name), 'utf8'));
  }
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
  files.set(
    '.agents/skills/knownex-taxonomy/agents/openai.yaml',
    await readFile(
      join(packageRoot, '.agents/skills/knownex-taxonomy/agents/openai.yaml'),
      'utf8',
    ),
  );
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
          SessionStart: [
            { hooks: [{ ...hook('session', 10), additionalContextLimit: 0 }] },
          ],
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
      'Il principale suggerisce $knownex-checkpoint ai milestone; solo una invocazione utente esplicita avvia il curator.\n' +
      'CLI locale: npm exec --offline -- knownex runtime\n' +
      'Feed unico: .knownex/feed/project.jsonl. Seed: .knownex/seed/. Confermata: .knownex/curator/memory.\n' +
      'Nessun LLM dagli hook. Nessuna materializzazione garantita dopo SessionEnd.\n',
  );
  const editable = new Set([
    '.knownex/seed/STATE.md',
    '.knownex/seed/HISTORY.md',
    '.knownex/feed/project.jsonl',
    '.gitignore',
  ]);
  files.set('.knownex/seed/STATE.md', emptyMemory['STATE.md']!);
  files.set('.knownex/seed/HISTORY.md', emptyMemory['HISTORY.md']!);
  files.set('.knownex/feed/project.jsonl', '');
  files.set('AGENTS.md', policy);
  files.set(
    '.gitignore',
    'node_modules/\n.knownex/\n.codex/hooks/events.jsonl\n.codex/hooks/feed-events.jsonl\n',
  );
  const layout = workspaceLayout(root);
  if (!layout.legacy) {
    const remap = (name: string) =>
      name
        .replace('.knownex/seed/', '.knownex/memory/')
        .replace('.knownex/feed/', '.knownex/internal/feed/')
        .replace('.knownex/docs/', '.knownex/internal/docs/')
        .replace('.knownex/START.md', '.knownex/README.md');
    for (const [name, text] of [...files]) {
      files.delete(name);
      files.set(
        remap(name),
        name === '.knownex/START.md'
          ? '# Memoria KnowNex\n\nApri [STATE](memory/STATE.md) per riprendere il lavoro e [HISTORY](memory/HISTORY.md) per gli stati precedenti.\n\nLe [Knowledge](memory/knowledge/) sono revisioni immutabili organizzate per checkpoint, con categorie facoltative. Segui i link dallo STATE: le note invariate restano nei checkpoint precedenti.\n\nTaxonomy, associazioni e topics sono viste organizzative accessorie in memory/. internal/ contiene feed, capture, run, journal e ricevute: non modificarli manualmente.\n\nSessionStart fornisce STATE; soltanto $knownex-checkpoint autorizza una nuova materializzazione.\n'
          : text
              .replaceAll('../../.agents/skills/', '../../../.agents/skills/')
              .replaceAll(
                '../../../.knownex/docs/',
                '../../../.knownex/internal/docs/',
              ),
      );
    }
    for (const name of [...editable]) {
      editable.delete(name);
      editable.add(remap(name));
    }
  }
  const missing: string[] = [],
    preserved: string[] = [];
  const updates = new Map<string, { before: string; after: string }>();
  const manifestName = layout.legacy
    ? '.knownex/install.json'
    : '.knownex/internal/install.json';
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
    relative(root, layout.feed).split('\\').join('/'),
    relative(root, layout.captures).split('\\').join('/'),
    relative(root, join(layout.memory, 'knowledge')).split('\\').join('/'),
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
  // Retire only the exact owned old entrypoint; preserve any other user resources.
  const retired = new Map<string, string>();
  const oldSkill = '.agents/skills/knownex-handoff/SKILL.md';
  await safePath(root, oldSkill);
  try {
    const current = await readFile(join(root, oldSkill), 'utf8');
    if (previous[oldSkill] !== hash(current))
      fail('BOOTSTRAP_CONFLICT', oldSkill);
    retired.set(oldSkill, current);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
  for (const [name, before] of retired) {
    await safePath(root, name);
    if ((await readFile(join(root, name), 'utf8')) !== before)
      fail('BOOTSTRAP_CONFLICT', name);
    await unlink(join(root, name));
    try {
      await rmdir(dirname(join(root, name)));
    } catch (error) {
      if (
        !['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        )
      )
        throw error;
    }
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
    removed: [...retired.keys()],
    preserved,
    warnings: (await readdir(layout.feed)).some((name) =>
      /^[a-f0-9]{64}\.jsonl$/.test(name),
    )
      ? ['LEGACY_SESSION_FEEDS']
      : [],
    nextSteps: [
      `Apri ${root} come workspace Codex e autorizza esplicitamente questo percorso se richiesto.`,
      'Apri /hooks o Review hooks e approva esplicitamente gli hook KnowNex SessionStart, UserPromptSubmit, Stop e SessionEnd. Il trust del workspace non sostituisce questa approvazione.',
      'Avvia una nuova sessione Codex per caricare skill e contesto iniziale. Init non modifica trust o approvazioni.',
    ],
  };
}
