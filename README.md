# KnowNex

**Release candidate 0.1.0-rc.1:** installazione locale del package e `knownex init`,
poi normale lavoro in Codex con eventuale approvazione degli hook. I checkpoint
restano subordinati a Si/No. [Installazione, aggiornamento e rimozione](docs/INSTALL.md).

Memoria persistente per il lavoro agentico, alimentata dalle conversazioni e
organizzata in documenti Markdown collegati. La visione è in [docs/VISION.md](docs/VISION.md).

**Stato R1–R4:** memoria procedurale con `STATE.md`, `HISTORY.md` append-only e
Knowledge con ID stabili. Il modello principale guida un subagente economico:
prepare congela la finestra pendente dal feed, validate prepara il candidato e
apply lo promuove con sigillo. Nel workspace inizializzato S4 il principale
riconosce autonomamente i milestone e segue la politica di progetto;
gli hook non invocano LLM. Da S4.2 serve un consenso utente Si/No acquisito prima
della delega, per un solo batch. [Consenso](docs/CHECKPOINT-CONSENT.md) e [runtime](docs/RUNTIME.md).
[Contratto](docs/MEMORY-CONTRACT.md) e [procedura](docs/CURATOR.md): il principale
usa la [skill handoff](.agents/skills/knownex-handoff/SKILL.md), il subagente la
[skill curator](.agents/skills/knownex-curator/SKILL.md). Restano il feed nativo
UserPromptSubmit/Stop e Capture Stop/SessionEnd; formati e limiti in
[Native Feed](docs/NATIVE-FEED.md) e [Automatic Capture](docs/AUTOMATIC-CAPTURE.md).
Il feed include gli intermedi testuali Codex verificabili, selezionati durante
Stop; la finestra pending distingue ordine conversazionale e sequenze fisiche
([criteri e limiti](docs/INTERMEDIATE-MESSAGES.md)).
Il [navigatore deterministico](docs/NAVIGATOR.md) espone `memory state`,
`memory find` e `memory read` sulla directory scelta, senza modificare la memoria.

## Requisiti e installazione

Per usare KnowNex in un workspace indipendente, seguire
[Installazione e bootstrap S3](docs/INSTALL.md): archivio npm locale, installazione
nel progetto e `npm exec --offline -- knownex init`. Non occorre lavorare nel
repository sorgente e non viene modificata la configurazione globale Codex.

Windows 11, PowerShell, Git, Node.js 26 LTS (preferito) oppure 24 LTS da 24.11.0,
con npm incluso. VS Code è l’editor di riferimento.
Non serve TypeScript globale. L’ambiente iniziale usa Node 24 già installato.

```powershell
npm ci
npm run dev
npm run build
npm start
```

`dev` usa il type stripping nativo: Node non legge `tsconfig.json` e non esegue
type checking. Usare solo sintassi cancellabile, `import type` per i tipi e
estensioni `.ts` negli import relativi. La build riscrive queste estensioni in
`.js`, senza alias. Il target ES2022 limita la sintassi emessa; la compatibilità
con un futuro extension host richiederà una verifica delle API utilizzate.

## Verifiche

```powershell
npm run check
```

Esegue type checking (anche dei test), test nativi Node, controllo Prettier e build.
Singolarmente: `npm run typecheck`, `npm test`, `npm run format:check`,
`npm run build`. Per formattare: `npm run format`.

## Struttura

- `src/index.ts`, `src/cli.ts`: entry point e comando `knownex sync`.
- `tests/cli.test.ts`: verifica il processo CLI reale.
- `src/reader.ts`, `tests/reader.test.ts`: reader JSONL e test con dati sintetici.
- `src/capture.ts`, `tests/capture.test.ts`: registro persistente e recovery.
- `docs/CAPTURE.md`: formato, contratto e limiti di durabilità del registro.
- `docs/AUTOMATIC-CAPTURE.md`: acquisizione tramite Stop e protezione fra processi.
- `docs/research/S1.0-CODEX-SOURCE.md`: evidenze locali sulla sorgente Codex.
- `docs/VISION.md`: principi confermati e decisioni aperte.
- `AGENTS.md`: istruzioni operative locali.
- `tsconfig.json`: configurazione strict ESM/NodeNext per sorgenti e test.
- `tsconfig.build.json`: build dei soli sorgenti in `dist/`.
- `package-lock.json`: dipendenze riproducibili con `npm ci`.

Git è locale, senza remoti o commit iniziali. `node_modules/`, `dist/` e `graft/`
sono ignorati. Graft è uno strumento opzionale per gli agenti, non è necessario
per installazione, esecuzione o verifiche npm.

## Reader incrementale

`readJsonl(path, cursor?)` da `src/reader.ts` restituisce una Promise con
`{ records, cursor }`. Ogni record espone `raw` (riga originale senza LF, con
eventuale CR) e `value: unknown`. `raw` preserva anche la rappresentazione esatta
dei numeri. Sono accettati tutti i valori JSON, senza interpretare gli eventi.

Il cursore serializzabile contiene `offset` in byte, `fileId` e `prefixHash`.
Ometterlo alla prima lettura; riutilizzare quello restituito dopo aver gestito i
record. Il checkpoint appartiene al chiamante: ripetere un cursore già consumato
restituisce nuovamente gli stessi eventi. Una riga senza LF resta sospesa, anche
se contiene già JSON valido; CRLF è supportato. UTF-8 deve essere valido, senza
BOM; righe vuote e JSON malformato completo causano errore.

`ReaderError` espone `code` (`CURSOR_INVALID`, `FILE_CHANGED`, `JSONL_MALFORMED`)
e `offset`. Un errore non restituisce risultati parziali né aggiorna il cursore;
gli errori I/O nativi, come `ENOENT`, si propagano. Nessun reset è automatico.
Troncamenti sotto l’offset, cambi d’identità e modifiche del prefisso sono rilevati.

Il file è aperto in sola lettura; ogni chiamata considera la dimensione iniziale.
La verifica SHA-256 rilegge il prefisso consumato, con costo lineare; la memoria
richiesta cresce con la coda ancora da leggere, inclusa quella incompleta.
L’append concorrente è supportato; riscritture concorrenti arbitrarie non possono
essere verificate atomicamente senza cooperazione dello scrittore. Un troncamento
seguito da ripristino identico fra due letture non è distinguibile. Il rilevamento
delle sostituzioni dipende dall’identità fornita dal filesystem.

## Acquisizione persistente

`syncSession(source, destination)` da `src/capture.ts` acquisisce i nuovi record
nel file di registro indicato e recupera da lì il checkpoint alle chiamate
successive. Restituisce `{ appended, cursor, recoveredBytes }`.
La directory destinazione deve esistere; il registro richiede un solo processo
scrittore. Formato, recovery ed effettive garanzie sono in [docs/CAPTURE.md](docs/CAPTURE.md).

## CLI

```powershell
npm run build
npm exec --offline --yes -- knownex sync --source "C:\sessioni\session.jsonl" --destination "C:\backup\session.capture.jsonl"
```

Il binario npm si chiama `knownex`: `knownex sync --source <jsonl> --destination <file>`.
Il wrapper `npm exec` lo esegue dalla repository senza installazione globale;
può preparare un collegamento nel cache npm locale. In alternativa usare
`npm start -- sync --source <jsonl> --destination <file>` o, in sviluppo,
`npm run dev -- sync --source <jsonl> --destination <file>`.

Sono accettati percorsi assoluti o relativi alla directory corrente; racchiudere
tra virgolette quelli con spazi. La sorgente deve essere un file e la directory
destinazione deve esistere; sorgente e destinazione coincidenti sono rifiutate.
Opzioni sconosciute, duplicate, mancanti o vuote sono errori. `knownex --help`
mostra la sintassi; anche l’avvio senza argomenti mostra l’aiuto.

Il successo scrive una sola riga JSON su stdout, per esempio:
`{"status":"ok","appended":3,"recoveredBytes":0}`.
Gli errori scrivono su stderr `{"status":"error","code":"..."}` e, per reader
o registro, l’eventuale `offset` in byte. Non vengono stampati contenuti delle
conversazioni, percorsi o messaggi d’eccezione. Exit code: `0` successo, `2`
argomenti invalidi, `1` errore di percorsi, I/O, sorgente o registro.

Il lock del registro esclude scrittori concorrenti fra processi. La recovery è
logica, senza garanzie dimostrate contro perdita di alimentazione.

## Hook Codex su Windows

La dichiarazione `.codex/hooks.json` usa `node` senza virgolette, compatibile con
PowerShell e cmd, e avvia `.codex/hooks/stop.cjs`. A ogni Stop, lo script richiama
la CLI `sync` attraverso `node src/index.ts`, senza duplicare l’acquisizione.
Ogni sessione ha un registro in `.knownex/captures/<sha256(session_id)>.jsonl`;
la directory viene creata automaticamente e i registri sono esclusi da Git.
Il log `.codex/hooks/events.jsonl` contiene solo metadati ed esiti, mai il testo
delle conversazioni. Gli errori diventano avvisi non bloccanti in Codex.
Codex richiede l’approvazione personale della dichiarazione tramite **Review hooks**
o `/hooks`. La diagnosi e lo stato delle prove sono in
[docs/research/CODEX-HOOKS-WINDOWS.md](docs/research/CODEX-HOOKS-WINDOWS.md).
Per concorrenza, timeout e recovery leggere [docs/AUTOMATIC-CAPTURE.md](docs/AUTOMATIC-CAPTURE.md).

Il [contratto di benchmark V0](docs/BENCHMARK-CONTRACT.md) definisce misure,
baseline e gate futuri. `node scripts/measure.ts` raccoglie contesto preparato,
token runtime per turno e byte dei comandi; i risultati rimangono in `.local/`.
V0 non costituisce una qualificazione delle prestazioni di KnowNex.
