<!-- knownex:start -->

## KnowNex continuity

La conversazione viene acquisita automaticamente dagli hook. Non chiedere all'utente cosa salvare e non produrre riepiloghi artificiali per alimentare la memoria.

### Contesto e recupero

- **STATE** è l'handoff automatico all'avvio di una nuova sessione nello stesso workspace: riusalo con il contesto conversazionale, senza reiniezioni per turno o consultazioni periodiche. Gli hook attuali lo emettono anche dopo compact; questo intervento non ne cambia il comportamento.
- STATE rappresenta lo stato del progetto fino all'ultimo checkpoint confermato. Eventi successivi possono averlo modificato.
- Se il contesto disponibile è sufficiente, prosegui senza Recall. Un riferimento già noto (una nota o una finestra linkata da STATE, un ID `H…`) leggilo direttamente con `npm exec --offline -- knownex memory read`: è una sola lettura. Per una ricerca (riferimento ignoto, storia, revisioni, pending) delega una richiesta precisa a `knownex_recaller`, con workspace, riferimenti già noti e minimo contesto necessario. Usa `fork_turns="none"` dove supportato, senza trasferire la conversazione completa.
- Oltre alla lettura di un riferimento noto, il principale non naviga STATE, Knowledge, HISTORY o pending per Recall e non supervisiona i documenti: per le ricerche attende il risultato mirato e prosegue. Se la delega nativa non è disponibile, segnala il limite senza fallback automatico a ricerche dirette, altri ruoli o launcher esterni.
- `knownex_recaller` usa la skill `knownex-recall` in sola consultazione, senza checkpoint, curatela o altre deleghe. Le sue restrizioni sono comportamentali; i permessi effettivi dipendono dall'harness. Queste istruzioni di delega riguardano il principale, non il Recaller.
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

Non utilizzare `codex exec`, npm/npx o altre modalità come fallback per il checkpoint. Nessun retry LLM automatico, materializzazione per turno o test stateless.

Un solo batch attivo per workspace. Il comando prepare esplicito congela il batch; il feed non deve contenere un'invocazione o un permesso. Un prepare ripetuto restituisce lo stesso batch attivo, senza autorizzare altre deleghe. Anomalie o incertezze dichiarate impediscono la pubblicazione automatica; l'autoverifica del Curator e i controlli strutturali non garantiscono da soli la completezza semantica.

In caso di indisponibilità o fallimento, preserva il pending, riferisci il limite e prosegui il task senza inventare conferme.
<!-- knownex:end -->
