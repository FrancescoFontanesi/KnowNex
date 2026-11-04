# Acquisizione tramite Stop e SessionEnd

La dichiarazione `Stop` verificata in `.codex/hooks.json` rimane invariata. Lo script
`.codex/hooks/stop.cjs` legge il payload UTF-8 ricevuto da Codex, valida
`hook_event_name`, `session_id` e un `transcript_path` assoluto, poi richiama la CLI
esistente con argomenti separati, senza shell:

```text
node src/index.ts sync --source <transcript_path> --destination <registro>
```

L’uso dell’entry point TypeScript evita una build JavaScript obsoleta durante lo
sviluppo; richiede il runtime Node documentato nel README. La logica di lettura,
checkpoint, commit e recovery rimane in `syncSession()`.

## Coda finale: SessionEnd (S1.6)

`SessionEnd` richiama lo stesso comando di `Stop`, con lo stesso payload di
identificazione e la stessa destinazione. Lo script accetta entrambi gli eventi
e registra il nome effettivamente ricevuto nei log diagnostici. Non introduce
un secondo writer o un altro formato di persistenza: usa la CLI, il lock e le
generazioni esistenti. Le sovrapposizioni vengono serializzate dal lock; la
ripetizione di un’acquisizione già confermata non aggiunge record.

`Stop` mantiene timeout di 10 secondi e budget interno di 7,5 secondi.
`SessionEnd` ha timeout di 3 secondi e budget interno di 2 secondi, incluso il
retry già esistente in caso di registro occupato. Un errore o un budget esaurito
produce un codice diagnostico senza contenuti conversazionali. Un registro troppo
grande o un lock occupato oltre il budget può impedire l’acquisizione finale;
non viene dichiarata riuscita. Il timeout esterno può terminare il processo prima
che riesca a scrivere il log.

Secondo la [documentazione Codex](https://learn.chatgpt.com/docs/hooks),
`SessionEnd` è sincrono e consultivo: scatta alla chiusura normale o quando si
archivia/elimina una conversazione ancora aperta. Cambiare chat non basta.
Il [motore degli hook](https://github.com/openai/codex/blob/main/codex-rs/hooks/src/events/session_end.rs)
prevede un massimo di 3 secondi. La disponibilità effettiva nell’estensione
installata richiede una prova reale, non è dimostrata dalle fixture.

Il nuovo hook deve essere esaminato e autorizzato personalmente tramite il normale
percorso di trust Codex. Non vengono modificate configurazioni globali o
autorizzazioni automaticamente. La prova reale S1.6 è riportata sotto.
Nessuna garanzia di cattura finale in caso di crash, terminazione forzata, eventi
scritti dopo `SessionEnd` o mancata emissione dell’evento da parte dell’estensione.

### Prova reale S1.6 — 3 novembre 2026

Con Codex `0.164.0-alpha.11.1`, estensione VS Code `26.51021.22027`, l’utente
autorizza personalmente il nuovo hook. In una chat sacrificabile un turno
produce uno Stop automatico con 24 record. Codex scrive un `task_complete`
54 ms dopo, verificato nella sorgente e ancora assente dal registro.

L’utente riapre e archivia quella chat, confermando l’assenza di blocchi.
`SessionEnd` aggiunge automaticamente un record: il `task_complete` pendente.
Il registro contiene 25 record in due blocchi della generazione 1; nessuna
sincronizzazione manuale viene eseguita. Checksum, catena, cursore e corrispondenza
byte per byte con tutti i record completi della sorgente risultano validi;
il blocco precedente resta identico al riferimento salvato prima dell’archiviazione.

Dopo l’hook Codex sposta il transcript in `archived_sessions`: la verifica legge
il file archiviato senza modificarlo. Il percorso originale ricevuto dal payload
non è più disponibile dopo l’archiviazione; non viene aggiunta alcuna ricerca
automatica del nuovo percorso. Le ripetizioni senza duplicazioni e le
sovrapposizioni Stop/SessionEnd sono verificate con fixture sintetiche.
La prova dimostra la chiusura tramite archiviazione, non il crash o tutte le altre
modalità di terminazione dell’estensione. Stato S1.6: **READY** per il caso provato.

Nel ricontrollo successivo del 3 novembre, il JSONL archiviato risulta riscritto
da `legacy` a `paginated`, senza un nuovo evento `SessionEnd` nei log. Mantiene
25 record nello stesso ordine di timestamp, ma aggiunge `ordinal`, converte due
eventi in `item_completed` e aggiunge `content: null` al reasoning. La causa e il
momento preciso della riscrittura non sono accertati. Il registro KnowNex resta
identico a quello verificato alla chiusura, conserva il `task_complete` e ha catena
e checksum validi; non coincide più byte per byte con la rappresentazione corrente
del file archiviato. La prova dimostra il recupero della coda presente al
`SessionEnd`, non l’acquisizione di riscritture successive alla chiusura. Le evidenze
originali e il ricontrollo sono conservati separatamente nei diagnostici locali.

## Registri indipendenti

La destinazione è relativa alla radice del progetto, non al cwd del turno:

```text
.knownex/captures/<sha256 UTF-8 di session_id>.jsonl
```

La directory viene creata al bisogno. Il digest tratta l’ID come opaco ed evita
traversal, nomi riservati Windows e separatori nei nomi dei file. La stessa
sessione ritrova lo stesso registro anche dopo il riavvio; ID diversi producono
registri indipendenti. I registri contengono conversazioni originali e sono
esclusi da Git, insieme ai loro lock e file temporanei. Non vengono eliminati
automaticamente. Il formato append-only resta quello di S1.2.

## Un solo scrittore

La CLI e gli altri chiamanti di `syncSession()` acquisiscono un lock sul percorso
canonico del registro. Il proprietario, PID e token casuale, viene scritto prima
in un candidato privato e pubblicato con un hard link atomico: gli altri processi
non possono vedere un lock vuoto. Il candidato viene poi rimosso.

Un PID vivo impedisce l’acquisizione (`DESTINATION_BUSY`). L’hook attende e
riprova solo questo errore; non rimuove lock vivi né riscrive i dati confermati.
Un lock di un PID morto viene recuperato usando un gate esclusivo legato al token
della vecchia generazione. Questo evita che due recuperi concorrenti eliminino
il lock di un nuovo proprietario. Il lock viene rilasciato dopo la chiusura del
registro, anche quando la sync fallisce.

Il filesystem deve supportare hard link atomici (verificato localmente su Windows).
I percorsi symlink vengono risolti; hard link alternativi al registro non sono
un modo supportato di accedervi in concorrenza. PID riutilizzati sono conservativi:
possono impedire il recupero, ma non autorizzano due scrittori.

## Errori non bloccanti

La CLI figlia ha un budget complessivo di 7,5 secondi, inferiore al timeout di
10 secondi della dichiarazione hook. Gli errori diversi da `DESTINATION_BUSY`
non vengono ritentati. Lo script non inoltra stdout/stderr grezzi del figlio:
legge soltanto il risultato JSON e codici diagnostici controllati.

Lo hook termina con exit code 0 e restituisce `{}` dopo il successo oppure
`{ "continue": true, "systemMessage": "...codice..." }` dopo un errore. Non
richiede continuazioni del modello, non blocca la conversazione e non promette
che una cattura fallita sia riuscita. Il turno successivo riparte dal checkpoint
effettivamente confermato, se la sorgente esiste ancora.

`.codex/hooks/events.jsonl` registra soltanto ID, percorso del transcript, evento,
timestamp, stato, conteggi o codice d’errore. Le righe storiche S1.4 prive di
`status` sono prove di consegna dei metadati, non prove di acquisizione S1.5.

## Recovery e limiti

- Il formato conserva dati e cursore nello stesso blocco verificabile. La sync
  riconosce un blocco completo dopo un esito incerto oppure recupera la sua coda
  incompleta; il lock non sostituisce la recovery del registro.
- Se un processo viene terminato durante una scrittura, il PID morto permette
  al successivo chiamante di recuperare il lock. Se termina durante il recupero
  del lock stesso, un gate residuo può richiedere ispezione manuale. Lock malformati
  non vengono cancellati automaticamente. Non rimuovere lock mentre ci sono scrittori.
- Una cattura oltre il budget viene interrotta e segnalata. I dati ancora nella
  sorgente possono essere recuperati al turno successivo o con `knownex sync`.
- Lo Stop fotografa i record completi disponibili in quel momento. Eventi scritti
  successivamente da Codex, come il completamento dell’hook, saranno acquisiti
  al prossimo Stop. La risposta finale è inclusa nella prova del runtime locale.
- Nessuna garanzia di durabilità fisica oltre alle richieste di flush già
  descritte in `CAPTURE.md`. Nessuna scoperta di sessioni, watcher o daemon.
- Rimangono i vincoli di trust Codex e la differenza di case delle chiavi Windows.
  La dichiarazione non è modificata da S1.4 e non viene autorizzata automaticamente.

## Verifica

Fixture locali coprono ripresa, righe incomplete, sessioni distinte, invocazioni
concorrenti, errori senza fuga di contenuti, budget temporale e lock dopo arresto
del proprietario.

### Prova reale VS Code — 3 novembre 2026

Due turni consecutivi nella stessa chat producono due acquisizioni automatiche:
24 e 12 record, in due blocchi con checksum e catena validi. Entrambe le risposte
finali sono presenti nel registro. L’utente conferma risposte normali.

Dopo `Developer: Reload Window` e la riapertura della stessa chat, il terzo Stop
viene eseguito ma restituisce `FILE_CHANGED`. Il JSONL attuale ha un’identità
filesystem diversa e il suo prefisso non coincide con quello acquisito; inoltre
misura 223834 byte contro un cursore confermato a 225930 byte. La copia conservata
resta integra, ma non costituisce più un prefisso del JSONL corrente. Il terzo
turno è presente nella sorgente e non nel registro.

Il riavvio su una sorgente invariata è coperto dai test; la ripresa reale osservata
comporta invece una sostituzione con modifica del contenuto. Non azzerare il
cursore né ignorare il controllo: occorre definire esplicitamente come conservare
e riconciliare le generazioni della sorgente prima di supportare questo caso.
La causa interna della riscrittura Codex non è accertata. Stato di questa prova
precedente alla correzione: **PARTIAL**.

### Correzione S1.5.2

La sync ora conserva le sostituzioni della stessa sessione come nuove generazioni
nello stesso registro: formato, verifica dell’identità e recovery sono descritti
in `CAPTURE.md`. La fixture riproduce 36 record legacy e 52 paginated, conservati
come 88 record fisici senza deduplicazione semantica. La correzione è verificata
con fixture sintetiche; la prova reale sopra documenta il comportamento precedente.
L’hook e la sua dichiarazione non cambiano.
