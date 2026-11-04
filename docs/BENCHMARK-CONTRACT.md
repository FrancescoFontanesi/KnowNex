# KnowNex Measurement & Benchmark Contract — V0

Stato: **protocollo e strumentazione**, non qualificazione di KnowNex. Questo
documento governa le prove future; non cambia memoria, curator o navigatore.
Unità di lavoro: scenario, checkpoint, invocazione del subagente, risposta del
modello, domanda e comando di recupero. Queste unità non sono intercambiabili.

## 1. Misure e confini osservabili

| Misura                                          | Fonte e classificazione                                                                                         | Limite                                                                                                      |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Input/output main, curator e agente di recupero | Osservati: `token_usage_record.payload.usage` nei JSONL locali Codex, per `turn_id`, `thread_id`, `response_id` | Dipende da versione, accesso e completezza del runtime; non è una misura indipendente di fatturazione       |
| Totali token del turno                          | Derivati: somma di risposte distinte; confronto con ultimo `turn_token_usage`                                   | Mai sommare `token_count` o contatori cumulativi alle risposte                                              |
| Cache/reasoning                                 | Contatori separati, quando presenti                                                                             | Cache è parte dell'input; reasoning è parte dell'output. Non aggiungerli ai totali                          |
| Invocazioni del subagente, correzioni e retry   | Registro tentativi del protocollo, correlato alle deleghe main e ai thread runtime                              | Una delega può produrre molte risposte del modello. Un retry del provider non esposto resta ignoto          |
| Risposte LLM                                    | Conteggio derivato di `response_id` distinti nella porzione runtime dichiarata                                  | Non equivale a deleghe, turni o chiamate al navigatore                                                      |
| Chiamate di recupero                            | Un record per esecuzione del wrapper, incluse ripetizioni, errori e ricerche senza risultati                    | Sono comandi; eventuali chiamate agli strumenti esterne al wrapper richiedono audit separato                |
| Byte stdout/stderr                              | Osservati sui Buffer restituiti dal processo, con SHA-256 separati                                              | Precedono eventuali troncamenti/envelope/compattazioni del tool Codex; non provano i byte letti dal modello |
| Pending, STATE e Knowledge                      | Byte UTF-8 delle stringhe nel packet; dimensioni e hash dei file congelati                                      | Sono contesto preparato/offerto, non prova di lettura effettiva                                             |
| Byte effettivamente consegnati al modello       | Disponibili solo se il trasporto li espone integralmente e il relativo output è conservato                      | Altrimenti `null`, anche se i byte del comando sono noti                                                    |
| Costo monetario                                 | `null`                                                                                                          | Nessun prezzo, conversione byte/token o stima di fatturazione                                               |

Non correggere retroattivamente i report R3/R4/E1/Q1. Un audit successivo può
aggiungere misure runtime con fonte, hash, turno e righe: le precedenti assenze di
token restano dichiarazioni della strumentazione allora utilizzata.

## 2. Raccolta riproducibile

Nessuna nuova dipendenza. Da root, con Node supportato dal progetto:

```powershell
New-Item -ItemType Directory -Path .local/benchmark-run
node scripts/measure.ts context --run RUN_CONGELATO --output .local/benchmark-run/context.json
node scripts/measure.ts runtime --source TRANSCRIPT_LOCALE --turn ID_TURNO --output .local/benchmark-run/runtime.json
node scripts/measure.ts tool --log .local/benchmark-run/commands.jsonl -- node dist/index.js memory state --memory COPIA_MEMORIA
node scripts/measure.ts tool --log .local/benchmark-run/commands.jsonl -- node dist/index.js memory find CSV --type history --memory COPIA_MEMORIA
node scripts/measure.ts tool --log .local/benchmark-run/commands.jsonl -- node dist/index.js memory read H000005 --memory COPIA_MEMORIA
```

I report opzionali sono creati esclusivamente (`wx`); non sovrascrivono risultati.
Il wrapper conserva stdout/stderr senza decodificarli e propaga l'exit code. Ogni
record contiene ID, argomenti, hash, byte, esito e completezza, senza il corpo dei
documenti. Non inserire credenziali negli argomenti. Directory e log locali sono
privati e ignorati da Git; i report condivisibili contengono solo aggregati.

Usare esecuzioni seriali e una directory nuova per prova. Il log è una traccia di
misura, non un registro transazionale: una scrittura interrotta o un output oltre
il limite del wrapper (64 MiB per stream) rende la misura incompleta, da conservare
come tale. Non cancellare tentativi falliti. Il wrapper misura solo il processo
figlio: una shell o uno script che raggruppa letture nasconde le singole operazioni;
per le prove ogni comando rappresenta una sola operazione dichiarata.

L'import runtime supporta il formato osservato `token_usage_record`, seleziona un
turno esatto e una singola identità thread, deduplica per risposta e rifiuta conflitti.
`complete` richiede inizio/fine turno, contatori riconciliati e nessuna coda JSONL
incompleta. Schemi non supportati producono `unavailable`, mai zero token; evidenze
parziali producono `partial`. Non attribuire un intero transcript main al solo
benchmark: importare separatamente tutti e soli i turni dichiarati nel manifest.
Un file live è una fotografia a un confine di lettura, non una garanzia di chiusura.

Il report `context` misura anche file packet, WINDOW, skill, contratto e direttiva.
Non sommare di nuovo campi già inclusi nel packet per ottenere un totale consegnato.
Il manifest elenca i file davvero offerti, istruzioni aggiuntive, letture osservate
e relativo confine di misura. Tool definitions, contesto ereditato e envelope non
osservabili restano esclusi dai byte noti, ma possono contribuire ai token runtime.
Usare UTF-8 senza pipe native ASCII di Windows PowerShell: Q2 dimostra che il
comando del subagente può essere corretto mentre la proposta su disco è già alterata.

## 3. Piano, scenari e oracoli prima dell'esecuzione

Congelare in `.local/<run>/plan.json` versione del contratto e hash di:

- sorgenti, feed e cutoff, memoria iniziale, artefatti autorizzati;
- oracolo, domande, direttive, istruzioni dei baseline e lista degli input;
- versione Node/Codex, modello e reasoning main/curator/recupero, piattaforma;
- varianti disponibili, ordine delle prove e seed, ripetizioni, budget e regole di voto.

L'oracolo indipendente viene costruito dalle sorgenti prima di vedere risposte o
proposte. Per ogni domanda elenca fatti atomici attesi, priorità critica/ordinaria,
fonti verificabili, decisione attiva/superata, limiti dei risultati, artefatti e
assenze legittime. Un revisore separato, cieco alla variante quando possibile,
confronta le risposte con l'oracolo. Conservare giudizi e motivazioni, non solo un
punteggio. Una risposta nuova non autorizza a cambiare l'oracolo: errori del piano
invalidano la prova e richiedono una nuova versione, mantenendo la precedente.

Riutilizzare R3 (prepare/apply e continuità), R4 (query e finestre), E1 (scenario e
oracolo longitudinali) e Q1 (supersession, rumore, costi) come evidenze storiche.
I relativi modelli, richieste, wrapper e condizioni differiscono: non sono una
graduatoria causale A/B/C. Un file mancante resta mancante; non ricostruirlo dal report.

Le future suite devono includere almeno due filoni indipendenti, tre checkpoint,
una decisione sostituita, troubleshooting irrilevante, un problema risolto, un task
aperto, un risultato con artefatto e domande correnti/storiche/assenti. Variare i
termini delle domande e includere identificativi e parafrasi; non costruire casi
solo intorno al ranking lessicale. Stratificare per byte effettivi di STATE,
HISTORY, Knowledge e numero di note, con confini fissati nel piano prima del pilot.
Non presentare un laboratorio sintetico come produzione o come copertura di scale
di memoria non provate. Pilot e suite definitiva usano scenari/domande disgiunti.

## 4. Protocollo per checkpoint e recupero

Per ogni checkpoint: accumulare pending, congelare il cutoff, misurare input e
fornire la direttiva main. Registrare ogni delega, inclusi retry/correzioni, come
tentativo con ID, checkpoint, thread/turno runtime, modello/reasoning, prompt/input
hash, motivo (`initial`, `correction`, `retry`) ed eventuale tentativo precedente.
Per ogni validate/apply conservare esito, codice di rifiuto, sigillo, checkpoint e
hash prima/dopo. Il conteggio delle deleghe è il numero di tentativi verificati;
il conteggio delle risposte LLM è quello dell'import runtime, per ruolo separato.
Costi main di preparazione, revisione e correzione appartengono alla curatela, non
vanno omessi dal confronto con il costo del solo subagente.

Valutare separatamente: fatti necessari conservati; decisioni superate ancora
attive; proposte trasformate in decisioni; troubleshooting senza valore; attività
aperte; riferimenti ad artefatti e distinzioni dichiarato/verificato/simulato.
Verificare HISTORY append-only, vecchio STATE archiviato, provenienza, checkpoint,
idempotenza e integrità dei byte. La fedeltà strutturale non dimostra quella semantica.

Per ciascuna domanda usare un nuovo agente stateless con solo percorso, domanda e
istruzioni minime della variante. Iniziare da STATE; consultare dettagli storici
soltanto quando richiesti. Vietati feed, oracolo, report di valutazione e HISTORY
completa nelle prove ordinarie. Loggare ogni ricerca/lettura, documenti e segmenti
consultati, query senza risultati, riletture, byte e risposte. Se non è possibile
provare l'assenza di letture nascoste, dichiarare il limite dell'audit.

Assegnare a ogni fatto `corretto`, `parziale`, `errato`, `omesso` o `assenza
correttamente dichiarata`. Per la soglia di accuratezza contano solo fatti
completamente corretti; rendicontare anche le altre categorie. Distinguere:
informazione persa nella curatela ma presente nel feed; informazione conservata ma
non trovata; errore del navigatore; strategia inefficiente dell'agente; indisponibilità
reale della fonte. Non interpretare `not_found` come prova che un fatto non esiste.

## 5. Baseline confrontabili

| Variante               | Accesso                                                                                                      | Condizione                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| A — KnowNex R4         | `state`, `find`, `read` esistenti                                                                            | Memoria distribuita congelata; nessun cambiamento al ranking                                                        |
| B — strumenti testuali | Lettura UTF-8 di STATE, ricerca letterale con `rg` o scansione standard library, letture mirate sui Markdown | Gli stessi byte di memoria e artefatti di A, senza indice o memoria aggiuntiva; registrare file/finestre letti      |
| C — rolling monolitico | Un documento aggiornato incrementalmente, con ricerche/letture testuali                                      | Stesse sorgenti/cutoff, informazioni accessibili, modello, direttive e vincoli; misurare anche il costo di produrlo |

Per B è ammesso, ad esempio, avvolgere `rg --fixed-strings` e letture Node nel
wrapper `tool`; registrare separatamente le letture successive ai match. Per
HISTORY leggere finestre pertinenti, non l'intero file per aggirare il protocollo.
La superficie d'accesso di ciascuna variante deve essere fissata nel piano.

Non costruire C concatenando a posteriori STATE e Knowledge già curate da A:
trasferirebbe gratuitamente selezione e informazioni. Se non esiste una produzione
rolling confrontabile, C è `non disponibile` e il confronto resta A/B, con limite
esplicito. Non creare ora un nuovo formato di memoria o una skill per C.

Stessi modelli, reasoning, domande, disponibilità delle fonti, criteri e ripetizioni.
Eseguire cinque ripetizioni stateless per domanda/variante, con ordine bilanciato
fissato nel piano; niente cronologia condivisa o coaching tra tentativi. Separare
costo una tantum della curatela e costo per recupero. Pubblicare valori individuali
e mediane, includendo tutti i tentativi. Eventuali indici dinamici o navigazione per
link futuri si confrontano come nuove varianti dello stesso protocollo, senza
cambiare oracolo, scala, budget o domanda dopo aver visto il risultato.

## 6. Gate di qualificazione futura

Requisiti di qualità fissati ora:

- 100% dei fatti critici corretti in ogni ripetizione, inclusi decisioni attive,
  attività aperte, ambito delle verifiche e assenze richieste; zero invenzioni critiche.
- Almeno 95% dei fatti ordinari completamente corretti per variante su ciascuno
  scenario; riportare sempre numeratore e denominatore, oltre alla percentuale.
- Zero corruzioni, modifiche storiche non autorizzate, riferimenti invalidi o
  checkpoint incoerenti; tutti i rifiuti e retry conservati e conteggiati.
- STATE sufficiente al cold start e recupero storico mirato riuscito per tutte le
  domande critiche; ogni perdita rispetto alla sorgente classificata esplicitamente.

Motivazione: errori su decisioni o limiti possono far riprendere lavoro errato;
sono quindi bloccanti anche quando la media complessiva appare buona. Le soglie
non autorizzano a scartare risposte difficili o rinominare fatti critici a posteriori.

Budget prestazionali: **non ancora calibrati**. Le differenze E1/Q1 non li giustificano
perché cambiano insieme modello, istruzioni e strategia. Prima della suite definitiva:

1. Eseguire un pilot A/B controllato e, se disponibile, C, sulle scale previste.
2. Per ogni classe di domanda fissare cap chiamate e byte all'inviluppo massimo
   delle cinque ripetizioni valide B del pilot. Fissare separatamente cap di
   invocazioni/retry e byte di input offerti al curator usando il pilot del controllo
   procedurale A. Esplicitare numeri, fonti e raggruppamenti; non sommare sottoinsiemi
   del packet. L'inviluppo osservato concede la variabilità già misurata, senza
   pretendere una stima di percentile o garanzia statistica da cinque osservazioni.
3. Congelare piano e budget numerici con hash prima della suite disgiunta. Se il
   pilot non dà confronti validi, il gate prestazionale resta non valutabile.
4. Nella suite nessuna ripetizione può superare i cap congelati. Mostrare anche
   rapporti appaiati, dispersione e trade-off qualità/costo; non attribuire miglioramenti
   a una componente se cambiano altre condizioni. Token sono un asse separato:
   un claim di efficienza sui token richiede copertura runtime completa per tutti
   i ruoli e un budget token calibrato/fissato nello stesso modo prima della suite.

Esiti della **qualificazione futura**, distinti dal completamento di V0:

- **READY**: gate di qualità e budget congelati rispettati, prove comparabili e
  tracce complete per il perimetro dichiarato. Non significa superiorità generale.
- **PARTIAL**: qualità dimostrata solo sul perimetro coperto, ma token, C, scala o
  budget mancano; vietata la certificazione relativa alla dimensione mancante.
- **BLOCKED**: errore critico, violazione d'integrità, oracolo contaminato, fonti non
  verificabili, oppure confronto non controllato usato per sostenere la qualificazione.

V0 termina con una verifica della strumentazione e un audit supplementare locale.
Non esegue la suite definitiva e **non dichiara KnowNex qualificato**.
