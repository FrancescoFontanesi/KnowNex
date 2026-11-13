# Installare KnowNex 0.1.0-rc.11

Richiede Node.js 24.11+ o 26, npm e un workspace Codex. Il package e locale e
privato: non richiede provider, dipendenze runtime o configurazioni globali.

## Installazione nel proprio progetto

Aprire PowerShell nella radice del progetto e indicare l'archivio ricevuto:

```powershell
npm install --offline --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "C:\percorso\knownex-0.1.0-rc.11.tgz"
npm exec --offline -- knownex init
```

La CLI resta locale: `npm install` genera gli shim in `node_modules/.bin`,
compreso `knownex.cmd` su Windows. Dalla radice del progetto usare
`npm exec --offline -- knownex ...`, anche per `memory state` e `memory read`.
Non serve un'installazione globale. Copiare soltanto `node_modules/knownex`
non equivale a installare il pacchetto e non genera gli shim npm.

Init restituisce anche `nextSteps`: aprire l'esatta radice del progetto in
Codex, autorizzarla esplicitamente se richiesto e approvare gli hook con
`/hooks` o **Review hooks**, poi avviare una nuova sessione. Autorizzare una
cartella contenitore non prova il trust dei singoli workspace figli. Init
non scrive nel `config.toml` globale e non approva gli hook.

### Claude Code

```powershell
npm exec --offline -- knownex init --provider codex,claude
```

`--provider` sceglie quali harness registrare (`codex`, `claude` o entrambi);
senza opzione init mantiene i provider gia installati, Codex per un progetto
nuovo. Per Claude Code init crea `.claude/hooks/knownex-*.cjs`, aggiunge i propri
hook SessionStart, UserPromptSubmit, Stop e SessionEnd a `.claude/settings.json`
conservando impostazioni e hook esistenti, e inserisce lo stesso blocco di
istruzioni in `CLAUDE.md`. Gli eventi entrano nello stesso feed di progetto con
`provider: "claude"`; il turno e il `prompt_id` di Claude, i turni dei subagenti
non vengono registrati. Un `.claude/settings.json` non leggibile come JSON produce
`BOOTSTRAP_CLAUDE_SETTINGS_INVALID`. Aprire il progetto in Claude Code, accettare
il trust del workspace e verificare gli hook con `/hooks`. Claude Code inietta al
massimo 10.000 caratteri di contesto: uno STATE piu lungo arriva come file con
un'anteprima.

Gli hook globali di altri strumenti, come Graft, restano separati e non vengono
modificati. Un `.codex/hooks.json` locale preesistente e non gestito produce
`BOOTSTRAP_CONFLICT`: confrontare e integrare esplicitamente i file, senza
cancellare hook personali per forzare l'installazione.

Aprire quella cartella come workspace Codex e iniziare una nuova chat dalla sua
radice. Se Codex richiede **Review hooks** o `/hooks`, approvare gli hook del
progetto. Questa approvazione appartiene al runtime e non viene simulata da init.
Prima di una prova nativa eseguire `npm exec --offline -- knownex preflight --workspace <directory>`:
interroga `hooks/list` senza eseguire hook o acquisire autorizzazioni. Distingue
hook di cattura assenti, disabilitati, non approvati e approvati. Il trust del
workspace non sostituisce l'approvazione dei singoli hook tramite `/hooks` o
**Review hooks**. `ready` verifica disponibilita e approvazione; non attesta una
cattura reale (`executionVerified: false`). Il comando restituisce exit code 1
se il controllo e bloccato. Non modifica trust o approvazioni.
Usare la stessa grafia del percorso che verra passata alla sessione Codex:
il preflight la preserva nelle chiamate native, anche per la lettera del drive
Windows. Il controllo hook e diagnostico e non viene eseguito automaticamente
dal checkpoint; autorizzazione e integrita del feed restano obbligatorie nel runtime.
Le interfacce native di diagnostica mantengono i codici pubblici degli errori App Server; il checkpoint non le avvia.
Il runtime conserva diagnostici esclusivi in `.knownex/internal/diagnostics/`:
fase, metodo RPC, eseguibile richiesto e risoluzione PATH stimata, cwd, avvio,
terminazione, durata e codice originale. Messaggi e stderr non riconosciuti
come errori privi di contenuto sono sostituiti da fingerprint SHA-256; payload
RPC e conversazioni non vengono salvati. Questi diagnostici non cambiano
integrita del feed, autorizzazione o pubblicazione e non sono restituiti al chiamante.
Il processo App Server riceve il `CODEX_HOME` esplicito o, se assente, la stessa
home predefinita risolta da Node (`homedir()/.codex`). Non viene creata una home
alternativa ne vengono concessi permessi aggiuntivi. I diagnostici distinguono
avvio, inizializzazione e lettura history, conservando gli errori noti di home
assente e accesso negato. Un App Server che richiede scritture negate dalla
sandbox rimane bloccato: questa risoluzione della home non aggira le ACL.
Non occorre configurare AGENTS.md, skill, memoria o checkpoint.
Lo STATE iniziale e quello confermato hanno lo stesso percorso .knownex/memory/STATE.md.
HISTORY e Knowledge per checkpoint sono nella stessa memoria; feed, capture e
Curator risiedono in .knownex/internal/. Nessuna seed/ o memory/ nella root.
La rc.11 distribuisce questo layout nelle nuove installazioni. [Layout canonico e compatibilita legacy](MEMORY-LAYOUT.md).

Init rimuove da installazioni precedenti, se non modificati, skill
`knownex-checkpoint`, custom agent `knownex_curator`/`knownex_recaller` e
`.codex/config.toml`. Nessuna configurazione globale viene modificata. KnowNex non
installa, inizializza o esegue Graft.

KnowNex acquisisce gli eventi, fornisce STATE e segnala il pending fra sessioni.
Il principale riusa il contesto disponibile, legge direttamente un riferimento gia
noto con `memory read` e delega storia, tassonomia e ricerche a un subagente
generico dell'harness che segue la skill `knownex-recall`. I permessi sono quelli
dell'harness. Se la delega manca, il principale segnala il limite senza fallback
automatico.

Il principale suggerisce il comando di checkpoint ai milestone significativi, senza
aspettare una risposta, e non cura mai la memoria. Per salvare l'utente esegue
`npm exec --offline -- knownex checkpoint (--codex | --claude) [-m MODEL] [-r EFFORT]`
(o lo chiede esplicitamente al principale, che lo lancia in background); l'esecuzione
tratta un solo batch. Dettagli in [CURATION-WORKFLOW.md](CURATION-WORKFLOW.md#comando-knownex-checkpoint).
Nessun modello viene avviato dall'installer.

Il checkpoint usa il feed acquisito e non richiede App Server, history Codex o
accesso ai database globali. Le interfacce native opzionali di preflight hook
richiedono un Codex compatibile nel PATH, o KNOWNEX_CODEX_BIN,
e il CODEX_HOME della sessione; non sono prerequisiti della materializzazione.

## Aggiornamento e reinstallazione

Eseguire gli stessi due comandi con il nuovo archivio. La stessa versione e
idempotente. Init aggiorna i file generati non modificati, preserva il testo
personale esterno al blocco KnowNex in AGENTS.md e aggiunge gli ignore necessari
senza cancellare le regole esistenti.

Feed, Capture, memoria, checkpoint, consensi, journal e staging rimangono intatti.
`.knownex/internal/install.json` (legacy: `.knownex/install.json`) contiene soltanto versione e hash delle risorse gestite;
non e un registro della memoria. Una differenza nei file gestiti viene aggiornata
solo se corrisponde all'hash installato. Per S3, privo di manifest, sono riconosciuti
soltanto gli hash esatti delle risorse distribuite nell'archivio originale.

Modifiche personali a hook, skill o documenti gestiti producono
`BOOTSTRAP_CONFLICT` con il file coinvolto, prima di aggiornare i file del progetto.
Non cancellare memoria o configurazioni per aggirarlo: conservare le modifiche e
confrontarle esplicitamente con la nuova versione. Marker AGENTS ambigui, symlink
nei percorsi gestiti o manifest corrotti sono rifiutati.

I feed legacy per-sessione sono conservati e segnalati come
`LEGACY_SESSION_FEEDS`: l'aggiornamento del package non e una migrazione del loro
contenuto nel feed di progetto. Anche spostare un workspace curato richiede
revisione: i checkpoint mantengono i percorsi del workspace originale.

La politica domanda/risposta rimane eliminata dalla rc.4. I vecchi consent.json vengono
preservati ma non letti. Un batch non confermato del vecchio protocollo puo essere
ritirato, non applicato; gli apply gia autorizzati recuperano attraverso il journal.
Per iniziare un nuovo batch serve un nuovo avvio di `knownex checkpoint`.
L'aggiornamento non avvia checkpoint. Aprire una nuova chat per caricare le skill
aggiornate ed evitare le istruzioni del workflow precedente rimaste nel contesto.

Le cartelle `memory/` preesistenti non vengono cancellate o modificate: potrebbero
contenere note personali o dati di versioni precedenti. Il nuovo workflow non le
usa implicitamente; restano consultabili con `--memory memory` se necessario.

## Disinstallazione

```powershell
npm uninstall --no-save --package-lock=false --ignore-scripts --no-audit --no-fund knownex
```

Rimuovere soltanto gli hook KnowNex da `.codex/hooks.json` e i wrapper
`knownex-feed.cjs`, `knownex-stop.cjs`, `knownex-session.cjs`; rimuovere le tre skill
`knownex-curator`, `knownex-recall`, `knownex-taxonomy` e il blocco `knownex:start/end`
da AGENTS.md, preservando le istruzioni personali. Nessuna configurazione globale
viene modificata. **Conservare `.knownex/`, `memory/` e i log finche servono**:
contengono memoria, sorgenti, consensi ed evidenze. Non cancellarli automaticamente.

## Verifiche e limiti

La release e verificata con `npm run check` e una prova integrata dell'archivio
installato in una cartella temporanea esterna, con payload sintetici e accesso ai
sorgenti negato ai processi runtime. Questi controlli non dimostrano selezione
spontanea delle skill, riconoscimento dei milestone, disponibilita del curator,
invocazione reale della skill o esecuzione degli hook da parte di Codex. Tali proprieta
richiedono una sessione reale; non sono prerequisiti di configurazione manuale.
I comandi hook sono relativi alla radice: avviare Codex da quella cartella.
Durabilita fisica e limiti NTFS restano quelli di [Storage](STORAGE-DURABILITY.md).
Dettagli tecnici in [Runtime](RUNTIME.md) e [Consenso](CHECKPOINT-CONSENT.md).
