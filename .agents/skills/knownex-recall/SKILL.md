---
name: knownex-recall
description: Recupera dalla memoria KnowNex (Knowledge, HISTORY, revisioni, eventi pending) il minimo contesto mancante per rispondere, con provenienza. Usala quando STATE e il contesto già disponibili non bastano e serve una ricerca. Il principale la delega a knownex_recaller, che la esegue in sola lettura; un riferimento già noto il principale lo legge da sé. Non usarla per checkpoint, curatela o modifiche alla memoria.
---

# KnowNex Recall

Obiettivo: recuperare il minimo contesto sufficiente a rispondere correttamente, con la provenienza, distinguendo il presente dallo storico e senza inventare.

## Chi fa cosa

- **Principale.** Se STATE e il contesto bastano, rispondi senza Recall. Un riferimento già noto (nota o finestra linkata da STATE, ID `H…`) leggilo tu con `memory read`: una lettura costa meno di una delega. Per una ricerca delega una domanda precisa a `knownex_recaller` con `fork_turns="none"` dove supportato. Passa il workspace, i riferimenti o i cutoff già noti e il minimo contesto necessario, non documenti o l'intera conversazione. Attendi il risultato senza navigare tu. Se la delega non è disponibile, segnala il limite. Nessun fallback automatico a ricerche dirette, altri ruoli o launcher esterni.
- **knownex_recaller.** Le istruzioni di delega del principale non si applicano a questo ruolo: esegui tu la navigazione descritta sotto, senza delegare. Restituisci le informazioni pertinenti, i riferimenti, la provenienza e i limiti della ricerca, non documenti integrali o il log delle letture. Non modificare memoria, feed o configurazione e non eseguire checkpoint, curatela o riparazioni. Il vincolo di sola lettura è comportamentale: i permessi effettivi sono quelli dell'harness.

## Dove cercare

STATE è autorevole fino all'ultimo checkpoint confermato, non necessariamente fino a ora. Procedi per gradi e fermati appena hai risposta, qualificazioni e provenienza:

1. STATE già nel contesto: usalo. Se manca o è troncato, recuperalo una volta.
2. Dettagli: segui i link di STATE verso le Knowledge.
3. Storia: `memory history` per la cronologia, poi la finestra o la revisione specifica.
4. Eventi successivi al cutoff: `pending`, solo se rilevanti.

## Comandi

Dalla radice del workspace, con `K` = `npm exec --offline -- knownex`:

| Bisogno                                        | Comando                                                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| STATE                                          | `K memory state`                                                                                        |
| Riferimento noto (`kn-…`, percorso, revisione) | `K memory read "RIF"` oppure `"RIF#anchor"` per una sezione                                             |
| Riferimento ignoto                             | `K memory find "termini distintivi"` (tutti i termini richiesti; `--type knowledge` o `--type history`) |
| Cronologia dei checkpoint, dal più recente     | `K memory history` (`--last N`, `--before H000012`), senza i corpi delle finestre                       |
| Finestra o segmento storico                    | `K memory read "H000003"` (anche `history/H000003.md`)                                                  |
| Revisione precisa                              | `K memory read "kn-…@REV"`                                                                              |
| Nota al checkpoint N o a uno STATE archiviato  | `K memory read "kn-…" --at N` oppure `--at H000003`                                                     |
| Revisioni di una categoria                     | `K memory category CHIAVE` (`--limit`, `--cursor`)                                                      |
| Eventi pending                                 | `K pending`                                                                                             |

La memoria è in `.knownex/memory` (legacy: `.knownex/curator/memory` o `.knownex/seed`). Per una copia esterna usa `--memory PERCORSO`. I link relativi si risolvono dal documento di origine; `memory read` non apre artefatti esterni.

- `find` restituisce fino a cinque candidati: se un estratto contiene già risposta e provenienza, fermati; altrimenti apri solo il riferimento pertinente. Non usare `find` se hai già il riferimento.
- Preferisci `#anchor` quando basta una sezione. Non rileggere documenti già acquisiti nel turno.
- I cursori di categoria scadono dopo modifiche. `thematicCategories` è l'organizzazione attuale, `category` la collocazione originaria.
- Per pending parziali e paginazione vedi [RUNTIME.md](../../../docs/RUNTIME.md), sezione S4.3.

Per audit o richieste esplicitamente esaustive amplia la copertura in modo verificabile e dichiara i limiti.

## Storia e provenienza

- Non sostituire una revisione storica con quella corrente. Una finestra `history/H…md` contiene lo STATE prodotto dal suo checkpoint e le note scritte; un segmento più vecchio, dentro HISTORY.md, contiene invece lo STATE precedente alla sua transizione. Checkpoint, revisioni e ID HISTORY sono numerazioni distinte.
- Distingui fatti confermati, risultati sperimentali, decisioni superate e incertezze. Riporta riferimenti ed eventi quando rilevanti, senza letture aggiuntive per citazioni decorative.
- Se non trovi qualcosa, indica l'ambito consultato: `not_found` non prova l'assenza. Non dedurre eventi o provenienze che non compaiono nei risultati. Se lo storico precede la baseline, dillo.

## Integrità

- Leggi solo tramite la CLI, senza `Get-Content` o conversioni intermedie. L'output è JSON ASCII-safe: gli escape Unicode sono valori corretti dopo il parsing.
- Un output troncato non si ripete identico: leggi una sezione o dichiara la copertura incompleta.
- Una lettura può completare un apply già autorizzato e rimasto in sospeso; quando serve una garanzia di sola lettura usa una copia standalone.
- Su `CURATOR_RECOVERY_REQUIRED` o errori d'integrità fermati, senza riparazioni e senza invocare il Curator.
