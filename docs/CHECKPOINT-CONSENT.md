# Checkpoint con consenso utente S4.2

Il principale sceglie semanticamente quando proporre il checkpoint; l'utente
decide solo Si/No. Non deve scegliere STATE, HISTORY, Knowledge o direttive.
Il conteggio pending gia esposto da runtime/SessionStart e la salvaguardia
deterministica: rende visibile arretrato senza attribuirgli significativita
semantica. Nessuna soglia numerica, watcher o delega periodica.

## Workflow e percorso manuale

L'utente puo scrivere **checkpoint** in chat. Il principale usa, nel turno
utente acquisito ancora aperto, `npm exec --offline -- knownex checkpoint`.
Per un milestone autonomo aggiunge `--milestone CHIAVE`: chiave stabile della
novita sostanziale. Il comando inizializza solo il seed vuoto a sequenza zero
se necessario e restituisce ID richiesta, cutoff e domanda. Nessuna proposta LLM.
Equivalente con workspace gia inizializzato:
`knownex curate request --work .knownex/curator --milestone CHIAVE`.

Solo un esito `requested` richiede al principale di porre la domanda restituita:
«Vuoi consolidare la memoria del progetto adesso? (Sì/No)». Deve essere il testo
finale completo, salvo il prefisso obbligatorio `[AXIOM]` se previsto nel progetto.
L'ID resta nei dati operativi: l'utente non deve copiarlo.
Il comando in una shell fuori da un turno aperto viene rifiutato e non equivale
a una conferma nella chat. Non si registra ne si promette uno slash nativo.
Il percorso manuale supportato e il messaggio ordinario in chat, seguito dalla
stessa domanda Si/No. L'attivazione effettiva da parte del modello resta da
verificare in una sessione reale.

Dopo il Si acquisito, il principale scrive la direttiva contestuale ed esegue:

```powershell
npm exec --offline -- knownex curate prepare --work .knownex/curator --directive .knownex/directive.md --request ID
node node_modules/knownex/dist/curator-request.js --run RUN --output RUN/request.txt
# Una sola delega single-pass; persistere il JSON originale in RUN/proposal.json.
npm exec --offline -- knownex curate validate --work .knownex/curator
npm exec --offline -- knownex curate apply --work .knownex/curator --confirm SIGILLO
```

ID, RUN e SIGILLO sono quelli restituiti. Il writer della richiesta usa creazione
esclusiva: scegliere un output nuovo per ogni batch senza sovrascrivere evidenze.
La build compila anche il helper esistente in JavaScript per Node nel package.
Nessun retry LLM automatico; su errore resta il pending. Il helper single-pass
e ora incluso nella lista del package; l'archivio S3 rimane invariato.

## Legame e consumo

`consent.json` usa lock curator, scritture atomiche e barriere esistenti. Registra
ID, milestone, checkpoint base, cutoff, identita del turno della domanda e
sequenza/checksum del prompt acquisito. Il cutoff e l'ultima risposta finale
acquisita alla richiesta: domanda, consenso ed eventi successivi restano pendenti.

Serve la domanda esatta acquisita come assistant_final da Stop nel turno
identificato, seguita dal primo UserPromptSubmit nella stessa sessione e in un
turno diverso. Solo `Si` o `Sì`, ignorando maiuscole e spazi esterni, autorizzano.
No rifiuta; altro testo e ambiguo; silenzio non autorizza. Un si fuori contesto,
una dichiarazione del modello o una risposta in un'altra sessione non autorizzano.
Un ulteriore prompt prima del congelamento rende obsoleto anche un Si precedente.

Prepare consuma il consenso prima di staging/delega, legandolo a un solo run e
cutoff. Prepare ripetuta puo solo restituire quel batch, senza una nuova delega.
Apply ricontrolla consenso, risposta sorgente, batch e sigillo prima di apply.json.
La CLI richiede il controllo anche sui feed legacy.
La CLI init ammette solo sequenza zero: non permette di aggirare il consenso
copiando una memoria con un cutoff positivo in un nuovo workspace.
Le API dei feed di progetto
lo impongono automaticamente. Una registrazione `<feed>.curator.json`, sotto
lock del feed, vincola l'autorita di consenso a un solo workspace curator:
un altro `--work` non puo riusare la stessa domanda/risposta. Spostamenti e
migrazioni non sono automatici. Le API legacy di basso livello mantengono la
precedente responsabilita del chiamante: non sono un confine contro codice
arbitrario con accesso al filesystem.

La stessa chiave milestone non produce un'altra domanda dopo un rifiuto. Nuove
chiavi richiedono novita significative o richiesta manuale, responsabilita del
principale. Un processo riavviato rilegge i file senza assumere consensi in RAM.
Una nuova sessione non eredita richieste non confermate; la ripresa dello stesso
session_id conserva soltanto il legame contestuale esistente. Dopo consumo,
un fallimento non riabilita il grant. Pending e batch rimangono disponibili;
batch incompleti richiedono risoluzione esplicita.

Un apply.json gia pubblicato rimane autorizzato: la recovery puo completarlo
senza un nuovo Si. Il replay della ricevuta e idempotente, non una nuova operazione.
Le garanzie di storage restano invariate. Il controllo si fida del writer/feed e
di file non falsificati arbitrariamente: checksum non autenticano l'essere umano
contro strumenti privilegiati capaci di creare direttamente payload o file.

## Evidenza e limiti

### Batch fallito S4.6

Prima di S4.6 un errore non strutturale lasciava pending.json attivo senza un
percorso CLI di ritiro: anche un nuovo checkpoint manuale rimaneva bloccato.
Ora il principale puo ritirare esplicitamente il batch non confermato, solo
quando la delega e terminata e l'utente chiede un nuovo tentativo:

```powershell
npm exec --offline -- knownex curate abandon --work .knownex/curator --run ID
# Solo dopo il ritiro: nuova richiesta manuale e nuovo Si/No acquisito.
npm exec --offline -- knownex checkpoint
```

ID identifica il run da ritirare; non e l'ID di consenso. Un ID diverso da quello
attivo e rifiutato. Il comando usa lock e stateAt esistenti: prima completa la
recovery obbligatoria e verifica checkpoint, feed e memoria. Rimuove e sincronizza
solo pending.json, conservando run, proposal/candidato, grant consumato e tutti
gli eventi. Non avanza il cutoff, non cancella journal e non ripristina grant.
Un secondo ritiro senza batch e innocuo. Se la recovery ha gia completato quel
run, l'esito e already_applied: nessun annullamento della promozione autorizzata.

| Confine del fallimento                                                    | Stato e ripresa                                                                                                                                  |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delega fallita/proposal assente                                           | Nessun apply confermato, eventi e batch conservati, grant consumato; lavoro ordinario possibile con storage coerente. Nessuna delega automatica. |
| JSON invalido o validate rifiutata                                        | Nessuna promozione; stesso ritiro esplicito e nuova autorizzazione per un nuovo batch.                                                           |
| Review semantica rifiutata                                                | Il principale non invoca apply; staging conservato, nessun retry LLM o modifica artificiale della proposta.                                      |
| Errore prima della pubblicazione di apply.json                            | Il batch resta non confermato; puo essere ritirato dopo la verifica di coerenza.                                                                 |
| Interruzione/errore dopo apply.json, anche se la CLI ha restituito errore | La recovery esistente prevale sul ritiro: completa l'applicazione autorizzata senza LLM o nuovo Si.                                              |
| Recovery impossibile o evidenze corrotte                                  | Letture confermate, ritiro e nuove richieste restano bloccati; serve intervento sulle evidenze, senza reset o riparazioni arbitrarie.            |

curatorStatus/runtime espongono unconfirmedRun, derivato dal grant consumato e
dal checkpoint ancora invariato, anche dopo il ritiro o una preparazione rimasta
incompleta prima del puntatore. Non e un nuovo stato persistente ne una prova di
fallimento semantico. SessionStart segnala il tentativo non confermato e gli eventi
conservati. Il principale comunica sinteticamente mancata conferma, conservazione
degli eventi e possibilita di proseguire; su errori di integrita segnala invece
memoria non verificata e intervento necessario. Nessuna notifica periodica.

La nuova richiesta manuale usa un nuovo prompt acquisito, un nuovo ID di consenso
e una nuova conferma Si/No: non aggira la soppressione delle ripetizioni cambiando
silenziosamente chiave. Il nuovo batch riparte dal checkpoint immutato, includendo
gli eventi non confermati precedenti e lasciando pendenti quelli oltre il nuovo
cutoff. Il vecchio sigillo non puo applicare un run ritirato. Non si cancellano
directory di staging per forzare progresso.

I test riusano le fixture S4.2 e V2.3b: quattro fallimenti pre-journal, ritiro
tramite CLI, vecchio grant/sigillo rifiutati, nuova sessione/processo, nuovo consenso
e nuovo batch; inoltre ritiro durante apply interrotto e rifiuto conservativo su
journal/checkpoint/file corrotti. Sono test di lifecycle e integrita; il rifiuto
semantico e una decisione esplicita nella fixture, non un classificatore simulato.
Restano da validare nella chat reale comunicazione, terminazione della delega e
gestione del nuovo tentativo da parte del principale.

### Feedback amministrativo S4.4

Il cutoff precede domanda, risposta e report finale: questi eventi restano
normalmente pendenti anche dopo il successo. Il feed conserva integralmente gli
eventi acquisiti e non li cancella in base alla rilevanza. Il recupero delle code
incomplete mantiene il comportamento gia documentato; S4.4 non filtra il feed.

Il principale non deve proporre un checkpoint per svuotare il pending o per il
solo completamento di quello precedente. STATE e Knowledge non sono una cronaca
amministrativa; HISTORY resta generata dal protocollo append-only. Fallimenti
persistenti, cause diagnosticate, blocker di continuita e decisioni di sviluppo
di KnowNex rimangono invece eleggibili, con il loro grado di certezza.

Il controllo esistente riconosce con certezza la risposta di consenso gia
consumata tramite sequenza/checksum: da sola restituisce noop, anche se viene
fornita una nuova chiave milestone. Non avanza il cutoff e non crea richieste.
Dopo il report finale manca un nuovo turno utente aperto, quindi la richiesta
resta impedita dal controllo S4.2 gia presente. Un batch fallito rimane attivo
e non viene sostituito automaticamente. Nuovi input progettuali possono ancora
portare a una nuova proposta e al consueto consenso monouso.

SessionStart descrive il pending come arretrato non necessariamente sostanziale.
Non si etichetta un intero turno come amministrativo: lo stesso turno puo contenere
anche informazioni tecniche utili. I metadati non provano il contenuto semantico
di un report; nei casi incerti decide il principale, senza filtri di parole chiave,
nuovi marcatori o classificatori. Nessuna modifica al protocollo di consenso,
alle sue durate, al cutoff autorizzato o alle regole di consumo.

Le fixture offline verificano risposta consumata senza nuova richiesta, report
conservato, cold start senza mutazioni, nuovo lavoro ammissibile anche se parla
di checkpoint/consenso/KnowNex, e fallimento con pending recuperabile. Non
dimostrano che Sol/Terra comprendano correttamente la rilevanza dei contenuti.

Test sintetici coprono approvazione, No, ambiguita, assenza, si fuori contesto o
dichiarato dal modello, riavvio, cambio sessione, consumo/replay, cutoff, fallimento
e pending preservato. Il bootstrap verifica istruzioni nuove e testo AGENTS
preesistente preservato. Non sono benchmark agentici.
Milestone reali, assenza di domande ripetute con chiavi semanticamente equivalenti,
disponibilita del curator e dialogo Si/No reale restano da verificare.
