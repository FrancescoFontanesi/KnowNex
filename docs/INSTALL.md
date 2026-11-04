# Installare KnowNex 0.1.0-rc.1

Richiede Node.js 24.11+ o 26, npm e un workspace Codex. Il package e locale e
privato: non richiede provider, dipendenze runtime o configurazioni globali.

## Installazione nel proprio progetto

Aprire PowerShell nella radice del progetto e indicare l'archivio ricevuto:

```powershell
npm install --offline --no-save --package-lock=false --ignore-scripts --no-audit --no-fund "C:\percorso\knownex-0.1.0-rc.1.tgz"
npm exec --offline -- knownex init
```

Aprire quella cartella come workspace Codex e iniziare una nuova chat dalla sua
radice. Se Codex richiede **Review hooks** o `/hooks`, approvare gli hook del
progetto. Questa approvazione appartiene al runtime e non viene simulata da init.
Non occorre configurare AGENTS.md, skill, memoria o checkpoint.

KnowNex acquisisce gli eventi, fornisce STATE e segnala il pending fra sessioni.
Il principale recupera selettivamente il contesto e propone i checkpoint quando
opportuno. Ogni materializzazione richiede la risposta Si/No dell'utente; non
occorre scegliere cosa salvare. Il comando manuale e opzionale: si puo scrivere
semplicemente «checkpoint» in chat. Nessun modello viene avviato dall'installer.

## Aggiornamento e reinstallazione

Eseguire gli stessi due comandi con il nuovo archivio. La stessa versione e
idempotente. Init aggiorna i file generati non modificati, preserva il testo
personale esterno al blocco KnowNex in AGENTS.md e aggiunge gli ignore necessari
senza cancellare le regole esistenti.

Feed, Capture, memoria, checkpoint, consensi, journal e staging rimangono intatti.
`.knownex/install.json` contiene soltanto versione e hash delle risorse gestite;
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

Init non e una transazione multi-file: dopo un'interruzione puo essere ripetuto
per riusare le risorse complete; evidenze incomplete o modificate vengono segnalate.

## Disinstallazione

```powershell
npm uninstall --no-save --package-lock=false --ignore-scripts --no-audit --no-fund knownex
```

Rimuovere soltanto gli hook KnowNex da `.codex/hooks.json` e i wrapper
`knownex-feed.cjs`, `knownex-stop.cjs`, `knownex-session.cjs`; rimuovere le tre skill
`knownex-handoff`, `knownex-curator`, `knownex-recall` e il blocco `knownex:start/end`
da AGENTS.md, preservando le istruzioni personali. Nessuna configurazione globale
viene modificata. **Conservare `.knownex/`, `memory/` e i log finche servono**:
contengono memoria, sorgenti, consensi ed evidenze. Non cancellarli automaticamente.

## Verifiche e limiti

La release e verificata con `npm run check` e una prova integrata dell'archivio
installato in una cartella temporanea esterna, con payload sintetici e accesso ai
sorgenti negato ai processi runtime. Questi controlli non dimostrano selezione
spontanea delle skill, riconoscimento dei milestone, disponibilita del curator,
dialogo reale Si/No o esecuzione degli hook da parte di Codex. Tali proprieta
richiedono una sessione reale; non sono prerequisiti di configurazione manuale.
I comandi hook sono relativi alla radice: avviare Codex da quella cartella.
Durabilita fisica e limiti NTFS restano quelli di [Storage](STORAGE-DURABILITY.md).
Dettagli tecnici in [Runtime](RUNTIME.md) e [Consenso](CHECKPOINT-CONSENT.md).
