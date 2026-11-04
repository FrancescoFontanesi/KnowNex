---
name: knownex-handoff
description: Propone checkpoint KnowNex ai milestone e, dopo un consenso utente Si/No acquisito, materializza una sola volta tramite curator single-pass.
---

# Checkpoint proposto dal principale, approvato dall'utente

Riconosci decisioni/supersession, risultati significativi, cambio di focus,
handoff o compattazione imminente. Non curare per turno o per tempo trascorso.
Una richiesta manuale generica «checkpoint» attiva lo stesso workflow.
Non chiedere mai cosa salvare o come suddividerlo nella memoria.

1. Dalla radice esegui `npm exec --offline -- knownex runtime`.
   Considera pending precedente: STATE e l'ultima memoria confermata e puo essere
   arretrato. Recupera selettivamente il packet gia disponibile se pertinente.
   Se bloccato, senza lavoro significativo o con batch attivo, conserva il pending.
   Su fallimento di delega, JSON invalido, review semantica rifiutata o errore prima
   di apply, comunica brevemente: materializzazione non confermata, eventi conservati;
   con runtime coerente il lavoro ordinario puo continuare. Non riprovare un LLM.
   Solo per una nuova richiesta esplicita di checkpoint, dopo che la vecchia delega
   e terminata, ritira il batch non confermato con
   `npm exec --offline -- knownex curate abandon --work .knownex/curator --run ID`.
   ID e quello del run esistente, non del consenso. Conserva staging e grant consumato;
   poi usa il normale comando manuale del punto 2 e attendi un nuovo Si/No.
   Abandon verifica prima integrita e recovery: se un apply era gia autorizzato puo
   completarlo, non annullarlo. Con errori di integrita/recovery impossibile non
   aggirare il blocco: segnala memoria non verificata e intervento necessario,
   senza reset, ritiro forzato, nuovi batch o uso dello stato misto come confermato.
   Nessun retry LLM. Il conteggio pending segnala arretrato, non rilevanza semantica.
   Domanda, consenso, preparazione/apply e report di completamento possono restare
   dopo il cutoff: da soli non sono un nuovo milestone, neppure al cold start.
   Se resta solo amministrazione, continua il task senza proporre un checkpoint,
   cambiare chiave milestone o avanzare il cutoff per svuotare il pending.
   Non filtrare per parole: sviluppo e difetti di KnowNex possono essere lavoro
   sostanziale. Mantieni eleggibili cause tecniche, fallimenti persistenti,
   blocker irrisolti e decisioni progettuali; per casi incerti valuta il contenuto.
2. Per un nuovo milestone usa `npm exec --offline -- knownex checkpoint --milestone CHIAVE`:
   scegli una chiave stabile della novita sostanziale, non una diversa a ogni turno.
   Su richiesta manuale esplicita puoi usare `npm exec --offline -- knownex checkpoint`.
   Il comando richiede un turno utente acquisito ancora aperto; inizializza solo
   il seed canonico a sequenza zero se necessario, senza confermare eventi.
   Solo con status `requested` poni esattamente la `question` restituita come
   risposta finale (con il prefisso [AXIOM] solo se obbligatorio nel progetto).
   Nessun elenco, direttiva o dettaglio tecnico nella domanda.
   Conserva l'ID `request` restituito.
3. Attendi una risposta utente acquisita nel feed: solo «Si»/«Sì» alla domanda
   pertinente nella stessa sessione autorizza. No, ambiguita o silenzio rimandano.
   Non interpretare un si fuori contesto o una dichiarazione del modello come consenso.
   Non riproporre la stessa domanda dopo No salvo un nuovo milestone significativo
   o una nuova richiesta manuale. Una richiesta obsoleta non autorizza il riavvio.
4. Dopo il Si scrivi `.knownex/directive.md`: novita, decisioni sostituite,
   risultati e grado di verifica, artefatti, blocker, priorita, prossime attivita
   e Knowledge pertinenti. Proteggi attivita critiche ancora aperte. La direttiva
   orienta il curator, che rileva anche altri segnali importanti del feed.
   Usa `npm exec --offline -- knownex curate prepare --work .knownex/curator --directive .knownex/directive.md --request ID`.
   Il cutoff e fissato dalla richiesta; non estenderlo agli eventi successivi.
   Seleziona solo `--context`/`--artifacts` necessari; leggi il packet una volta.
5. Prepara il single-pass con `node node_modules/knownex/dist/curator-request.js --run RUN --output RUN/request.txt`.
   Delega una sola volta al curator economico configurato, con contesto isolato,
   usando la richiesta completa; persisti la sua risposta JSON UTF-8 esatta nel
   proposal.json del run. Nessun retry, correzione delegata o benchmark.
   Se il modello o il trasporto single-pass non sono disponibili, conserva il batch.
6. Confronta lo STATE precedente congelato in packet.context con quello proposto.
   Per ogni decisione attiva, blocker, prerequisito o attivita critica scomparsa
   o indebolita, cerca negli eventi disponibili una giustificazione pertinente:
   completamento dimostrato da risultato/verifica, decisione sostitutiva oppure
   cancellazione esplicita e autorevole. Altrimenti deve rimanere attivo in STATE.
   Il silenzio recente, una soluzione non verificata, un risultato parziale o un
   link a HISTORY/Knowledge non dimostrano la chiusura di un elemento necessario.
   Rifiuta apply se una perdita critica resta ingiustificata. Questa revisione e
   del principale, senza seconda delega, retry LLM, registri o ID aggiuntivi:
   conserva il batch e il pending, senza riutilizzare il consenso S4.2 o rigenerarlo
   automaticamente. Per una futura richiesta esplicita segui il ritiro del punto 1.
   Rivedi anche fonti e selettivita; usa
   `npm exec --offline -- knownex curate validate --work .knownex/curator`, poi
   `npm exec --offline -- knownex curate apply --work .knownex/curator --confirm SIGILLO`.
   Prima di apply controlla lo STATE del candidato validato con lo stesso criterio;
   validate strutturale e sigillo non provano continuita semantica ne sostituiscono
   il consenso acquisito. Su errore preserva pending e batch.
   Comunica sinteticamente l'esito e riprendi il task, senza nuova domanda rituale.

STATE corrente, HISTORY append-only e Knowledge tematiche restano invariati.
Consensi e report amministrativi non giustificano note autonome.
Dettagli e limiti nel [workflow](../../../docs/CURATOR.md).
