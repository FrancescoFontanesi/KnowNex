---
name: knownex-recall
description: Recupera selettivamente Knowledge, HISTORY e pending quando lo STATE già disponibile non basta, servono evidenze specifiche o occorre ricostruire decisioni storiche. Non esegue checkpoint o curatela.
---

# KnowNex Recall

**Obiettivo:** recuperare il minimo contesto sufficiente per rispondere correttamente, preservando provenienza, distinzione tra presente e storico e assenza di invenzioni.

Riutilizza STATE, istruzioni, risultati e documenti già presenti nel contesto. Non ricaricare la skill o gli stessi contenuti senza una necessità concreta.

## 1. Prima di accedere alla memoria

1. **STATE sufficiente:** rispondi direttamente. Non rileggerlo e non avviare Recall soltanto per confermare informazioni già disponibili.
2. **Dettaglio o evidenza mancante:** segui i riferimenti pertinenti da STATE verso Knowledge.
3. **Informazione storica:** consulta HISTORY o la revisione specifica necessaria.
4. **Informazione successiva al cutoff:** consulta `pending` soltanto se rilevante per la richiesta.
5. **Informazione assente:** non inventarla e non estendere indefinitamente la ricerca.

STATE è autorevole fino al checkpoint confermato, non necessariamente fino al momento corrente.

`SessionStart` tenta l'iniezione integrale anche dopo compact, ma questo non prova da solo la consegna al modello. Se STATE manca, è troncato o non più disponibile nel contesto, recuperalo una volta mediante la CLI.

## 2. Accesso canonico

Dalla radice del workspace usa:

`npm exec --offline -- knownex ...`

Il comando utilizza il pacchetto locale, senza installazione globale. Non effettuare discovery generica se il comando e l'operazione sono già noti.

La memoria installata si trova normalmente in `.knownex/memory`; i workspace legacy possono utilizzare `.knownex/curator/memory` o `.knownex/seed`, senza migrazione automatica. Per copie esterne usa `--memory PERCORSO`; il default standalone è `memory/`.

Comandi principali:

- **STATE:** `npm exec --offline -- knownex memory state`
- **Riferimento noto:** `npm exec --offline -- knownex memory read "RIFERIMENTO"`
- **Sezione nota:** `npm exec --offline -- knownex memory read "RIFERIMENTO#anchor"`
- **Riferimento ignoto:** `npm exec --offline -- knownex memory find "termini specifici"`
- **Pending:** `npm exec --offline -- knownex pending`

Usa direttamente `read` per ID logici `kn-...`, percorsi Knowledge e revisioni note. Non utilizzare `find` quando possiedi già il riferimento.

Risolvi i collegamenti relativi dal documento di origine rispetto alla radice della memoria. `memory read` non apre artefatti esterni.

## 3. Navigazione efficiente

- **Ricerca:** usa pochi termini distintivi; `find` richiede tutti i termini. Puoi restringere con `--type knowledge` o `--type history`.
- **Risultati:** `find` restituisce fino a cinque candidati. Se l'estratto contiene già la risposta e la provenienza necessaria, fermati. Altrimenti apri soltanto il riferimento pertinente.
- **Sezioni:** preferisci `#anchor` quando basta una sezione. Amplia la lettura soltanto per recuperare qualificazioni o contesto mancanti.
- **Riuso:** non rileggere un documento già acquisito durante il turno, salvo modifiche note, troncamenti o informazioni effettivamente mancanti.
- **Arresto:** termina la navigazione quando risposta, qualificazioni e provenienza sono sufficienti. Non cercare conferme ridondanti.

Per audit o richieste esplicitamente esaustive, estendi invece la copertura in modo verificabile e dichiara eventuali limiti.

## 4. Storico e revisioni

Usa gli strumenti specifici quando necessari:

- `memory read "H000003"` oppure `"HISTORY.md#h000003"` per un segmento storico.
- `memory read "kn-...@REV"` per una revisione precisa.
- `memory read "kn-..." --at N` per il checkpoint confermato N, anche noop.
- `memory read "kn-..." --at H000003` per il cutoff associato allo STATE archiviato.
- `memory category CHIAVE` per revisioni classificate, con `--limit` e `--cursor` quando necessari.

Checkpoint, revisioni e identificativi HISTORY sono distinti. I cursori delle categorie scadono dopo modifiche. `thematicCategories` descrive l'organizzazione attuale; `category` la collocazione fisica originaria.

Non sostituire una revisione storica con quella corrente. Distingui decisioni superate, stato attuale, motivazioni, fonti e data delle transizioni. Lo STATE archiviato precede la transizione descritta dal relativo segmento HISTORY.

Se lo storico non esiste prima della baseline, dichiaralo.

## 5. Provenienza e informazioni mancanti

Quando la risposta dipende dalla memoria, identifica l'evidenza pertinente senza effettuare letture aggiuntive solo per produrre citazioni decorative.

- Riporta riferimenti documentali e identificativi degli eventi quando disponibili e rilevanti.
- Distingui fatti confermati, risultati sperimentali, decisioni superate e informazioni ancora incerte.
- Se una ricerca non trova un'informazione, indica l'ambito effettivamente consultato.
- `not_found` non dimostra assenza universale. Ripeti o amplia la ricerca solo quando emergono nuovi indizi.
- Non dedurre un evento o una provenienza specifica se non sono presenti nei risultati.

Per pending parziali, frammenti e paginazione consulta [RUNTIME.md](../../../docs/RUNTIME.md), sezione S4.3. Su `CURATOR_RECOVERY_REQUIRED` interrompi il recupero. Pending è una consultazione di sola lettura e non autorizza checkpoint.

## 6. Integrità e arresto

Usa esclusivamente la CLI KnowNex per le letture ordinarie, senza `Get-Content`, ricodifiche o conversioni PowerShell intermedie.

La CLI restituisce JSON ASCII-safe: gli escape Unicode preservano i valori dopo parsing. Problemi di visualizzazione del terminale non autorizzano modifiche ai byte dei documenti.

Per gli input congelati di un run utilizza l'I/O canonico nel Node REPL.

Non ripetere identicamente un output troncato: acquisisci una sezione appropriata o dichiara la copertura incompleta.

Su workspace V2.1 una lettura può completare un apply già autorizzato; quando serve garanzia read-only usa una copia standalone stabile. Su errori di integrità o recovery necessaria, fermati senza riparazioni o invocazioni del Curator.

Se il percorso canonico non è disponibile, segnala il limite senza fallback non supportati.

**Conclusione:** rispondi utilizzando il minimo contesto sufficiente. Recall recupera conoscenza, non produce nuova curatela.
