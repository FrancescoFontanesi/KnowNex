# KnowNex 0.1.0-rc.11

KnowNex conserva il contesto di un progetto tra sessioni Codex. Il feed acquisito
dagli hook e la fonte della materializzazione: STATE descrive il presente,
HISTORY le transizioni e Knowledge i dettagli navigabili.

## Installazione locale

Richiede Node.js 24.11+ o 26 e npm. Dalla radice del progetto:

```powershell
npm install --offline --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "C:\percorso\knownex-0.1.0-rc.11.tgz"
npm exec --offline -- knownex init
```

Npm genera gli shim locali, incluso `knownex.cmd`; non serve installazione
globale. Init preserva le istruzioni personali esterne al blocco KnowNex.
Distribuisce curator, recall e taxonomy opzionale e gli hook SessionStart, UserPromptSubmit, Stop e SessionEnd.
Su installazioni precedenti rimuove, se non modificati, skill checkpoint, custom agent e `.codex/config.toml`.

Aprire esattamente quel workspace in Codex, autorizzarlo esplicitamente se
richiesto e approvare gli hook tramite `/hooks` o **Review hooks**. Trust del
workspace e approvazione degli hook sono distinti. Init restituisce `nextSteps`
e non modifica configurazioni globali o privilegi. Avviare una nuova sessione.

## Uso corrente

SessionStart rende disponibile STATE; Recall recupera selettivamente i dettagli:

```powershell
npm exec --offline -- knownex memory state
npm exec --offline -- knownex memory read "knowledge/tema.md"
```

Il checkpoint si esegue solo con `npm exec --offline -- knownex checkpoint (--codex | --claude)`,
avviato dall'utente. Il percorso usa il feed, senza App Server annidati; dettagli in
[CURATION-WORKFLOW.md](CURATION-WORKFLOW.md#comando-knownex-checkpoint).

Per aggiornare ripetere installazione e init. Reinstallazione idempotente e
controlli di ownership preservano i dati; modifiche ai file gestiti producono
`BOOTSTRAP_CONFLICT` e richiedono confronto esplicito, senza cancellazioni.

## Guide operative

- [Installazione, aggiornamento e rimozione](INSTALL.md).
- [Workflow nativo e responsabilita](CURATION-WORKFLOW.md).
- [Cold Start e pending](RUNTIME.md).
- [Layout e compatibilita dei dati](MEMORY-LAYOUT.md).
- [Verifiche e limiti della versione corrente](RELEASE-CANDIDATE.md).
