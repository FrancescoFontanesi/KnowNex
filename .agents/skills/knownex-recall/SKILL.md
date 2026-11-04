---
name: knownex-recall
description: Recupera selettivamente stato, decisioni storiche e dettagli KnowNex con il navigatore deterministico, quando il task richiede contesto dalla memoria procedurale.
---

# Recall KnowNex

Usa la directory di memoria autorizzata con `--memory PERCORSO` in ogni comando;
senza opzione il navigatore usa `memory/` nella directory corrente.
Il binario è `knownex`; dalla repository puoi usare `npm start -- memory ...`
dopo la build, con gli stessi argomenti.

## Cold start

- STATE e autorevole fino al cutoff confermato, non necessariamente fino a ora.
  Se il task richiede continuita, controlla il cutoff di SessionStart e della lettura pending e gli
  eventi successivi: usa `knownex pending` senza prepare, consenso o delega.
  L'output dichiara cutoff, finestra, provenienza, copertura e nextCursor. Per un
  intervallo usa `--from N --through M`; per continuare `--cursor TOKEN`, eventualmente
  `--limit N`. `--workspace PERCORSO` permette letture su copie locali.
  Leggi solo le finestre pertinenti. Un evento grande puo arrivare in frammenti:
  ricomponi text in ordine usando sequence/textOffset, senza perderne il grado di certezza.
  complete riguarda la finestra; pendingComplete non prova comprensione o che le
  pagine precedenti siano nel contesto. Controlla anche newerEvents e incompleteTailBytes.
  Se il checkpoint cambia, il cursore diventa obsoleto: riparti dal nuovo cutoff.
  Con CURATOR_RECOVERY_REQUIRED ferma la riconciliazione: la recovery esistente e
  un'operazione separata; questa lettura non la esegue.
  Ricostruisci solo nel contesto corrente decisioni, risultati, blocker e attivita
  aperte; eventi piu recenti possono superare STATE se autorevoli e supportati.
  Distingui decisioni, ipotesi e risultati dichiarati/verificati. Se STATE e omesso
  o il pending non e esaminato abbastanza, dichiara la ricostruzione parziale.
  Non creare WORKING.md o snapshot. La riconciliazione non e un checkpoint:
  non scrive memoria o cutoff. Una materializzazione futura richiede sempre S4.2.

- Leggi `knownex memory state --memory PERCORSO` una sola volta.
  Se STATE aggiornato è già nel contesto, riusalo. Rileggilo dopo un aggiornamento noto.
- Non precaricare HISTORY o tutte le Knowledge. Approfondisci solo ciò che manca
  per il task; se STATE basta, fermati.

## Ricerca mirata

- Se conosci già l'ID pertinente, passa direttamente a `read`.
- Altrimenti usa `knownex memory find "query specifica" --memory PERCORSO`.
  Scegli pochi termini tecnici o concetti noti: la ricerca richiede tutte le parole.
  Restringi con `--type history` o `--type knowledge` quando sai dove cercare.
- `find` restituisce al massimo cinque candidati. Se l'estratto basta, non aprire altro.
  Usa `knownex memory read ID --memory PERCORSO` solo per gli ID pertinenti.
- Riusa documenti e risultati già disponibili per la stessa versione della memoria.
  Non aprire tutti i candidati né ripetere query equivalenti senza una nuova esigenza.
- Un output compresso o troncato non giustifica riletture identiche: recupera
  l'output originale se il trasporto lo consente; altrimenti segnala il limite.

## Storia e informazioni mancanti

- Leggi singoli ID `H000003` o `kn-...`; non seguire automaticamente i link.
- Distingui data/intervallo della transizione dallo STATE precedente archiviato
  nel segmento. Una decisione storica non sostituisce lo STATE corrente più recente.
- Dopo una ricerca vuota, riformula solo con termini alternativi motivati dalle
  evidenze disponibili. Fermati quando mancano nuovi indizi utili; niente esplorazione esaustiva.
- `not_found` non prova un'assenza semantica universale: dichiara ciò che non è
  documentato nelle evidenze recuperate, senza inventare dettagli.
- Usa memoria confermata e stabile. Su workspace V2.1 il navigatore può completare
  un apply già autorizzato; per letture senza recovery usa una copia stabile standalone.
  Se emerge un errore d'integrità, riportalo senza tentare riparazioni o invocare il curator.
