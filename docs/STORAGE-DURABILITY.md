# V2.3 / V2.3b — Durabilità delle promozioni

Il [versionamento Knowledge](KNOWLEDGE-REVISIONS.md) estende il journal ai soli nuovi
archivi/ricevute: i loro file e il namespace `revisions/` vengono sincronizzati
prima del checkpoint v3. La recovery v1 rimane supportata. Questa estensione è
verificata con crash/EIO simulati e non aggiunge evidenze di durabilità fisica.

**V2.3b: protocollo implementato e verificato sotto modello B condizionale.**
La durabilità fisica C rimane non dimostrata; non viene avviata la qualificazione.
Le sezioni V2.3 conservano diagnosi e misure precedenti, non descrivono il codice
successivo a V2.3b.

## Ambiente e primitive effettive

Verifica locale del 4 novembre 2026: Windows 11 Pro, build 26200
(`10.0.26200`), Node.js `v24.11.1`, libuv `1.51.0`, volume `F:` NTFS fisso.
La prova crea soltanto file temporanei sullo stesso volume del workspace:

| Operazione reale                                                         | Esito                   |
| ------------------------------------------------------------------------ | ----------------------- |
| Scrittura su file aperto `wx`, `FileHandle.sync()`, chiusura e rilettura | OK                      |
| Directory aperta `r`, `FileHandle.sync()`                                | `EPERM` nella fase sync |
| Directory aperta `r+`, `FileHandle.sync()`                               | OK                      |

Il successo indica completamento della chiamata nell'ambiente osservato, non
una verifica dei dati sopravvissuti a un blackout. Non è corretto sostenere che
il sync delle directory sia sempre indisponibile su Windows.

Fonti primarie consultate:

- [Node 24.11.1: FileHandle.sync](https://nodejs.org/download/release/v24.11.1/docs/api/fs.html#filehandlesync)
  espone il flush; `writeFile` senza `flush: true` non lo richiede.
- [libuv 1.51.0, implementazione Windows](https://github.com/libuv/libuv/blob/v1.51.0/src/win/fs.c):
  `fs__sync_impl` usa `FlushFileBuffers`; `fs__rename` usa `MoveFileExW` con
  `MOVEFILE_REPLACE_EXISTING`, senza `MOVEFILE_WRITE_THROUGH`.
- [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)
  richiede un handle con accesso in scrittura. Il flush di un intero volume è
  distinto e richiede privilegi amministrativi; non viene tentato.
- [MoveFileExW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
  descrive un flag write-through separato. Non si deduce la durabilità del rename
  usato da Node dal solo successo della sua Promise.

## Percorso V2.1 verificato in V2.3

`atomicText` attende `writeFile` sul temporaneo, poi `rename`. `applyCurator`
pubblica `apply.json` prima di promuovere i Markdown; `recoverApply` sostituisce
i file cambiati, verifica l'hash dell'albero, pubblica il checkpoint e rimuove
pending. Il temporaneo dei Markdown rimane fuori da `memory/`.

Questo è un ordine di completamento delle API, **non un ordine di persistenza
dimostrato**. Mancano flush espliciti sia del journal sia dei contenuti promossi,
del checkpoint e dei metadati dei rename. La rilettura con hash può osservare
la cache del sistema: non certifica il supporto fisico. Anche run, pending e feed
necessari alla recovery devono essere disponibili e integri dopo il riavvio.

Con record integro, checkpoint precedente e pending valido, la recovery accetta
solo file interi precedenti/successivi e completa quelli mancanti. Con checkpoint
successivo richiede l'intero albero successivo: un contenuto precedente viene
bloccato, non riparato automaticamente. Journal mancante/corrotto, file mancanti
o troncati e checkpoint incompatibili possono impedire il recupero. Hash e lock
rilevano incoerenza nei casi supportati, ma non ricreano evidenze perdute.

Le letture di workspace riconosciuti passano dal lock e da `stateAt`, che esegue
recovery prima di verificare feed e hash e restituire dati. Le directory standalone
non hanno questa protezione transazionale. Se un blackout perdesse sia checkpoint
sia journal, il riconoscimento basato sui loro percorsi potrebbe trattare la memoria
residua come standalone: la protezione V2.1 non è una garanzia generale per tale
scenario, non riprodotto da una reale perdita di alimentazione in questa verifica.

## Tre nuovi casi deterministici

1. Probe delle primitive su filesystem reale: esiti file/directory riportati sopra.
   Nessuna iniezione o interruzione di alimentazione.
2. `EIO` iniettato prima del rename del checkpoint: journal e Markdown nuovi
   esistono, checkpoint resta precedente e il lock viene rilasciato. Una lettura
   completa la recovery; HISTORY ha un solo segmento e il replay non cambia i dati.
3. Prefissi di persistenza divergenti costruiti su file reali: checkpoint nuovo
   con HISTORY precedente blocca lettura, prepare e apply senza modifiche.
   Lo stesso albero misto con checkpoint precedente e pending integro viene
   completato esattamente; il replay è idempotente. È una simulazione di stati
   persistiti, non una dimostrazione che NTFS produca o escluda tali stati.

I test V2.1 continuano a simulare arresti del processo ai confini dei rename e
della pulizia. Né questi arresti né l'EIO iniettato svuotano le cache del kernel,
del controller o del dispositivo. Nessuno spegnimento forzato viene eseguito.

Esito locale: i tre nuovi casi passano; `npm run check` passa con 116 test,
typecheck, controllo formato e build. Nessuna regressione V2.1 rilevata.

## Decisione V2.3, superata per il modello B da V2.3b

Non si aggiunge un flush parziale come apparente soluzione al problema completo.
Il sync `r+` riuscito non dimostra da solo un contratto end-to-end per la
persistenza delle directory, dei rename e del dispositivo. Una soluzione dovrebbe
stabilire e validare tutte le barriere necessarie, inclusi i prerequisiti di recovery;
questa verifica non le dimostra e non introduce nuove primitive native o infrastrutture.
Il limite contro power loss rimane esplicito. Nessun test agentico o LLM aggiuntivo.

## Contratto e assunzioni V2.3b

La fonte aggiuntiva è [MS-FSA §2.1.5.7](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/0de7dc40-9627-437e-a4df-c4696cdc3d02):
il flush persiste attributi, metadati e struttura delle directory e richiede il
flush dello storage sottostante. La [nota prodotto 80](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/4e3695bd-7574-4f24-a223-b4679c065b63)
specifica che il comportamento è implementato da NTFS; altri filesystem possono
restituire successo senza effettuare questa operazione. Questa fonte restringe
il precedente blocco: il solo probe non costituiva un contratto sufficiente.

Il modello B assume esplicitamente:

- NTFS locale, Node 24.11.1/libuv 1.51.0, directory apribili `r+`; la catena
  `FileHandle.sync` → `FlushFileBuffers` soddisfa il contratto NTFS sopra indicato
  per gli oggetti aperti, comprese le directory. Il tipo del volume viene
  verificato esternamente (`Get-Volume`): `statfs` Node restituisce type 0 qui
  e non costituisce un controllo affidabile per abilitare altri filesystem.
- Un flush riuscito rende stabili contenuto/metadati dell'oggetto; il flush di una
  directory rende stabili i nomi immediati. Flush successivi non invalidano dati
  già stabili. Prima del flush scritture e nomi possono persistere separatamente,
  perdere aggiornamenti o lasciare assente il nome coinvolto in un rename.
- Il namespace degli antenati già esistenti del workspace e delle sorgenti è
  stabile; `init` persiste la nuova memoria e il nome del workspace prima di
  confermare il checkpoint. Un vecchio workspace deve partire da una generazione
  coerente; non si promette il recupero retroattivo di evidenze già perse.
- Feed append-only con prefisso congelato e nessuna riscrittura concorrente;
  artefatti originali e namespace delle sorgenti già stabili. File, directory,
  filtro, controller e dispositivo rispettano i flush; niente corruzione
  collaterale di blocchi già sincronizzati. Tutti gli scrittori della memoria
  rispettano il lock. Non sono assunte scritture arbitrarie atomicamente resistenti
  ai crash: i temporanei incompleti restano fuori dalla memoria confermata.

Queste sono condizioni del modello, non misure dell'hardware. Nessuna garanzia
B è estesa a FAT/ReFS, SMB o dispositivi che ignorano i flush. Un fallimento di
sync si propaga; non esiste fallback che ignori errori delle directory. I flush
richiedono accesso in scrittura anche alle sorgenti da sincronizzare; permessi
insufficienti fermano l'operazione prima della promozione.

## Ordine persistente V2.3b

| Fase                    | Barriere prima di procedere                                                                                                                                | Ragione                                                                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Baseline e prerequisiti | Flush della memoria precedente, knowledge, memory e work; checkpoint precedente; run.json, directory run e runs; feed e sua directory; work e suo genitore | Rendere recuperabile la generazione iniziale e i prerequisiti prima dell'autorizzazione persistente. Prepare persiste anche run/runs/work prima del pending. |
| Journal                 | Scrittura esclusiva del temporaneo, sync del contenuto, chiusura, rename verso apply.json, sync del file pubblicato e di work                              | Nessun Markdown cambia prima che dati e nome dell'autorizzazione siano stabili.                                                                              |
| Markdown                | Per file cambiato: temporaneo in work, sync, rename, sync del file e delle directory destinazione/sorgente                                                 | Contenuti completi prima dei nomi; i temporanei eventualmente riapparsi non entrano nell'albero confermato.                                                  |
| Albero completo         | Hash finale; nuovo flush di tutti i file, knowledge, memory e work                                                                                         | Coprire anche nomi già visibili da un tentativo interrotto e la creazione di knowledge nel suo genitore.                                                     |
| Checkpoint              | Temporaneo sincronizzato, rename, sync del file e di work                                                                                                  | Il checkpoint può diventare stabile solo dopo tutti i dati che rappresenta.                                                                                  |
| Pulizia                 | Ripetere barriera checkpoint/work prima di unlink pending; poi sync work                                                                                   | L'esito del rename può essere visibile prima del ritorno del suo flush. L'ultima apply.json rimane sempre come ricevuta.                                     |

`atomicText` implementa contenuto → pubblicazione → metadati/namespace, senza
considerare il solo rename una barriera. Alla recovery si ripete subito il flush
del journal e di work: un journal visibile potrebbe provenire da una pubblicazione
interrotta prima della sua barriera. Una recovery interrotta può essere ripetuta.

Il record contiene gli alberi precedente e successivo. Con checkpoint precedente
o nome del checkpoint assente, i file mancanti vengono ricostruiti dal record;
quelli esistenti devono coincidere esattamente con la versione precedente o nuova.
Il run si risolve dal runId persistito, senza dipendere dalla sopravvivenza del
pending. Con checkpoint successivo l'albero deve già coincidere con quello nuovo.
Record corrotto, file con contenuto inatteso o checkpoint presente ma incompatibile
fermano il recupero. Il journal mantiene il prefisso HISTORY e non riappende segmenti.

La pulizia del journal non viene introdotta. Alla transazione successiva la sua
sostituzione precede qualsiasi modifica dei dati di quella transazione, mentre
la generazione precedente è già stabile. Journal preallocati con slot riutilizzati
eviterebbero alcuni rename ma richiederebbero bootstrap persistente e selezione
fra slot potenzialmente troncati; inoltre nuove Knowledge e checkpoint avrebbero
ancora bisogno di barriere dei nomi. Non riducono il protocollo qui implementato.

## Verifica A, B, C

- **A — crash consistency:** test V2.1 ai confini della promozione, recovery
  interrotta e replay conservati. EIO sui rename resta un errore simulato distinto.
- **B — modello di persistenza:** un nuovo test traccia scritture, flush nativi,
  rename e unlink della vera apply sulla fixture STATE/HISTORY/due Knowledge.
  Un modello indipendente conserva contenuti solo dopo file-sync e nomi immediati
  solo dopo directory-sync, verificando anche l'ordine journal → dati → checkpoint
  → pulizia. Nove proiezioni alternative sui file reali perdono la scrittura del
  journal non sincronizzata, il suo rename, rename Markdown o checkpoint e la
  pulizia; includono persistenza anticipata e perdita del nome sostituito.
  Una recovery viene interrotta e il suo nome non sincronizzato perso nuovamente.
  Un secondo nuovo test inietta EIO nel flush del journal: nessun Markdown viene
  promosso; la recovery ristabilisce la barriera e il replay non duplica HISTORY.
  La precedente prova del checkpoint mancante ora verifica recupero nel modello,
  invece di richiedere il blocco. Le corruzioni non ricostruibili restano rifiutate.
- **C — durabilità fisica:** non dimostrata. Il modello non misura cosa sopravvive
  su quel controller dopo un blackout. Nessuno spegnimento forzato o cambio di
  impostazioni viene effettuato.

Limiti residui: costo di flush dell'albero e letture di workspace che possono
ripetere barriere di recovery; spazio dei temporanei orfani; lock conservativo
preesistente; disponibilità dipendente dai prerequisiti integri e dai permessi.
Nessun LLM aggiuntivo, benchmark agentico, nuova dipendenza o qualificazione finale.

Esito finale V2.3b: nove scenari della matrice e il fallimento della barriera journal
passano; il checkpoint `null` viene rifiutato. `npm run check` passa con 118 test,
typecheck, controllo formato e build. Verdetto **READY per A e B sotto le assunzioni
indicate; C non dimostrata**.

## Layout canonico della memoria

Le nuove installazioni pubblicano le revisioni direttamente in .knownex/memory/knowledge
e STATE/HISTORY in .knownex/memory. Journal e ricevute rimangono in internal/curator.
Le barriere di pubblicazione e dei parent seguono i percorsi effettivi; prima del
checkpoint vengono sincronizzati anche i HEAD correnti, senza proiezioni piatte
persistenti. La recovery ricostruisce la stessa generazione logica dai HEAD.
I workspace legacy non sono spostati. Nessuna nuova garanzia di durabilita fisica.
Dettagli e limiti dei lettori Markdown esterni: [MEMORY-LAYOUT.md](MEMORY-LAYOUT.md).
