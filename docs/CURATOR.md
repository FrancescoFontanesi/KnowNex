# Curatela procedurale

Il principale usa la [skill checkpoint](../.agents/skills/knownex-checkpoint/SKILL.md)
per delegare un checkpoint al Curator nativo Terra medium. Il curator applica la
[skill editoriale](../.agents/skills/knownex-curator/SKILL.md) e il
[contratto](MEMORY-CONTRACT.md). Nessun provider, scheduler o monitor automatico.
Capture e feed continuano a funzionare indipendentemente dalla materializzazione.

Il principale suggerisce `$knownex-checkpoint` ai milestone; solo l'invocazione
utente acquisita avvia la materializzazione. Nessuna domanda Si/No o interpretazione
dell'assenso. [Protocollo manuale](CHECKPOINT-CONSENT.md).

## Delega nativa ordinaria

Sol usa `node node_modules/knownex/dist/index.js curate native --stage prepare`
con `--work .knownex/internal/curator --authorization captured-user-invocation`;
nel checkout usa `node dist/index.js`. La primitiva risolve l'autorita dal feed,
la consuma per un solo batch e restituisce run ID, requestFile e intervallo.
Sol delega una sola volta a `knownex_curator` (Terra medium), con contesto
indipendente e soltanto questi riferimenti in modalita materialize-only.
Terra legge autonomamente il batch congelato, cura la memoria e produce
gli artefatti via I/O canonico, senza primitive di checkpoint o App Server.
Sol attende le sole ricevute e conclude con la stessa CLI, `--stage complete`,
run esplicito e hash reali delle due ricevute. Validazione e apply condividono
le funzioni del controller esistente, inclusa la verifica finale del feed acquisito; il percorso
non avvia altri agenti. Sol non legge documenti e non ripete l'analisi di Terra.
Se il Curator fallisce, Sol termina senza complete e senza retry.

Sol riceve solo SUCCESS/BLOCKED/ERROR e metadati essenziali. Resta esplicita
l'assenza di review semantica indipendente; anomalie e incertezze dichiarate
bloccano l'apply. Un ruolo non disponibile causa errore, senza fallback.
Limiti delle capacita per-agente e contratto in [CURATION-WORKFLOW.md](CURATION-WORKFLOW.md).

## Controller con launcher esterno: percorso non predefinito

```powershell
npm exec --offline -- knownex curate checkpoint --work .knownex/internal/curator
```

Sol avvia una sola operazione e riceve soltanto esito, cutoff, conteggi disponibili
e warning. Il controller prepara il batch autonomo, genera la richiesta per
riferimenti, verifica le capacita native senza inferenza e avvia una sola
codex exec con autenticazione/provider correnti e modello/effort economici
configurati. Attende internamente, verifica ricevute, valida e applica con sigillo.
Non richiede letture documentali, polling LLM o deleghe del principale.

Qualsiasi incertezza o anomalia dichiarata blocca la pubblicazione automatica.
Con rapporto valido privo di segnalazioni l'invocazione iniziale autorizza l'apply
monouso. **La review semantica indipendente di Sol non fa parte di questo percorso.**
L'autoverifica del Curator resta obbligatoria; i controlli deterministici non
dimostrano completezza o pertinenza semantica. Il warning
CURATOR_SEMANTIC_SELF_REVIEW_ONLY rende esplicito il limite.

Gli artefatti interni conservano richiesta, ricevuta controller, eventi JSONL,
stderr e metadati worker. Un pending gia reclamato non rilancia il worker; recovery
e replay riguardano soltanto apply gia autorizzati. Dettagli, confini di isolamento
e misura futura in [CURATION-WORKFLOW.md](CURATION-WORKFLOW.md).

## Ciclo manuale: soltanto eccezioni e legacy

I passaggi seguenti descrivono la supervisione manuale esplicita, non il percorso
ordinario del controller. Restano disponibili per approfondire un blocco o gestire
batch precedenti; non vanno eseguiti in aggiunta al controller per lo stesso batch.

Nei workspace inizializzati S4, il principale suggerisce
`$knownex-checkpoint` ai milestone significativi e lo esegue solo su invocazione utente: una sola delega per batch, nessun
retry LLM automatico. `knownex runtime` mostra pending, cutoff e batch attivo.
Il feed `project.jsonl` conserva una sequenza di progetto con identita
sessione/turno; il checkpoint registra la sessione dell'ultimo evento confermato.
Il primo `init --through 0` accetta **solo** il seed vuoto esatto del bootstrap
(STATE/HISTORY, nessuna Knowledge) e usa sessione/checksum vuoti: nessun evento
e dichiarato gia rappresentato. Il seed canonico non richiede una provenienza
inventata; le successive proposte informative richiedono le fonti come prima.
La skill seleziona il cutoff dell'ultima risposta finale acquisita, lasciando
gli eventi successivi per il prossimo milestone. Dettagli in [Runtime S4](RUNTIME.md).

La CLI inizializza solo il seed canonico vuoto a cutoff zero; le copie con cutoff
positivo restano una API legacy per chiamanti fidati. Usare percorsi locali
ignorati da Git per i dati, senza riutilizzare workspace sperimentali.

```powershell
# L'utente ha invocato $knownex-checkpoint in chat.
# Solo al primo uso: curate init con il seed vuoto e --through 0.
npm exec --offline -- knownex curate prepare --work .knownex/internal/curator --autonomous
```

Il principale non legge integralmente feed, packet o Knowledge per sintetizzarli
prima della delega. Il codice congela il batch autorizzato e tutta la base corrente;
inputs.json espone un catalogo di identita, titoli e intestazioni senza corpi.
Il Curator sceglie le note pertinenti, legge direttamente il packet completo e
le note da aggiornare; le altre restano intatte. Non carica tutta la Knowledge
per precauzione. Le note necessarie non collegate da STATE sono disponibili nel
catalogo, senza selezione preliminare del principale.

Il principale genera request.txt con dist/curator-request.js e delega una sola
volta i riferimenti con hash. Skill e contratto sono letti dal Curator una volta,
non ricopiati nel messaggio. --artifacts autorizza sorgenti gia note; --directive
resta facoltativo per priorita brevi, non una sintesi del materiale. Nessun
file directive.md viene creato automaticamente. La tassonomia approvata rimane
congelata nel packet; categories assegna solo categorie esistenti alle note
nuove o cambiate. Il codice pubblica revisioni immutabili sotto
memory/knowledge/checkpoint-NNNN/[categoria]/; la proposta usa chiavi logiche.

Il Curator passa gli oggetti al modulo I/O Node del prodotto indicato nella
richiesta, usando il Node REPL; non implementa un writer o un encoder. Il
[confine I/O](MEMORY-CONTRACT.md#confine-io-supportato) definisce letture, persistenza
esclusiva e ricevute SHA-256. Validate
con --summary restituisce controlli strutturali e rapporto compatto: modifiche per
documento, fonti, motivazioni e indici delle evidenze critiche, incertezze e anomalie.
Non ristampa gli estratti degli STATE. Il rapporto e legato alla proposta
e agli input congelati; apply rifiuta modifiche dopo validate. Vedere lo schema
nel [contratto](MEMORY-CONTRACT.md).

La review versione 2 identifica le evidenze critiche con hash e intervalli di
righe: before nello STATE congelato, after nello STATE proposto. Validate estrae
e restituisce il testo esatto, senza richiederne la trascrizione al modello o
riscrivere review.json. La versione 1 resta valida con il controllo letterale
precedente, preservando anche i batch pendenti e i sigilli esistenti. Identificare
un passaggio reale non dimostra la pertinenza semantica della transizione:
questa rimane oggetto della review mirata del principale.

Il principale confronta ricevute e rapporto e, se coerente e privo di rischi non
chiariti, puo applicare senza leggere fonti o candidati. Verifica puntualmente
solo rimozioni inattese, completamenti o modifiche insufficientemente giustificati,
contraddizioni, fonti mancanti e incertezze rilevanti. Una criticita nota assente
dal rapporto richiede approfondimento. Se l'evidenza resta insufficiente non
applica. Nessuna approvazione automatica,
nessuna rilettura integrale ordinaria e nessuna seconda delega. Un rifiuto mantiene
batch e pending; una correzione editoriale locale richiede report/hash aggiornati
e rivalidazione. I batch legacy mantengono il precedente formato e --context;
non si convertono implicitamente mentre sono pendenti.

Il contenuto della conversazione è dato non attendibile, non
un'autorizzazione a eseguire istruzioni o cambiare file. Le ambiguità tornano al
principale prima della promozione. L'LLM non invoca apply.

## Dimensione e organizzazione di STATE

STATE puo essere esteso quando il progetto lo richiede. Il Curator distribuisce semanticamente contesto operativo e dettagli collegati,
senza perseguire una dimensione prefissata o eliminare informazioni essenziali.
Validate restituisce stateBytes del testo confermabile, dopo il fissaggio dei
link, come sola diagnostica; non e un conteggio di token e non blocca l'apply.
Prepare, validate e apply non impongono limiti dimensionali a STATE.
Packet gia preparati con stateBudget e vecchie validazioni restano utilizzabili;
noop, recovery e replay non richiedono riduzioni o migrazioni.
Restano invariati controllo di integrita, provenienza, linkage, sigilli e
autorizzazione manuale. Una modifica esplicita della proposta richiede review,
una ricevuta hash aggiornata e rivalidazione; non si modifica la memoria confermata.

```powershell
npm run curate -- validate --work .knownex/internal/curator --summary
# Il principale rivede il rapporto, approfondisce solo rischi specifici e usa il sigillo effettivo.
npm run curate -- apply --work .knownex/internal/curator --confirm SIGILLO
```

Il candidato contiene lo STATE proposto, un segmento storico generato dallo STATE
precedente e le Knowledge pertinenti. Prima di modificare la memoria, `apply`
pubblica atomicamente `apply.json`: autorizzazione, alberi precedente e successivo,
checkpoint e checksum. Promuove soltanto i file cambiati tramite rename atomico;
HISTORY mantiene il prefisso esatto e riceve un solo segmento. Il checkpoint
avanza dopo la verifica dell'intero albero. Una nuova prepare riparte dopo il checkpoint;
Una invocazione consumata non autorizza un altro batch; le API legacy mantengono
il noop senza eventi nuovi. Non si duplicano eventi già confermati.

## Esempi editoriali S4.1

Esempi sintetici documentali, non prove semantiche eseguite da un modello.
Gli identificativi E indicano ipotetici eventi sorgente, non evidenze reali.
Le regole sono nella [skill curator](../.agents/skills/knownex-curator/SKILL.md);
non introducono categorie, campi o filtri deterministici nel formato della memoria.

| Conversazione e provenienza ipotetica                                                                                                                                                                             | Materializzazione selettiva attesa                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E001: richiesta molto lunga di un rapporto, con molti esempi di stile; vincoli espliciti: italiano, dati locali, nessuna pubblicazione.                                                                           | STATE conserva obiettivo e tre vincoli; la lunghezza e gli esempi non giustificano note separate. Le direttive restano valide finche l'utente non le modifica.                                                                                   |
| E002–E009: commentary di avanzamento e tentativi risolti; E010: evidenza tecnica di un percorso relativo risolto dal cwd errato; E011: il finale dichiara che il problema e risolto, senza prova di riesecuzione. | Omettere cronaca e correzioni ridondanti. Integrare la causa riutilizzabile e la diagnostica pertinente nella Knowledge dell'argomento; registrare la soluzione come dichiarata e la verifica come ancora aperta, senza inventare test superati. |
| STATE precedente: scelta A e prerequisito critico P ancora aperto. E012: l'utente sostituisce esplicitamente A con B; E013 non menziona P.                                                                        | STATE rende corrente B e mantiene P aperto; A esce dalle decisioni attive. HISTORY archivia lo STATE precedente mediante il protocollo esistente e conserva la transizione, senza sovrascrivere il presente.                                     |
| Knowledge esistente `knowledge/percorsi.md`, ID stabile, fornita nel packet. E014 e poi E020 in checkpoint diversi aggiungono una causa e una verifica sullo stesso argomento, con un log autorizzato.            | Aggiornare la stessa nota completa mantenendo ID, dettaglio utile e link verificabile al log; aggiungere provenienze effettive di entrambi i momenti. Nessuna nota per checkpoint, duplicazione o tassonomia obbligatoria.                       |

In una nuova sessione STATE e l'ultima memoria confermata, non la prova che tutto
il pending sia gia rappresentato. Nel checkpoint nativo prepare congela il batch pertinente; il principale
delega i riferimenti, senza sintetizzarne il contenuto. Il Curator interpreta
novita, supersession, risultati, blocker e Knowledge pertinenti dal feed congelato. Il feed originale non viene filtrato dalla materializzazione.

## Conservazione sostanziale e linkage

STATE e la radice operativa per il cold start ordinario; i dettagli sono nelle
Knowledge autonome e raggiungibili attraverso link Markdown, anche indiretti.
La riduzione del contesto deriva dal poter scegliere quali note aprire, non
dall'eliminazione dei dettagli secondari o dalla consultazione obbligatoria del
feed. HISTORY e le revisioni immutabili mantengono il loro contratto: non sono
un sostituto delle informazioni ancora pertinenti nella memoria corrente.

Il curator distingue contenuto incidentale e sostanziale guardando significato
e conseguenze, senza filtri lessicali. Nel percorso nativo il Curator, durante l'autoverifica,
usa il rapporto strutturato per confrontare continuita critica e modifiche,
verificando i passaggi e le fonti pertinenti nel candidato. Controlla conservazione, attribuzione, qualificazioni,
negazioni e ambito delle prove; segue i collegamenti necessari e rifiuta perdite
ingiustificate o dettagli essenziali irraggiungibili. Non richiede che tutti i
fatti siano ripetuti in STATE e non crea un registro parallelo di copertura.

Questi casi sintetici definiscono aspettative editoriali preventive, non output
prodotti da un LLM o un classificatore deterministico. Le sequenze sono locali
a ciascuna riga e non modificano gli oracoli storici.

| Caso e sorgente sintetica                                                                                                                                                | Destinazione e review attese                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E001: «Riscrivi il riepilogo in parole semplici», senza nuovi fatti o direttive.                                                                                         | Nessuna conoscenza nuova; `noop` se l'intero batch e incidentale. Una spiegazione con contenuto riutilizzabile va invece preservata.                                   |
| E002: comando digitato male, corretto senza conseguenze. E003: scoperta una risoluzione dal cwd errato, applicata una modifica; il finale dichiara soltanto build verde. | Omettere la cronaca di E002; integrare causa e modifica di E003 nella nota pertinente. Build dichiarata non dimostra collaudo funzionale.                              |
| E004: il formato conserva il codice R-31 e l'accento combinante senza normalizzazione; dettaglio non necessario alla prossima attivita.                                  | Conservare entrambi nella Knowledge tecnica, con fonte e condizioni; renderli raggiungibili da STATE, senza obbligo di copiarli nella radice.                          |
| E005: «Nessun errore osservato sui file locali; rete non provata». E006: usare B anziche A solo per export locale.                                                       | Preservare negazione circoscritta, rete non verificata, autore e ambito della sostituzione. Non affermare assenza generale di errori o abbandono globale di A.         |
| STATE: obiettivo, decisione B per export locale, blocker rete, prossima verifica; link alla nota tecnica che collega una nota sui risultati.                             | Cold start operativo e dettagli autonomi raggiungibili anche indirettamente. Validare destinazioni/anchor, poi rivedere se i collegamenti necessari sono presenti.     |
| Knowledge fornita: cause, alternative e condizioni gia confermate. E007 aggiunge un test limitato.                                                                       | Integrare il test mantenendo contenuto pertinente, ID, fonti e relazioni precedenti. Non sostituire la nota con le sole novita; conservare l'ambito limitato del test. |
| Knowledge pertinente esistente non collegata da STATE.                                                                                                                   | Individuarla nel catalogo congelato e leggerla prima di modificarla; non crearne una copia. Nel modo legacy segnalare il contesto mancante.                            |

Le verifiche deterministiche usano proposte scritte a mano: controllano packet
completo nei testi selezionati, esclusione dei corpi non selezionati, deduplicazione
dei percorsi, integrita delle note, risoluzione dei link e continuita dei byte
nelle revisioni. Non dimostrano che il modello selezioni tutti i fatti o produca
tutti i link necessari: correttezza e completezza semantiche restano da valutare
in una futura esecuzione reale, senza riclassificare Test001.

## Continuita critica S4.5

Il curator confronta lo STATE precedente congelato con i nuovi eventi prima di
proporre il successivo. Ogni decisione attiva, blocker, prerequisito e attivita
critica deve restare attivo (eventualmente aggiornato) oppure avere evidenza
pertinente di completamento, una decisione sostitutiva o una cancellazione esplicita
e autorevole. Il silenzio recente non e una giustificazione. Si conserva il lavoro
effettivamente aperto in forma concisa, senza aggiungere campi, registri o ID.

Il principale controlla elementi scomparsi o indeboliti confrontando lo STATE
precedente nel packet con la proposta e, dopo validate, con lo STATE del candidato.
Usa gli eventi gia disponibili e le Knowledge pertinenti, senza rileggere archivi
interi. Rifiuta apply se resta una perdita critica ingiustificata: batch e pending
rimangono, nessuna seconda delega o retry LLM, nessun riuso della invocazione consumata.
Validate verifica struttura e integrita, non la correttezza di questa revisione.

HISTORY continua ad archiviare lo STATE precedente e la transizione, rendendo
recuperabili decisioni completate o superate. Spostare informazioni in HISTORY
o Knowledge non permette di togliere da STATE un elemento ancora necessario alla
ripresa del lavoro. Una soluzione tecnica non prova una verifica funzionale;
risultati parziali non chiudono automaticamente prerequisiti o blocker.

Le seguenti fixture sono documentali e interamente sintetiche; i riferimenti E
valgono solo dentro ciascun caso. Non sono valutazioni eseguite da un modello.
La colonna revisione indica il criterio atteso, non l'esito di un test semantico.

| Caso                           | STATE precedente                                                                                                        | Eventi nuovi (fonte sintetica)                                                                                                      | STATE successivo atteso                                                                                                 | Revisione del principale                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A — Omissione recente          | Collaudo funzionale su Windows ancora necessario prima del rilascio; ambiente di prova non disponibile, blocker aperto. | E301 tratta soltanto la documentazione; non contiene risultati del collaudo o rimozione del vincolo.                                | Mantenere collaudo, prerequisito e blocker aperti, anche se il tema recente e diverso.                                  | Rifiutare un candidato che li omette: nessun evento giustifica completamento, supersession o cancellazione.                                                                        |
| B — Completamento dimostrato   | Eseguire il collaudo funzionale concordato prima del rilascio.                                                          | E302 contiene il risultato sintetico del collaudo completo nell'ambiente richiesto, con tutte le condizioni concordate soddisfatte. | L'attivita puo uscire dalle azioni aperte; riportare concisamente il risultato pertinente e la sua fonte.               | Accettare la rimozione dell'attivita aperta per completamento supportato da E302, senza estendere il risultato ad altri test o prerequisiti. Lo STATE precedente resta in HISTORY. |
| C — Decisione sostituita       | Decisione attiva: usare il formato A per l'esportazione.                                                                | E303 e una direttiva esplicita dell'utente: usare B al posto di A per la stessa esportazione.                                       | B diventa la decisione attiva; A non resta valida per quel contesto.                                                    | Accettare la supersession supportata da E303; la transizione e lo STATE precedente conservano l'evoluzione in HISTORY.                                                             |
| D — Risultato tecnico parziale | Prima del rilascio verificare il ripristino funzionale end-to-end; esito ancora ignoto.                                 | E304 documenta soltanto la correzione tecnica del percorso e il successo della build; nessuna prova end-to-end e stata eseguita.    | Conservare il prerequisito funzionale aperto, annotando il progresso tecnico senza dichiarare il ripristino verificato. | Rifiutare la chiusura: build e fix del percorso non soddisfano la condizione di verifica end-to-end. Un dettaglio in Knowledge non sostituisce l'attivita nello STATE.             |

I controlli deterministici verificano forma, presenza e riferimenti delle fixture
e coerenza delle istruzioni con il workflow. La capacita di Sol/Terra di rilevare
perdite semantiche richiede ancora una conversazione reale; non e dimostrata qui.

## Diagnostica e limiti

La CLI stampa esito, percorsi operativi, cutoff e sigillo, mai testi del feed.
Exit code 1 per errori. `CURATOR_PENDING_EXISTS` richiede usare il batch già fissato;
`CURATOR_STAGE_CHANGED`, `CURATOR_STALE_BATCH` e `CURATOR_FEED_CHANGED` bloccano
promozioni non più valide. Dopo un arresto, prepare, validate, apply e le letture
del navigatore sul workspace completano automaticamente la promozione autorizzata
sotto lo stesso lock, senza proposta o LLM aggiuntivi. `init` applica la stessa
protezione quando copia una memoria del workspace. Il record rimane come ricevuta
per replay idempotenti fino all'applicazione successiva.

Evidenze incomplete/corrotte, checkpoint inatteso o file diversi sia dalla versione
precedente sia da quella autorizzata bloccano l'operazione: nessuna riparazione
arbitraria. Gli editor e gli scrittori esterni che ignorano il lock possono vedere
i passaggi intermedi. Il protocollo recupera crash di processo; non dimostra
durabilità fisica contro perdita di alimentazione. V2.3b aggiunge barriere di
contenuto e namespace per NTFS locale, con garanzie condizionate al modello
documentato; gli errori di flush interrompono l'operazione.
La [verifica V2.3](STORAGE-DURABILITY.md) dettaglia primitive Windows, simulazioni
e condizioni per le quali la recovery resta bloccata.

La fixture deterministica verifica la lettura UTF-8 di `proposal.json`, il parsing,
la materializzazione e la persistenza in STATE, HISTORY e due Knowledge con testo
accentato, greco, giapponese, emoji e accento combinante, senza normalizzazioni.
Il difetto Q2 della pipe ASCII PowerShell precede questa pipeline verificata.

`npm run check` verifica anche Capture e feed. La prova R1 usa una copia privata
della memoria M1.3, mantenendo gli originali per confronto e provenienza. Non è
una migrazione generalizzata né un nuovo formato del feed.
