# Diagnosi hook Stop su Windows

Questa nota documenta la validazione S1.4 del trasporto dei metadati. Il successivo
collegamento alla CLI è descritto in [AUTOMATIC-CAPTURE.md](../AUTOMATIC-CAPTURE.md).

Ambiente verificato: VS Code `26.51021.22027`, runtime Codex
`0.164.0-alpha.11.1`, PowerShell 5.1. Nessuna modifica manuale al trust o agli
hook globali. La configurazione di progetto registra soltanto metadati.

## Causa riprodotta e correzione

Il comando iniziale era:

```text
"F:/NodeJs/node.exe" "F:/KnowNex/.local/s1.4-hook/stop.cjs"
```

In `cmd.exe` funziona; in PowerShell produce `ParserError / UnexpectedToken`:
un percorso eseguibile fra virgolette è un’espressione stringa e richiede un
operatore di invocazione. Il comando corretto usa il nome del programma senza
virgolette e mantiene fra virgolette il percorso dello script:

```text
node "F:/KnowNex/.codex/hooks/stop.cjs"
```

Il percorso assoluto è intenzionalmente quello di questo workspace. Se il
progetto viene spostato, aggiornare la dichiarazione e riesaminarne il trust.
Node deve essere disponibile nel PATH dell’estensione, come richiesto dal progetto.

Il test `tests/codex-hook.test.ts` esegue la dichiarazione configurata in entrambe
le shell native, con uno script copiato in una fixture con spazi nel percorso.
Prima della correzione fallisce in PowerShell e passa in cmd; dopo passa in
entrambe. Verifica anche l’assenza del contenuto della conversazione nei metadati.

## Conferme nel runtime esatto

Un harness locale di diagnosi, in `.local/hooks-debug/repro.cjs`, avvia il vero
app-server Codex e serve una risposta sintetica tramite HTTP su localhost.
Non usa un modello remoto, non registra richieste HTTP e non disabilita il trust.
Le sue sessioni sono prove del runtime, non prove dell’interfaccia VS Code.

Con la dichiarazione iniziale già autorizzata per `f:\KnowNex`, il runtime emette
`hook/started` per lo Stop di progetto, poi `hook/completed` con `status: failed`
ed errore `hook exited with code 1`. La conversazione termina normalmente.
Il sorgente del runtime conferma che gli exit code diversi da 0 e 2 non mostrano
lo stderr nella sintesi dell’errore: per questo il ParserError non era visibile
nelle verifiche basate soltanto sull’assenza del file di log.

## Differenza F: / f:

Le chiavi di trust includono il percorso testuale della sorgente senza
normalizzazione del case. `hooks/list` può quindi mostrare `trusted` per
`f:\KnowNex` e `untrusted` per `F:\KnowNex`, con lo stesso hash.

Il `cwd` normalizzato nel `turn_context` non basta però a identificare la chiave
usata dal registro degli hook. La prova locale con `cwd` iniziale minuscolo
esegue l’hook di progetto nonostante il `cwd` del turno normalizzato maiuscolo.
La differenza di case è reale, ma non era una spiegazione sufficiente del
fallimento osservato in VS Code.

## Stato della validazione

- Test di regressione delle shell: superato.
- `npm run check`: 37 test superati dopo la rimozione del watcher, type checking,
  formattazione e build verdi.
- Nuova dichiarazione: approvata personalmente dall’utente per `F:\KnowNex`,
  hash `sha256:f0d60599157a1cb9f74e65fb545917516a58bad39c65e4b8840b03f8069eacc7`.
- Prova del runtime con la nuova dichiarazione autorizzata: superata. Lo Stop di
  progetto emette `hook/started` e `hook/completed` con stato `completed`; registra
  il transcript della sessione `01a19eb2-99d8-7223-a7ee-3f18d6c96d63`, leggibile
  e con ID corrispondente. Il turno completa e l’harness termina con exit code 0.
- Prova finale in una nuova chat VS Code: superata. La sessione
  `01a19eb4-1ffe-79b1-b2a0-2484639825ee` registra automaticamente `Stop`.
  `transcript_path` punta al JSONL della stessa sessione, leggibile e con ID
  corrispondente. Sono verificati il messaggio di prova distinto e la risposta,
  un solo turno completato e zero chiamate tool. L’utente conferma che la risposta
  arriva normalmente. La nuova chat è quindi distinta dal test sintetico.

La variante `f:\KnowNex` conserva l’approvazione del vecchio hash e risulta
`modified`; `F:\KnowNex` è `trusted` per il comando corretto. Nessuna variante è
stata autorizzata automaticamente. Nella prova finale VS Code registra `cwd`
minuscolo nei metadati iniziali, ma usa il contesto normalizzato maiuscolo:
questa chat esegue correttamente lo Stop approvato per `F:\KnowNex`.
L’identità realmente usata dal runtime va quindi verificata; non va dedotta dal
solo `cwd` visualizzato o da una lettura `hooks/list` su un alias del percorso.
La sola coppia `source: vscode` / `originator: codex_vscode` non dimostra l’uso
dell’interfaccia: anche il processo di diagnosi lanciato dall’ambiente VS Code
riceve questi metadati. La conferma UI usa un messaggio di prova distinto e
un’azione personale dell’utente.

Lo script legge stdin in UTF-8 e scrive soltanto `session_id`, `transcript_path`,
`event` e `timestamp` in `.codex/hooks/events.jsonl`, escluso da Git.
Restituisce `{}` e non chiede continuazioni. Non richiama ancora `syncSession()`.

Esito: hook Stop disponibile e validato nell’estensione locale. La configurazione
e lo script restano nel progetto; non sono più gli artefatti temporanei delle
prove precedenti. La differenza di case nelle chiavi di trust rimane un limite
del runtime; non è stata corretta alterando Codex o i suoi controlli di trust.

Dopo la verifica positiva, il listener filesystem introdotto in S1.5 è stato
rimosso su richiesta dell’utente: modulo, comando `watch`, timer di riconciliazione,
gestori di segnali dedicati e relativi test e documenti. Restano il reader,
`syncSession()` e `knownex sync`. L’hook conserva il perimetro S1.4 e registra
soltanto metadati: l’acquisizione automatica del contenuto non è ancora collegata.

## Fonti

- [Contratto ufficiale e trust degli hook](https://learn.chatgpt.com/docs/hooks).
- [Shell ereditata dall’ambiente, versione esatta](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/core/src/session/mod.rs#L5557).
- [Avvio del comando nella shell](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/hooks/src/engine/command_runner.rs#L406).
- [Sintesi dei risultati Stop](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/hooks/src/events/stop.rs#L232).
- [Costruzione della chiave di trust](https://github.com/openai/codex/blob/rust-v0.164.0-alpha.11.1/codex-rs/hooks/src/lib.rs#L120).
