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
├── history/H000001.md
└── knowledge/checkpoint-NNNN/[categoria/]<nome>--kn-UUID--REV.md
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

`HISTORY.md` è l'indice cronologico dei checkpoint: una riga per aggiornamento
confermato, così aprirlo costa poco anche dopo centinaia di checkpoint. Il
dettaglio di ogni checkpoint è una finestra immutabile `history/H000001.md`, che
si apre da sola: metadati, revisioni scritte da quel checkpoint e STATE prodotto,
con i link spostati di un livello (`../`). Il testo già confermato di HISTORY
rimane un prefisso identico byte per byte e una finestra non cambia più; un
indice e le sue finestre corrispondono uno a uno, senza orfane né mancanti.

```markdown
- [H000003](history/H000003.md) · `2026-11-03T12:00:00.000Z` · `E015..E016` · contratto; curatela — adozione del contratto
```

```markdown
# H000003 — contratto; curatela

- Data: `2026-11-03T12:00:00.000Z`
- Eventi: `E015..E016`
- Argomenti: contratto; curatela
- Descrizione: adozione del contratto
- Transizione: stato aggiornato; motivazioni nella [nota](../knowledge/contratto.md).

## Note scritte

- [knowledge/contratto.md](../knowledge/checkpoint-0016/contratto--kn-UUID--REV.md)

## STATE risultante

# Progetto

…
```

I segmenti scritti prima delle finestre restano in testa a HISTORY.md, tra
delimitatori `<!-- knownex-history:H000001:begin -->` e `:end`, con lo STATE
precedente citato riga per riga; la numerazione prosegue nelle righe d'indice.
Le finestre non sono input della curatela e non vengono copiate nei run.

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
di origine. Non contiene il corpo della vecchia HISTORY. `WINDOW.md`, verificato
dal manifest, e la copia di lettura del Curator: eventi con sequenza, tipo e testo
integrale, sessione e turno al loro cambio, e un'intestazione con artefatti
citabili, categorie approvate, direttiva e avvisi d'ordine.

La provenienza esplicita è un'etichetta tra parentesi quadre senza link, per
esempio `[E017]` o `[E015–E016]`, oppure il campo `- Eventi` nei segmenti HISTORY.
Il feed sta fuori dalla cartella memory: un link verso di esso sarebbe rotto in
Obsidian e per un agente aprirebbe un JSONL intero, mentre l'etichetta basta a
leggere l'evento per sequenza. `curate write` riduce a etichetta i link al feed
copiati da note precedenti; i link al feed già pubblicati restano validi e vengono
controllati come prima. Titoli, argomenti e prosa ordinaria non tra parentesi
quadre (anche `Catalogo E1` o `E999`) non dichiarano provenienza.

Ogni riferimento usa `E` seguito dal numero con almeno tre cifre, senza zeri
aggiuntivi: `E001`, `E017`, `E1000`. Un testo tra parentesi quadre che inizia come
un'etichetta (`[E1]`, `[E002–E001]`) è trattato come etichetta e quindi rifiutato
se malformato. Nei link al feed sono ammesse etichette descrittive come
`ripetizione E009`; tutti gli ID presenti devono essere validi. Gli intervalli usano
`E015–E016`, `E015..E016` o `E015-E016`, con estremi ordinati e inclusivi; quelli
incompleti o concatenati sono rifiutati. Il campo HISTORY conserva la sintassi
`E015..E016`. Un'etichetta linkata a un documento diverso dal feed è rifiutata.
Codice e artefatti si citano come percorsi dalla radice del workspace in backtick;
eventuali link verso file esterni restano limitati agli artefatti autorizzati.

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

Il pacchetto, WINDOW.md, la skill e la base congelata sono gli input autorizzati;
questo contratto non viene piu congelato nei run (i run preparati prima lo includono
ancora e restano validi). La proposta pubblicata
è un JSON UTF-8 senza recinti Markdown; `curate write` la assembla dalla bozza, in
cui il Curator scrive STATE e note come file separati:

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
memoria confermata. Nel percorso ordinario Sol esegue prepare, delega a Terra la sola curatela del batch congelato e completa `curate native --stage complete --run RUN` dopo la consegna del Curator. La primitiva legge proposta e review dal run,
valida e invoca apply con il sigillo del batch congelato. Il trigger e il comando
prepare esplicito, non un messaggio o un permesso ricavato dal feed.
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
Complete richiede solo il medesimo run, senza nuove autorizzazioni. Prima della consegna
di proposta e review restituisce CURATOR_WORKER_OUTPUT_INCOMPLETE e lascia il run
prepared; con write in corso restituisce DESTINATION_BUSY, anch'esso ripetibile.
Dopo che complete ha preso in carico la consegna, ogni errore e definitivo per il run.
Il risultato finale e una proiezione SUCCESS/BLOCKED/ERROR senza documenti.

### Confine I/O supportato

Il Curator usa curate read e write tramite CLI. Questi comandi richiamano
readCurationInput e writeCurationDraft/writeCurationArtifacts, disponibili
anche come API programmatica opzionale. Le letture verificano UTF-8 e manifest;
il writer serializza JSON con indentazione 2 e LF finale, inserisce/verifica
proposalSha256 e restituisce hash e byte effettivi. Unicode, BOM e terminatori
dei valori restano integri. Il modello non implementa persistenza o hashing.

Non sono supportati writer alternativi verso gli artefatti canonici o
trascrizioni del principale. File di bozza e stdin sono input della CLI, non
writer distinti. I file vengono prima scritti in temporanei esclusivi, sincronizzati e riletti per
confrontare i byte; un link atomico pubblica senza overwrite su filesystem che lo
supportano. La review precede la proposta: un crash precedente al commit della
proposta non rende validabile una coppia incompleta. Errori di scrittura interrompono
l'operazione; temporanei orfani non sono artefatti validi. Il writer pubblica solo
artefatti esclusivi del run pending; validate/apply mantengono il lock esistente.
Questa operazione non consuma autorizzazioni
e non modifica la memoria confermata. Se la CLI, build JavaScript o primitive
filesystem richieste non sono disponibili, fermarsi senza fallback.

Il core usa lo stesso nucleo Node artifact-io per letture UTF-8 e scritture della
memoria; le letture JSONL e gli hash incrementali conservano i byte originali.
La CLI trasporta i valori con JSON ASCII-safe, separatamente dalla serializzazione
degli artefatti: gli escape non cambiano i valori dopo parsing, gli hash o i file.
Nessuna normalizzazione Unicode, conversione di newline o riscrittura retroattiva.
I file legacy e le review v1/v2 restano accettati senza imporre ricevute
o marcatori I/O nuovi; la compatibilita non autorizza writer alternativi nei nuovi
run. Le istruzioni operative sono nella skill Curator, senza cambiare il suo compito
semantico o quello del principale.

### Rapporto del Curator autonomo

review.json e un artefatto del run, non una seconda memoria o un registro di task:

```json
{
  "version": 3,
  "proposalSha256": "SHA-256 dei byte di proposal.json",
  "summary": "Modifiche e motivazione, oppure motivazione del noop",
  "sources": [25],
  "changes": [
    {
      "path": "STATE.md",
      "summary": "Modifica operativa, voci chiuse o rimosse",
      "sources": [25]
    }
  ],
  "uncertainties": [],
  "anomalies": []
}
```

changes contiene esattamente STATE e le note proposte; noop richiede changes vuoto.
La voce di STATE dichiara anche decisioni, blocker o prerequisiti chiusi o rimossi.
sources contiene sequenze positive fino al cutoff, escluse quelle amministrative
filtrate; puo citare fonti precedenti pertinenti, non eventi futuri.

La versione 3 non ha piu la mappa `critical` riga per riga: la sceglieva il modello
stesso, quindi un'omissione restava invisibile, e una voce persa resta comunque
recuperabile da HISTORY e dalle revisioni immutabili. Le review v1/v2 gia scritte,
per esempio di un batch BLOCKED in attesa di apply esplicito, restano accettate:
`critical` deve essere una lista ma il suo contenuto non viene piu verificato.
Il writer canonico produce solo la versione 3.

Validate verifica forma, corrispondenza dei documenti, citazioni e hash degli input.
Il sigillo lega anche l'hash del rapporto; apply ricontrolla gli input e rifiuta
alterazioni. Una recovery gia autorizzata non richiede rapporto, revisione o
delega nuovi. Questi controlli non provano lettura effettiva, completezza
semantica o veridicita del rapporto.

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

## Interfaccia CLI portabile della Curatela

La CLI riusa curation-io e lo stesso completamento del runtime; il modulo resta
un accesso programmatico opzionale. Serve Node per KnowNex, non Node REPL o Codex.
<CLI> indica la CLI installata o node seguito dall'entry point assoluto io.cli.
Per la curatela con review usare curate prepare --autonomous --work DIRECTORY:
la preparazione non esegue inferenze. RUN sotto e il percorso della directory.

### Lettura verificata

    <CLI> curate read --run RUN --input packet.json
    <CLI> curate read --run RUN --input base/STATE.md
    <CLI> curate read --run RUN --input packet.json --offset BYTE --limit N --sha256 HASH

Il JSON contiene path, bytes, sha256, text, runId, input, offset, nextOffset e
complete. bytes e sha256 descrivono l'intero documento UTF-8. Senza intervallo
il testo e completo, senza limiti nascosti. Gli offset sono byte: iniziale incluso,
finale escluso. nextOffset dichiara il prossimo byte; complete=true indica la fine.
Il limite puo essere ridotto per non spezzare un carattere UTF-8. Offset non validi
o limiti troppo piccoli per un carattere falliscono, senza saltare dati.

Un offset non iniziale richiede sha256 dell'intero documento gia acquisito.
Ogni pagina ricontrolla autorizzazione e hash, senza caching. Riunire i campi text
decodificati e verificare byte e SHA-256 finali. Il JSON ASCII-safe preserva Unicode,
BOM e CRLF nel testo. Se il tool tronca il JSON, non e una lettura completa:
recuperare intervalli verificabili. Restano i vincoli sugli input autorizzati
e sul contesto Knowledge. Il feed live e solo provenienza, non un input.

### Evidenze e consegna

    <run>/draft/proposal.json      action, history, categories (senza state/knowledge)
    <run>/draft/STATE.md           testo completo del nuovo STATE (solo update)
    <run>/draft/knowledge/<n>.md   note nuove o aggiornate (solo update)
    <run>/draft/review.json        review (versione 3)
    <CLI> curate write --run RUN

Il Curator scrive file semplici con il proprio strumento di scrittura file: nessun
JSON che contenga Markdown, nessun serializzatore o pipe. write legge la bozza come
UTF-8 stretto (BOM iniziale ignorata), assembla proposal con state e knowledge dai
file Markdown, aggiunge l'identita alle note senza frontmatter, riduce a etichetta
i link al feed e lega la review alla proposta con proposalSha256. Bozza assente,
JSON invalido o UTF-8 invalido non danno ricevute.

Prima di persistere, write applica ai byte canonici gli stessi controlli di validate
(schema, review, identita Knowledge, provenienza, link), senza candidato
ne validated.json. Un errore non persiste nulla e torna al Curator, che corregge la
bozza e riesegue write. Finche il controller del run e prepared (o assente) una
scrittura riuscita sostituisce la precedente, rimuovendo prima la proposta; dopo
l'avvio di complete write e rifiutato con CURATOR_CHECKPOINT_RETRY_FORBIDDEN.
Il Curator puo lavorare in parallelo al principale: write e il passaggio di complete
a finishing prendono lo stesso lock `<run>/delivery.lock`, quindi complete congela
una consegna intera oppure si ferma con DESTINATION_BUSY senza consumare il run.

Il writer canonico inserisce/verifica proposalSha256, sincronizza e pubblica
review e proposta, con proposta come commit point. Restituisce esattamente
{proposal: ricevuta, review: ricevuta}; ogni ricevuta ha path, bytes e sha256 dei
byte canonici persistiti e segnala al chiamante l'esito della consegna. Non pubblica
la memoria. writeCurationArtifacts, usato direttamente come API, resta esclusivo e
non valida.

### Completamento indipendente

    <CLI> curate complete --run RUN

Complete legge proposta e review dal run e verifica run attivo, manifest, review e sigillo, riusando
validate/apply e recovery esistenti. Non richiede un controller nativo preesistente,
identita del Curator, provider, leader o sessione LLM. Gli append oltre il cutoff
restano esclusi. Recovery/replay del journal sigillato non rilanciano agenti.
I risultati compatti sono SUCCESS, BLOCKED o ERROR; solo SUCCESS conferma.
Pubblicazione e rebasing dei link restano a carico del Core.

Errori CLI: exit code non zero e JSON status=error/code su stderr. Gli esiti
negativi di complete hanno exit code non zero e risultato compatto su stdout.
Codici pertinenti: CURATOR_IO_INPUT_NOT_AUTHORIZED, CURATOR_INPUTS_CHANGED,
CURATOR_IO_RANGE_INVALID, CURATOR_IO_PAYLOAD_INVALID, CURATOR_IO_UNSAFE_RUN e
KNOWNEX_UTF8_INVALID. Nessun errore attiva fallback o inferenze.
