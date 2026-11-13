<!-- knownex:start -->

## KnowNex continuity

La conversazione viene acquisita automaticamente dagli hook. Non chiedere all'utente cosa salvare e non produrre riepiloghi artificiali per alimentare la memoria.

### Contesto e recupero

- **STATE** è l'handoff automatico all'avvio di una nuova sessione nello stesso workspace: riusalo con il contesto conversazionale, senza reiniezioni per turno o consultazioni periodiche. Gli hook attuali lo emettono anche dopo compact; questo intervento non ne cambia il comportamento.
- STATE rappresenta lo stato del progetto fino all'ultimo checkpoint confermato. Eventi successivi possono averlo modificato.
- Se il contesto disponibile è sufficiente, prosegui senza Recall. Una nota già linkata da STATE leggila direttamente con `npm exec --offline -- knownex memory read`: è una sola lettura.
- Storia (HISTORY, finestre, revisioni ed eventi), tassonomia e ricerche di riferimenti ignoti delegale a un subagente con contesto indipendente, che segue la skill `knownex-recall` (`.agents/skills/knownex-recall/SKILL.md`) in sola consultazione e restituisce fatti, riferimenti, provenienza e limiti. Passa una richiesta precisa e i riferimenti già noti, non la conversazione completa. Se l'harness non offre subagenti, segnala il limite.
- STATE contiene il presente, Knowledge i dettagli tematici, HISTORY le transizioni. Non esplorare interi archivi senza necessità.
- Riutilizza informazioni e documenti già recuperati durante il turno. Non ripetere letture per semplice conferma.
- Se il contesto è incompleto, il pending è parziale o un'informazione manca, dichiarane i limiti senza inventare fatti.

### Checkpoint

Mantieni naturale la conversazione. Esplicita decisioni, risultati, evidenze e problemi aperti quando pertinenti al task, senza template o sezioni obbligatorie.

Ai milestone significativi (decisioni sostituite, risultati verificati, cambi di focus, handoff o compattazioni rilevanti) suggerisci in una riga di eseguire il checkpoint, per esempio `npm exec --offline -- knownex checkpoint --codex -m gpt-6.1-sol -r medium`, e continua il lavoro. Il checkpoint lo decide l'utente: eseguilo solo su sua richiesta esplicita, come comando in background, e riporta soltanto l'esito. La curatela avviene in una sessione separata: non leggere né modificare tu la memoria per curarla.
<!-- knownex:end -->
