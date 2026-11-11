---
name: knownex-checkpoint
description: Esegue un checkpoint KnowNex quando l'utente invoca esplicitamente $knownex-checkpoint. Congela gli eventi acquisiti, delega una volta la curatela a knownex_curator in parallelo al lavoro corrente e completa la pubblicazione. Ai milestone significativi suggerisce soltanto l'invocazione. Non usarla per il recall né per leggere o correggere la memoria.
---

# Checkpoint KnowNex

Ai milestone significativi (decisioni sostituite, risultati verificati, cambi di focus) puoi suggerire in una riga `$knownex-checkpoint` e continuare il lavoro. Solo l'invocazione esplicita dell'utente avvia la procedura: un assenso generico non basta.

Il principale coordina tre comandi deterministici e una delega. Non legge feed, packet, STATE, HISTORY, Knowledge, proposta o review: copertura e continuità spettano al Curator.

`<RUNTIME>` è `node node_modules/knownex/dist/index.js` nel workspace, oppure `node dist/index.js` nel checkout di KnowNex già compilato. Non cercarlo altrove. Se manca, termina con `ERROR / CURATOR_RUNTIME_UNAVAILABLE`.

## Procedura

1. **Congela il batch.**

   ```text
   <RUNTIME> curate native --stage prepare --work .knownex/internal/curator
   ```

   - `SUCCESS` con `action: noop`: non ci sono eventi da curare. Termina.
   - `READY`: conserva `runId`, `run` e `requestFile` senza aprire i documenti.
   - Qualsiasi altro esito: riporta l'errore e termina.

   Ripetere prepare restituisce lo stesso batch attivo.

2. **Delega una volta** all'agente `knownex_curator`, con contesto indipendente (`fork_turns: "none"` dove esiste) e solo questo incarico:

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

   Se l'agente `knownex_curator` non è disponibile, termina con `ERROR / CURATOR_NATIVE_UNAVAILABLE` senza sostituirlo con un altro ruolo o modello.

3. **Continua il lavoro dell'utente mentre il Curator lavora.** Il batch è congelato: i nuovi eventi andranno al checkpoint successivo. Non inviare al Curator richieste di avanzamento o correzioni. Quando arriva il suo risultato:
   - con `{proposal, review}` vai al passo 4;
   - con un errore, riportalo e termina senza complete e senza un'altra delega.

4. **Completa.**

   ```text
   <RUNTIME> curate native --stage complete --work .knownex/internal/curator --run RUN_ID
   ```

   Il runtime legge proposta e review dal run, verifica il batch acquisito e il rapporto, poi pubblica in modo transazionale. Non eseguire validate, review o apply separatamente.

   Due codici non consumano il batch e indicano che la consegna non è ancora pronta: `CURATOR_WORKER_OUTPUT_INCOMPLETE` (manca la consegna) e `DESTINATION_BUSY` (il Curator sta scrivendo). Esegui di nuovo complete solo dopo il risultato del Curator. Ogni altro errore è definitivo per il batch.

5. **Riporta** solo l'esito `SUCCESS`, `BLOCKED` o `ERROR` con i metadati restituiti dal runtime. `BLOCKED` significa che il Curator ha dichiarato incertezze o anomalie: la proposta resta da rivedere esplicitamente.

## Vincoli

- Non usare fallback come npm, npx, `codex exec` o un secondo agente.
- Un'interruzione o un fallimento del Curator non autorizzano un'altra delega: solo una nuova invocazione dell'utente può farlo.
- Non dichiarare completo un checkpoint senza un esito `SUCCESS` del runtime.
