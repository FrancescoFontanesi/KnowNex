<!-- knownex:start -->

## KnowNex continuity

La conversazione viene acquisita automaticamente dagli hook. Non chiedere all'utente cosa salvare e non produrre riepiloghi artificiali per alimentare la memoria.

### Contesto e recupero

- **STATE** viene iniettato da `SessionStart`: riusalo direttamente, senza rileggerlo se già disponibile e completo.
- STATE rappresenta lo stato del progetto fino all'ultimo checkpoint confermato. Eventi successivi possono averlo modificato.
- Se STATE è sufficiente, rispondi senza ulteriori letture. Per dettagli, evidenze, storico o informazioni successive al cutoff usa `knownex-recall` selettivamente.
- STATE contiene il presente, Knowledge i dettagli tematici, HISTORY le transizioni. Non esplorare interi archivi senza necessità.
- Riutilizza informazioni e documenti già recuperati durante il turno. Non ripetere letture per semplice conferma.
- Se il contesto è incompleto, il pending è parziale o un'informazione manca, dichiarane i limiti senza inventare fatti.

### Continuità e checkpoint

Mantieni naturale la conversazione. Esplicita decisioni, risultati, evidenze e problemi aperti quando pertinenti al task, senza template o sezioni obbligatorie.

Riconosci milestone significative (decisioni sostituite, risultati verificati, cambi di focus, handoff o compattazioni rilevanti). Puoi suggerire `$knownex-checkpoint`, continuando il lavoro, ma **solo l'invocazione esplicita dell'utente** autorizza il checkpoint. Un assenso generico non equivale all'invocazione.

Su `$knownex-checkpoint` esplicito:

1. Esegui `curate native --stage prepare`.
2. Delega una sola volta a `knownex_curator`, passando `requestFile` e contesto indipendente.
3. Attendi le ricevute e completa con `curate native --stage complete`.

Terra esegue la curatela in modalità `materialize-only`. Il principale coordina, ma non legge feed, packet, STATE, HISTORY, Knowledge, proposta o review per supervisionarla e non ripete la valutazione semantica.

Non utilizzare il launcher esterno, `codex exec`, npm/npx o altre modalità come fallback per il checkpoint. Nessun retry LLM automatico, materializzazione per turno o test stateless.

Un solo batch attivo per workspace. L'autorizzazione è monouso. Anomalie o incertezze dichiarate impediscono la pubblicazione automatica; l'autoverifica del Curator e i controlli strutturali non garantiscono da soli la completezza semantica.

In caso di indisponibilità o fallimento, preserva il pending, riferisci il limite e prosegui il task senza inventare conferme.
<!-- knownex:end -->
