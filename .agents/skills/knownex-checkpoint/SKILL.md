---
name: knownex-checkpoint
description: Suggerisce $knownex-checkpoint ai milestone; su invocazione esplicita prepara, delega la curatela una volta e completa il checkpoint nativo. Non usarla per recall o sola amministrazione.
---

# Checkpoint KnowNex — delega nativa

Suggerisci brevemente `$knownex-checkpoint` ai milestone significativi, poi continua il lavoro. Il suggerimento non autorizza. Solo l'invocazione esplicita dell'utente avvia questa procedura; il feed rimane l'autorità del permesso monouso.

1. Usa il runtime locale installato: `node node_modules/knownex/dist/index.js`, oppure `node dist/index.js` nel checkout KnowNex già compilato. Non cercare runtime in altri workspace o cache. Esegui:

   ```text
   <RUNTIME> curate native --stage prepare --work .knownex/internal/curator --authorization captured-user-invocation
   ```

   Il runtime risolve l'invocazione acquisita nel feed, verifica recovery e integrità del registro, consuma il permesso monouso e congela il batch. Non consulta la history Codex. Non inventare sequenze, cutoff o autorizzazioni. Procedi solo su `READY`; conserva `runId` e `requestFile` restituiti senza aprire i documenti. Un errore interrompe il percorso, senza retry.

2. Delega **una sola volta** al custom agent nativo `knownex_curator` (Terra medium), con contesto indipendente: non ereditare la conversazione del principale (`fork_turns: none`, dove esposto). Trasmetti soltanto questo incarico con i riferimenti reali restituiti da prepare:

   ```json
   {
     "version": 1,
     "operation": "checkpoint",
     "workspace": "PERCORSO_WORKSPACE",
     "runId": "RUN_ID",
     "requestFile": "PERCORSO_REQUEST_FILE",
     "workerMode": "materialize-only",
     "skill": ".agents/skills/knownex-curator/SKILL.md"
   }
   ```

   Il Curator legge autonomamente `requestFile` e gli input congelati, svolge tutta la curatela e restituisce soltanto `{ proposal: ricevuta, review: ricevuta }` dell'I/O canonico, oppure un errore. Nessun documento nel messaggio di delega o nel risultato.

3. Attendi il risultato con gli strumenti nativi di attesa dei subagent. Non inviare richieste di avanzamento, supervisione o correzione. Le attese dell'host non sono nuove deleghe. Se Terra fallisce o non consegna entrambe le ricevute, termina con errore compatto senza eseguire complete, correggere artefatti o delegare nuovamente.
4. Con le ricevute reali esegui:

   ```text
   <RUNTIME> curate native --stage complete --work .knownex/internal/curator --run RUN_ID --proposal-sha256 HASH_PROPOSAL --review-sha256 HASH_REVIEW
   ```

   Questa primitiva verifica ricevute, proposta, review, anomalie e integrità finale del batch acquisito, poi applica transazionalmente se consentito. Non ripetere validate, review o apply separatamente. Non interpretare le ricevute come conferma di pubblicazione.

5. Riporta soltanto il risultato conclusivo `SUCCESS`, `BLOCKED` o `ERROR` e i metadati essenziali del runtime.

Non leggere feed, packet, STATE, HISTORY, Knowledge, proposal o review né analizzare le fonti per gestire il checkpoint. Il Curator è responsabile di continuità storica e copertura semantica; il principale coordina soltanto le primitive deterministiche. Non invocare `curate checkpoint`: avvia il launcher esterno. Nessun fallback npm, npx, codex exec, secondo agente, retry o riparazione. Runtime assente: `ERROR / CURATOR_RUNTIME_UNAVAILABLE`.

Se il custom agent o l'attesa nativa non sono disponibili, restituisci `ERROR / CURATOR_NATIVE_UNAVAILABLE` senza sostituire Terra con un altro ruolo/modello. La configurazione project-scoped deve essere caricata dalla sessione Codex.

Un'interruzione del Curator non autorizza un'altra delega. Conserva il risultato diagnostico; solo una nuova invocazione utente può autorizzare un nuovo tentativo. Non dichiarare completo un checkpoint senza un risultato di conferma.
