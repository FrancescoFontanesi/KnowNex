# Registro di acquisizione S1.2

`syncSession(source, destination)` è una funzione asincrona in `src/capture.ts`.
Entrambi gli argomenti indicano file; la directory destinazione deve esistere.
La funzione crea il registro se assente, senza troncare file esistenti all’apertura.
Non usa transcript reali nei test né richiede dipendenze aggiuntive.

Il risultato contiene:

- `appended`: numero di record aggiunti in questa chiamata.
- `cursor`: checkpoint recuperabile anche dal registro, non da un file separato.
- `recoveredBytes`: dimensione della coda non confermata rimossa durante la recovery.

## Generazioni S1.5.2 e formato versione 2

I blocchi versione 1 restano leggibili senza modifiche e appartengono alla
generazione 1 implicita. Se il reader segnala `FILE_CHANGED`, la sync legge da
zero il nuovo transcript e confronta l’identità con la generazione confermata.
Entrambe devono iniziare con un `session_meta` il cui `payload.id` è una stringa
non vuota; eventuali ulteriori `session_meta` devono concordare. Percorso invariato
e solo nome del file non bastano. Identità assente o contraddittoria, sessione
diversa o JSON completo malformato impediscono la transizione senza modificare
il registro. Il controllo dell’ID non è un’autenticazione crittografica.

La transizione è un unico frame versione 2: contiene tutti i nuovi record completi,
il loro cursore, `generation` incrementato di uno, `sessionId` e
`transition: "FILE_CHANGED"`. `from` riparte da zero; `previous` continua a riferire
il checksum dell’ultimo blocco della generazione precedente. L’hash del prefisso
riparte invece dall’inizio della nuova sorgente. I successivi blocchi versione 2
mantengono generazione e sessione, omettono `transition` e proseguono il cursore.

La recovery valida catena, progressione delle generazioni, identità e prefisso
di ciascuna generazione. Una transizione incompleta non è confermata: viene
ritentata dalla generazione precedente dopo aver validato la sorgente; una
transizione completa viene riconosciuta anche dopo il riavvio del processo.
Lock e garanzie di flush rimangono quelli descritti sotto.

Per ricostruire i byte, raggruppare i blocchi per `generation` (1 se assente),
quindi concatenare le righe di ciascun gruppo con LF. Non concatenare le diverse
generazioni come un unico transcript. `appended` conta record fisicamente
conservati: 36 + 52 significa 88 record, non 88 eventi logici unici. Non viene
effettuata deduplicazione fra generazioni; una sostituzione identica nei contenuti
ma con identità filesystem diversa può creare legittimamente una generazione.

## Formato versione 1

Ogni riga UTF-8 terminata da LF è un frame JSON `{ block, checksum }`.
Il blocco contiene:

- `version: 1`.
- `source`: percorso assoluto risolto con `realpath`.
- `from`: offset iniziale in byte nella sorgente.
- `previous`: checksum del blocco precedente, oppure `null` nel primo.
- `records`: righe originali come stringhe, senza LF, con eventuale CR conservato.
- `cursor`: `{ offset, fileId, prefixHash }` restituito dal reader S1.1.

`checksum` è SHA-256 di `JSON.stringify(block)` codificato UTF-8. La catena,
gli intervalli contigui e l’hash cumulativo dei byte originali vengono verificati
a ogni apertura. Numeri JSON grandi e spaziatura sopravvivono perché si salvano
le stringhe originali, non la riserializzazione dei valori parsati.

La copia sorgente si ricostruisce concatenando ogni `block.records` in ordine,
aggiungendo LF a ogni stringa e codificando UTF-8. È leggibile indipendentemente
dalla disponibilità della sorgente. Il registro conserva solo le righe complete
acquisite; la coda incompleta della sorgente resta a carico di una sync successiva.

Il primo blocco può essere vuoto: registra l’identità di una sorgente ancora vuota
o senza record completi. Le sync senza nuovi record non aggiungono altri blocchi.

## Commit e recovery logica

Eventi e cursore sono nello stesso frame. Il commit logico richiede un frame
completo, valido e terminato da LF. Non si presume atomica una scrittura di file.
Prima di aggiungere dati, la funzione verifica tutti i frame già confermati,
ricostruisce l’ultimo cursore e interroga il reader con quel cursore.

Una coda senza LF non è confermata: viene troncata al confine precedente solo
dopo aver verificato anche la sorgente. I nuovi record vengono riletti e scritti
con il relativo cursore. Nessun byte confermato viene riscritto. `recoveredBytes`
segnala questa recovery anche quando non vi sono nuovi eventi.

Una riga completa malformata, checksum errato, catena interrotta o cursore
incoerente causa `CaptureError` con `code: LOG_CORRUPT` e offset nel registro.
Il registro non viene modificato in questi casi. Le alterazioni della sorgente
sono segnalate dal reader; solo le sostituzioni con identità di sessione confermata
permettono la transizione descritta sopra. Percorsi sorgente differenti o una
nuova identità di sessione non corrispondente causano `SOURCE_MISMATCH`.
Sorgente e destinazione coincidenti, anche tramite hard link, sono rifiutate.
Gli errori I/O nativi si propagano. Dopo un errore di scrittura l’esito può essere
incerto: ripetere la sync permette di riconoscere un frame completo già scritto
oppure recuperare la sua coda incompleta, senza un checkpoint separato.

## Limiti e durabilità

- Un solo scrittore per registro, protetto fra processi dal lock del percorso
  canonico `<registro>.lock`. Un proprietario vivo causa `DESTINATION_BUSY`.
  Un proprietario morto viene recuperato con un gate per generazione; metadati
  malformati causano `LOCK_CORRUPT`. Se un processo muore durante il recupero
  del lock, il gate residuo richiede ispezione manuale: non viene rimosso alla cieca.
  PID riutilizzati sono trattati conservativamente come occupati. Il filesystem
  deve supportare hard link atomici; non usare hard link alternativi alla
  destinazione per aggirare il percorso canonico. Sostituzioni o modifiche esterne
  della destinazione non sono supportate e, quando osservate, causano
  `DESTINATION_CHANGED`.
- Ogni successo attende `FileHandle.sync()`, anche se non aggiunge eventi.
  Si richiede così il flush al sistema operativo; non sono dimostrate garanzie
  contro perdita di alimentazione, cache hardware o riordino fisico delle scritture.
  La directory padre non viene sincronizzata: la durabilità del nome di un nuovo
  registro dopo un guasto non è garantita.
- I test simulano interruzioni del frame finale a ogni confine di byte e una
  riapertura da un altro processo. Dimostrano recovery logica, non un power cut.
- Checksum e catena rilevano incoerenze, non autenticano contro manomissioni
  deliberate. La rimozione di interi blocchi finali su un confine valido non è
  distinguibile senza un checkpoint indipendente; se la sorgente esiste ancora,
  i record rimossi vengono acquisiti nuovamente.
- Una coda priva di LF non permette di distinguere scrittura interrotta e
  danneggiamento del terminatore: entrambe vengono trattate come non confermate.
- La verifica rilegge tutto il registro e il prefisso sorgente. Il registro e la
  nuova coda sorgente sono caricati in memoria. Restano i limiti S1.1 relativi a
  riscritture concorrenti e identità del filesystem.
