# Feed conversazionale

## Feed e backup S1

Il feed conserva `user_message`, `assistant_commentary` e `assistant_final`,
separatamente dal backup S1. Utente e finale provengono dai payload nativi;
i soli intermedi testuali vengono selezionati dal transcript durante Stop
([criteri R2](INTERMEDIATE-MESSAGES.md)). Il writer `appendFeedEvent(directory,
input)` in `src/feed.ts` non importa formati Codex: riceve `type`, `sessionId`,
`turnId`, `text` e `hook`, e aggiunge `sequence` (da 1) e `capturedAt` (UTC ISO).
`hook` è la provenienza fornita dal chiamante, non un identificativo dell’evento.

Ogni sessione usa `.knownex/feed/<sha256 UTF-8 di sessionId>.jsonl`, escluso da Git.
Ogni riga LF completa è un frame `{ block, checksum }`, con blocco
`{ version: 1, previous, event }`. `checksum` è SHA-256 di `JSON.stringify(block)`;
`previous` è il checksum del frame precedente, oppure `null`. La sequenza
rappresenta l’ordine di commit osservato, non una cronologia dedotta dal modello.
Il testo resta invariato, inclusi spazi, righe, Unicode e stringhe vuote.

## Identità e recovery

L’identità nativa è la terna tipo/sessione/turno; per gli intermedi si aggiunge
`messageId`. Ripetere la stessa identità con testo identico è
un no-op; testo diverso causa `FEED_CONFLICT`, senza alterare il registro.
Lo stesso testo in turni diversi resta composto da eventi distinti.

La riapertura verifica checksum, catena, sequenze, sessione e unicità delle identità.
Un frame completo corrotto causa `FEED_CORRUPT` e viene preservato. Una coda
incompleta viene scartata solo dopo aver validato i frame confermati e l’evento
in ingresso; un replay di un commit già completo non lo duplica. Il writer richiede
`FileHandle.sync()`, senza dimostrare durabilità fisica contro perdita di corrente.

Il writer riutilizza `acquireJournalLock()`: un processo vivo concorrente causa
`DESTINATION_BUSY`, senza polling o retry automatici. L’errore è osservabile e
richiede un successivo replay; non è promessa l’acquisizione eventuale di eventi
falliti. Valgono i limiti del lock S1 per PID riutilizzati, hard link e recovery
interrotta. Non accedere allo stesso registro tramite alias hard link o symlink.
La verifica rilegge il registro in memoria a ogni evento; non esiste un indice
persistente o un file di stato separato.

## Adattatore Codex

La prova reale dei payload verifica `session_id` e `turn_id` coincidenti tra
`UserPromptSubmit` e `Stop`, con `prompt` e `last_assistant_message` di tipo stringa.
La configurazione `.codex/hooks.json` aggiunge `UserPromptSubmit` e un secondo
handler a `Stop`, entrambi con comando `node "F:/KnowNex/.codex/hooks/feed.cjs"`.
Gli handler S1 di Stop e SessionEnd restano invariati.

Lo script passa il payload via stdin a `src/feed-hook.ts`, mai negli argomenti
del processo. L’adattatore estrae il campo originale e invoca il writer comune.
Durante Stop tenta prima l'acquisizione selettiva dei commentary del medesimo
turno. I problemi del transcript non impediscono di conservare il finale nativo;
sono riportati come codici in `commentaryIssues` nel log diagnostico, con i conteggi
`commentaryMatched` e `commentaryAppended`, senza testo conversazionale.
Campo assente o nullo causa `MISSING_PROMPT` o `MISSING_ASSISTANT_MESSAGE`;
ID assenti o invalidi impediscono la scrittura. Non si inventano identificativi,
risposte o messaggi utente per riempire eventuali lacune.

Il wrapper ha timeout figlio di 7,5 secondi, sotto quello dichiarato di 10 secondi,
e termina con exit code 0 anche su errore. I diagnostici in
`.codex/hooks/feed-events.jsonl` (ignorato da Git) contengono solo ID, evento,
timestamp, conteggi, sequenza, hash/lunghezza del testo ricevuto o codice errore.
Non inoltra stdout/stderr grezzi o contenuti conversazionali. Se anche il log
fallisce, segnala `FEED_LOG_WRITE_FAILED` senza annullare commit già confermati.

La raccolta iniziata a metà conversazione può non avere il messaggio utente
corrispondente a una risposta. Eventi mancanti, hook non emessi, crash e
terminazioni forzate non sono recuperabili automaticamente dal feed. Il backup
S1 resta la copia indipendente del transcript, non una fonte di fallback implicita.
Gli intermedi recuperabili dal transcript non colmano automaticamente i messaggi
utente o finali mancanti; le loro identità native restano invariate.

## Verifica

Le fixture verificano testo esatto, due turni/quattro eventi, sessioni separate,
replay, conflitti, lock occupato, corruzione e tagli simulati di un frame finale,
anche dentro un carattere UTF-8. Le fixture dell’adattatore invocano processi nuovi
e verificano che l’assenza di campi non inventi contenuti né blocchi Codex.

### Prova reale VS Code — 3 novembre 2026

Dopo l’approvazione personale degli handler, una sonda temporanea limitata a
metadati e hash conferma `prompt`, `last_assistant_message`, `session_id` e
`turn_id`: i due hook condividono sessione e turno. La sonda viene sostituita
dall’adattatore di acquisizione; nessun testo dei payload viene copiato nei log.

Una nuova chat sacrificabile con due turni produce automaticamente quattro eventi
nel feed, nell’ordine `user_message`, `assistant_final`, `user_message`,
`assistant_final`. I due eventi di ciascun turno condividono lo stesso ID, mentre
i turni hanno ID diversi. Gli hash e le lunghezze UTF-8 dei testi coincidono con
quelli calcolati dall’adattatore sul campo ricevuto del payload; checksum, catena
e sequenze sono validi. La conversazione termina normalmente.
Il `prompt` osservato comprende anche il contesto IDE fornito da Codex: il feed
conserva l’intero campo ricevuto, senza estrarre o riscrivere la sola direttiva.

Il replay diagnostico del primo evento, trasferito nuovamente via stdin all’hook,
aggiunge zero eventi, conserva la sequenza originale e lascia l’intero registro
identico byte per byte. Entrambi gli Stop acquisiscono anche il transcript S1
(23 e 10 nuovi record), con catena e checksum validi. Feed e transcript restano
registri indipendenti. Le simulazioni di interruzione riguardano fixture sintetiche,
non il registro reale. La verifica completa passa con 59 test. Stato S2.1: **READY**.
