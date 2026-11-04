# KnowNex — Contratto di memoria procedurale

## Memoria confermata

```text
memory/
├── STATE.md
├── HISTORY.md
└── knowledge/*.md
```

`STATE.md` è l'handoff autorevole: obiettivo corrente, stato del lavoro,
avanzamenti recenti, decisioni valide, attività aperte, blocchi, prossime azioni e
link selettivi. Deve consentire di riprendere il lavoro senza leggere HISTORY.
Non è un riassunto cumulativo. Un titolo Markdown non vuoto è obbligatorio;
completezza e correttezza delle affermazioni richiedono revisione del principale.

`HISTORY.md` è un unico documento cronologico senza limite dimensionale.
Ogni aggiornamento confermato aggiunge esattamente un segmento. Il codice conserva
lo STATE precedente integralmente, con il solo prefisso Markdown `> ` per riga;
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

Il principale decide quando materializzare: avanzamento significativo, cambio di
focus, handoff, compattazione se il trigger è disponibile, o invocazione esplicita.
Fornisce una direttiva contestuale obbligatoria e seleziona soltanto le Knowledge
pertinenti. Un subagente economico produce una proposta, senza monitorare il progetto.

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
quelle fornite in context; nessuna cancellazione. `state` è completo. I link si
risolvono rispetto a `runs/<id>/base/`. Nessun campo per riscrivere HISTORY.
Descrizione, argomenti e transizione sono stringhe non vuote su una sola riga.
Una proposta senza cambiamento effettivo è rifiutata: usare `{"action":"noop"}`.

`validate` genera il candidato e il segmento storico, verifica identità Knowledge,
provenienza, link, confini di scrittura e sorgente congelata, senza modificare la
memoria confermata. Il principale rivede il candidato e invoca `apply --confirm`
con il sigillo restituito. Il checkpoint avanza soltanto dopo le scritture.
Il principale resta responsabile della continuità delle informazioni ancora valide.

## Integrità e recovery

Un lock tra processi serializza ogni operazione. Checkpoint v2, hash dell'albero,
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
