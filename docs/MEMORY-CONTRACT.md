# KnowNex — Contratto di memoria procedurale

Il feed JSONL acquisito dagli hook è la fonte autorevole della materializzazione:
testi registrati, ordine, sequenze, identità disponibili e provenienza. Prepare
congela gli eventi dopo il cutoff confermato; complete verifica catena SHA-256,
binding del batch e autorizzazione senza interrogare la history Codex.
Modifiche o eliminazioni retroattive non acquisite dagli hook non vengono rilevate
automaticamente: la memoria conserva la storia effettivamente registrata.
Gli hash verificano l'integrità interna, non autenticità o completezza della
conversazione originale, né proteggono indipendentemente da un processo che può
riscrivere feed e metadati nel workspace. I campi legacy `nativeThreadId` e
`nativeHistory: true` non impongono accessi esterni; esclusioni e revisioni già
confermate restano conservate, senza ricostruzioni retroattive.

## Memoria confermata

La [manutenzione tematica opzionale](TAXONOMY.md) conserva associazioni a revisioni
esatte in metadati separati. Non modifica contenuto, percorsi o provenienza della
memoria confermata; gli indici Markdown derivati non sono una seconda memoria.

```text
memory/
├── STATE.md
├── HISTORY.md
└── knowledge/*.md
```

`STATE.md` e la radice operativa navigabile, autorevole fino al checkpoint
confermato: obiettivo, situazione corrente, decisioni attive, vincoli, prerequisiti,
attivita aperte, blocchi e prossime azioni sufficienti al cold start ordinario.
Collega con link Markdown descrittivi le Knowledge dettagliate, direttamente o
attraverso altre note. Non e un riassunto narrativo ne una trascrizione strutturata.
Il dettaglio non immediato rimane raggiungibile senza duplicarlo tutto in STATE.
La completezza riguarda l'insieme materializzato e navigabile, non il solo STATE;
il feed originale non sostituisce la conservazione nelle Knowledge.
Un titolo Markdown non vuoto e obbligatorio;
completezza e correttezza delle affermazioni richiedono revisione del principale.

STATE non ha un limite dimensionale imposto da KnowNex: la sua estensione dipende
dal contesto operativo necessario. La decomposizione nelle Knowledge risponde a
coesione semantica e navigabilita, non a una soglia di byte o token. Non eliminare
elementi essenziali per rendere STATE piu piccolo.

Validate espone stateBytes del testo finale come diagnostica UTF-8 non bloccante,
dopo ribasamento e fissaggio dei link. Prepare non impone un budget e apply non
rifiuta una proposta per la sola dimensione. Eventuali stateBudget nei packet e
contatori dimensionali delle vecchie validazioni non cambiano il protocollo o i
sigilli: i batch esistenti rimangono utilizzabili. Noop, recovery e replay
conservano integralmente la generazione autorizzata, anche negli archivi legacy.

SessionStart tenta sempre di emettere STATE completo in additionalContext,
all'avvio e dopo compact, senza troncamenti o rappresentazioni alternative.
KnowNex verifica il payload prodotto, non la consegna effettiva al modello:
esecuzione, gestione dell'output e finestra di contesto dipendono dall'harness.
Il [contratto runtime](RUNTIME.md) distingue questi confini e i limiti documentati.

`HISTORY.md` è un unico documento cronologico senza limite dimensionale.
Ogni aggiornamento confermato aggiunge esattamente un segmento. Il codice conserva
lo STATE precedente con prefisso Markdown `> ` per riga e destinazioni Knowledge
fissate alle revisioni confermate quando il workspace adotta il versionamento;
la descrizione della transizione fornisce il contesto storico. Il testo già
confermato rimane un prefisso identico byte per byte e viene promosso per append.
Non si riassume né riscrive globalmente HISTORY. Gli archivi precedenti al
prototipo procedurale possono essere citati come artefatti originali.

```markdown
<!-- knownex-history:H000001:begin -->

## H000001

- Data: `2026-11-03T12:00:00.000Z`
- Eventi: `E015..E016`
- Fonte: [E015–E016](../../feed/session.jsonl)
- Argomenti: contratto; curatela
- Descrizione: adozione del contratto
- Transizione: stato aggiornato; motivazioni nella [nota](knowledge/contratto.md).

### STATE precedente

> # Stato precedente
>
> Contesto completo dello STATE precedente.

<!-- knownex-history:H000001:end -->
```

Gli ID `H000001`, `H000002`, … sono progressivi; i delimitatori sono riservati.
La data deriva dall'acquisizione dell'ultimo evento incluso, non pretende di
datare più precisamente la decisione. L'intervallo indica il batch materializzato.
Una conferma esplicita `noop` può avanzare il checkpoint senza sostituire STATE e
senza aggiungere storia. Senza eventi nuovi, prepare non modifica la memoria.

Le Knowledge nascono soltanto per argomenti che giustificano consultazione
indipendente; non per turno o milestone. Modificare prima le note pertinenti.
Sono documenti tematici autonomamente comprensibili, dettagliati e collegati:
conservano fatti, risultati, dettagli tecnici, decisioni e motivazioni, alternative,
condizioni, eccezioni, incertezze, relazioni e questioni aperte, anche secondarie.
Attribuzione, provenienza, negazioni circoscritte e grado di certezza devono
mantenere significato. Non inferire identita, completamenti o garanzie non supportati.
Aggiornare integra il contenuto precedente ancora pertinente; non sostituirlo
con le sole novita o una sintesi. Una revisione immutabile conserva il passato,
ma non giustifica l'impoverimento della nota corrente. Spiegare correzioni e
sostituzioni supportate, evitando duplicazioni e frammentazioni artificiali.
Ogni nota usa questo frontmatter ristretto, non YAML generale:

```markdown
---
id: kn-00000000-0000-4000-8000-000000000001
type: knowledge
---
```

Gli ID reali sono UUID v4 minuscoli con prefisso `kn-`, univoci e immutabili.
I percorsi confermati si mantengono: questo ciclo non espone cancellazione,
rinomina o famiglie di alias. I tre ID M1.3 della copia di prova sono conservati.
Non esistono altri documenti obbligatori o un indice separato di provenienza.

Il [contratto delle revisioni](KNOWLEDGE-REVISIONS.md) aggiunge un archivio immutabile
esterno all'albero attivo. Le note correnti rimangono complete; il checkpoint v3
mantiene i riferimenti correnti. L'adozione dei workspace v2 avviene soltanto
alla successiva promozione autorizzata, senza garanzie retroattive sul vecchio storico.

## Finestra pendente e provenienza

Il feed S2.1 è l'unica sorgente autorevole dei messaggi. La finestra contiene le
sequenze successive al checkpoint. `prepare` legge il feed verificato e congela
il suo limite superiore, esplicito `--through` o ultimo evento completo presente.
Nuovi eventi successivi restano pendenti. `WINDOW.md` e `packet.json` nello staging
sono copie derivate rigenerabili, non archivi alternativi; non si modificano per
correggere il feed. Il pacchetto include sessione, turni, sequenze, checksum e byte
di origine. Non contiene il corpo della vecchia HISTORY.

La provenienza esplicita usa link al feed fissato dal workspace, per esempio
`[E017](../../feed/session.jsonl)`, oppure il campo `- Eventi` nei segmenti HISTORY.
Titoli, argomenti e prosa ordinaria (anche `Catalogo E1` o `E999`) non dichiarano
provenienza e non vengono interpretati come eventi.

Nelle etichette dei link al feed ogni riferimento usa `E` seguito dal numero con
almeno tre cifre, senza zeri aggiuntivi: `E001`, `E017`, `E1000`. Sono ammesse
etichette descrittive come `ripetizione E009`; tutti gli ID presenti nell'etichetta
devono essere validi. Gli intervalli nei link usano `E015–E016`, `E015..E016` o
`E015-E016`, con estremi ordinati e inclusivi. Intervalli incompleti o concatenati
sono rifiutati. Il campo HISTORY conserva la sintassi `E015..E016` già definita.
Un'etichetta composta soltanto da un ID canonico o un intervallo non può puntare
a un altro documento fingendo di essere provenienza. Gli altri link restano
normali collegamenti Markdown soggetti ai controlli di percorso e autorizzazione.

Per i riferimenti riconosciuti, la sequenza è
scoped al feed fissato dal workspace (di sessione o di progetto). Non sono anchor JSONL. Le sequenze
citate devono esistere ed essere entro il cutoff congelato. STATE e ogni Knowledge
devono avere almeno un riferimento al feed. Unica eccezione: il seed vuoto
canonico del bootstrap, senza fatti materializzati; init a sequenza zero non
conferma eventi. Distinguere decisione confermata,
proposta, risultato dichiarato e risultato verificato; un report dell'assistente
non prova da solo l'esecuzione di un esperimento. Allegati non presenti nel feed
non possono essere ricostruiti. Nessuna inferenza semantica di identità.

Link Markdown relativi inline, senza immagini o link di riferimento; codificare
gli spazi con `%20`. Link interni e anchor devono esistere. Artefatti originali,
inclusi CSV, log e report, devono esistere ed essere già referenziati dalla memoria
o autorizzati esplicitamente dal principale con `--artifacts`. Il codice ribasa i
link esterni tra staging e memoria confermata. Non copiare conversazioni nei log.

## Materializzazione

La selezione riguarda il contenuto informativo, non il tipo di messaggio.
Spiegazioni generiche, richieste di riassunto, amministrazione e troubleshooting
transitorio senza conseguenze possono non lasciare conoscenza. Spiegazioni
riutilizzabili, modifiche, cause diagnostiche, vincoli o decisioni durevoli vanno
invece conservati, anche in messaggi misti. Nessun filtro per parole chiave.
Il risparmio di contesto deriva dalla consultazione selettiva, non dalla perdita
di informazioni sostanziali o dal rinvio sistematico al feed.

Il principale decide quando materializzare: avanzamento significativo, cambio di
focus, handoff, compattazione se il trigger è disponibile, o invocazione esplicita.
Il principale coordina una sola delega economica senza analizzare o sintetizzare
integralmente le sorgenti prima della delega. Puo aggiungere brevi priorita.

Nel flusso --autonomous, prepare congela il batch e la base corrente; inputs.json
fornisce percorsi, hash, identita, titoli e intestazioni delle Knowledge. Il packet
contiene STATE e gli eventi autorizzati, non i corpi delle note. Il Curator legge
autonomamente tutto il batch e sceglie il contesto storico e tematico necessario;
legge integralmente le note prima di aggiornarle, conservandone il contenuto valido.
Non pre-carica tutte le Knowledge. Sorgenti essenziali mancanti richiedono arresto,
non duplicazione o ampliamento implicito del batch. Nessuna seconda delega.

I batch legacy senza manifest restano compatibili: --context seleziona note
esplicite; non si cambia modalita in un batch pendente. Il nuovo workflow non
richiede questa selezione al principale.

Il pacchetto, la skill e questo contratto sono gli input autorizzati. La proposta
è un JSON UTF-8 senza recinti Markdown:

```json
{
  "action": "update",
  "state": "# Stato\n\nContesto aggiornato e fonti...\n",
  "history": {
    "summary": "Descrizione breve ricercabile",
    "topics": ["argomento"],
    "transition": "Cosa cambia e perché; eventuali link Knowledge."
  },
  "knowledge": {}
}
```

`knowledge` contiene esclusivamente testi completi di note modificate o nuove,
con chiavi `knowledge/<nome-minuscolo>.md`. Le note esistenti devono essere fra
quelle congelate in base nel modo autonomo, o fornite in context nel modo legacy; nessuna cancellazione. `state` è completo. I link si
risolvono rispetto a `runs/<id>/base/`. Nessun campo per riscrivere HISTORY.
Descrizione, argomenti e transizione sono stringhe non vuote su una sola riga.
Il campo facoltativo categories di update associa soltanto note nuove/modificate
a chiavi del registro taxonomy congelato nel packet. Omissione significa nessuna
categoria. I percorsi knowledge/tema.md sono chiavi logiche del packet/proposal. Le revisioni
confermate nuove o modificate usano memory/knowledge/checkpoint-NNNN/[categoria]/,
senza una seconda copia piatta corrente; i workspace legacy restano invariati. Dettagli, compatibilita e formato
del registro sono nel [contratto delle revisioni](KNOWLEDGE-REVISIONS.md).
Una proposta senza cambiamento effettivo è rifiutata: usare `{"action":"noop"}`.

`validate` genera il candidato e il segmento storico, verifica identità Knowledge,
provenienza, link, confini di scrittura e sorgente congelata, senza modificare la
memoria confermata. Nel percorso ordinario Sol esegue prepare, delega a Terra la sola curatela del batch congelato e completa `curate native --stage complete` con le ricevute del Curator. La primitiva verifica le ricevute,
valida e invoca apply con il sigillo sotto l'autorizzazione iniziale monouso.
Qualsiasi voce in uncertainties o anomalies blocca l'apply automatico. Il checkpoint
avanza soltanto dopo le scritture. Il confronto storico, la continuita critica e
la verifica preliminare della copertura spettano al Curator; non esiste review
semantica indipendente di Sol nel controller. Questo compromesso e segnalato dal
warning CURATOR_SEMANTIC_SELF_REVIEW_ONLY: la validazione non prova completezza
o pertinenza semantica. La review mirata e apply --confirm del principale restano
un percorso manuale esplicito per eccezioni e legacy, non un passo ordinario.
La delega nativa trasmette solo workspace, operazione e riferimento all'invocazione
acquisita. La preparazione risolve tale riferimento sotto l'autorita del feed;
sequenza/checksum sono congelati nel run e nella ricevuta controller nativa.
Complete richiede il medesimo run e gli hash delle ricevute, senza nuove autorizzazioni.
Il risultato finale e una proiezione SUCCESS/BLOCKED/ERROR senza documenti.
Il launcher esterno resta disponibile ma non e il percorso predefinito.

### Confine I/O supportato

Il Curator produce oggetti nel Node REPL e importa il modulo JavaScript io.module
fornito dalla richiesta. readCurationInput(run, nome) legge UTF-8 strettamente,
conserva BOM e terminatori e verifica gli hash del manifest; gli artefatti esterni
testuali restano limitati a quelli esplicitamente autorizzati. stateEvidence
costruisce i riferimenti v2. writeCurationArtifacts(run, proposal, review) serializza
JSON con ordine delle proprieta invariato, indentazione 2 e LF finale; inserisce
proposalSha256 dai byte reali e restituisce ricevute SHA-256 e dimensioni. Il modello
non implementa encoding, persistenza o hashing. Non sono supportati writer shell,
redirezioni, encoder globali nel tool exec o trascrizioni del principale.

I file vengono prima scritti in temporanei esclusivi, sincronizzati e riletti per
confrontare i byte; un link atomico pubblica senza overwrite su filesystem che lo
supportano. La review precede la proposta: un crash precedente al commit della
proposta non rende validabile una coppia incompleta. Errori di scrittura interrompono
l'operazione; temporanei orfani non sono artefatti validi. Il writer pubblica solo
artefatti esclusivi del run pending; validate/apply mantengono il lock esistente.
Questa operazione non consuma autorizzazioni
e non modifica la memoria confermata. Se Node REPL, build JavaScript o primitive
filesystem richieste non sono disponibili, fermarsi senza fallback.

Il core usa lo stesso nucleo Node artifact-io per letture UTF-8 e scritture della
memoria; le letture JSONL e gli hash incrementali conservano i byte originali.
La CLI trasporta i valori con JSON ASCII-safe, separatamente dalla serializzazione
degli artefatti: gli escape non cambiano i valori dopo parsing, gli hash o i file.
Nessuna normalizzazione Unicode, conversione di newline o riscrittura retroattiva.
I file legacy e review v1/v2 continuano a essere validati senza imporre ricevute
o marcatori I/O nuovi; la compatibilita non autorizza writer alternativi nei nuovi
run. Le istruzioni operative sono nella skill Curator, senza cambiare il suo compito
semantico o quello del principale.

### Rapporto del Curator autonomo

review.json e un artefatto del run, non una seconda memoria o un registro di task:

```json
{
  "version": 2,
  "proposalSha256": "SHA-256 dei byte di proposal.json",
  "summary": "Modifiche e motivazione, oppure motivazione del noop",
  "sources": [25],
  "changes": [
    { "path": "STATE.md", "summary": "Modifica operativa", "sources": [25] }
  ],
  "critical": [
    {
      "before": {
        "sha256": "hash dello STATE congelato",
        "startLine": 7,
        "endLine": 7
      },
      "after": {
        "sha256": "hash del testo proposal.state",
        "startLine": 9,
        "endLine": 9
      },
      "reason": "destinazione giustificata",
      "sources": [25]
    }
  ],
  "uncertainties": [],
  "anomalies": []
}
```

changes contiene esattamente STATE e le note proposte; noop richiede changes vuoto.
critical descrive conservazioni, aggiornamenti e rimozioni giustificate. Nella
versione 2 before/after accettano un riferimento con i soli campi sha256, startLine
ed endLine: hash SHA-256 UTF-8 del testo e intervallo inclusivo di righe da 1,
delimitate da LF. before seleziona esclusivamente base/STATE.md congelato, il cui
hash e presente in inputs.json; after seleziona proposal.state, oppure lo STATE
congelato su noop. L'hash dello STATE proposto non e proposalSha256. Il codice
verifica hash e intervallo ed estrae il testo originale senza normalizzare Unicode,
maiuscole, apostrofi o terminatori. Il rapporto restituito da validate espande i
riferimenti in stringhe before/after; review.json originale non viene riscritto e
il sigillo continua a vincolarne i byte originali. Nessun testo alternativo o
percorso arbitrario puo essere associato al riferimento.

La CLI con --summary omette soltanto gli estratti prima/dopo dall'output: ogni voce
critical conserva index nel rapporto originale (da zero), reason, sources e
textChange, che indica esclusivamente differenza testuale. Modifiche, motivazioni,
incertezze e anomalie non vengono troncate. checks segnala i controlli deterministici
superati; il principale puo esaminare il rapporto nel percorso manuale eccezionale. La proiezione
non cambia review.json, ricevute, verifiche, candidato o sigillo; la forma
dettagliata resta disponibile senza --summary e non e una seconda review obbligatoria.

La versione 2 ammette anche estratti letterali che occorrono una sola volta;
occorrenze ripetute richiedono righe esplicite. Una stringa vuota indica solo il
lato assente di un'aggiunta/rimozione motivata; entrambi vuoti sono rifiutati.
La versione 1 resta accettata con i controlli letterali precedenti, anche per
proposte pendenti o gia validate: nessuna conversione automatica o riscrittura
di ricevute. I riferimenti strutturati richiedono versione 2. sources contiene
sequenze positive fino al cutoff, escluse quelle amministrative filtrate; puo
citare fonti precedenti pertinenti, non eventi futuri. Nessun ID obbligatorio di task.
Validate verifica forma, corrispondenza dei documenti, citazioni e hash degli input.
Il sigillo lega anche l'hash del rapporto; apply ricontrolla gli input e rifiuta
alterazioni. Le autorizzazioni e il journal di recovery restano invariati;
una recovery gia autorizzata non richiede rapporto, revisione o delega nuovi.
Questi controlli non provano lettura effettiva, completezza semantica o veridicita
del rapporto. La review selettiva puo rilevare difetti, non garantire assenza di
omissioni non segnalate: serve una futura valutazione reale indipendente.

## Integrità e recovery

Un lock tra processi serializza ogni operazione. Checkpoint v2 legacy/v3 versionato, hash dell'albero,
catena del feed, run congelato e sigillo impediscono l'applicazione di proposte
obsolete o alterate nei casi supportati. I workspace sperimentali v1 sono rifiutati;
nessuna migrazione automatica. Una copia canonica si inizializza con cutoff revisionato.

Prima di toccare i file confermati, `apply` pubblica atomicamente `apply.json`, con
sigillo autorizzato, alberi precedente e successivo, checkpoint e checksum del
record. Ogni file cambiato viene sostituito con rename atomico da un temporaneo
esterno a `memory/`; HISTORY conserva il prefisso esatto. Il checkpoint avanza
soltanto dopo la verifica dell'intero albero, poi viene rimosso il pending.

Le operazioni del curator e le letture del navigatore su `work/memory/` condividono
il lock e recuperano la promozione prima di usare la memoria. Con checkpoint
precedente, ciascun file deve coincidere con la versione precedente o successiva;
si completano soltanto le sostituzioni mancanti. Con checkpoint successivo,
l'albero deve già corrispondere interamente. La pulizia è ripetibile; il record
rimane come ricevuta per il replay fino al prossimo apply. Non servono nuova
proposta o invocazioni LLM. Non viene mai riaggiunto un suffisso HISTORY durante
la recovery. Un'interruzione prima della pubblicazione lascia lo stato precedente.

Record incompleto/corrotto, file inattesi o checkpoint incompatibile fermano
l'operazione senza riparazioni arbitrarie. Le promozioni interrotte antecedenti a
questo protocollo, prive di record, restano bloccate dalla verifica hash.
V2.3b sincronizza contenuti e namespace del journal prima dei Markdown, poi
l'intero albero prima del checkpoint; conserva il journal dopo la pulizia pending.
La recovery può ricostruire nomi Markdown e checkpoint mancanti dal record integro.
Le garanzie includono crash di processo e il modello condizionale NTFS descritto
in [Storage Durability](STORAGE-DURABILITY.md); la durabilità fisica dopo power loss
rimane non dimostrata. Sono esclusi scrittori e lettori esterni che ignorano il lock.
Resta la politica conservativa del lock:
PID riutilizzato o gate di recupero abbandonato possono richiedere ispezione.
La verifica legge integralmente feed e memoria; HISTORY non è inviata al modello.
