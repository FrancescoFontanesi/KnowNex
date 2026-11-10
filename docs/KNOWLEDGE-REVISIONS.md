# Revisioni immutabili delle Knowledge

`kn-UUID` resta l'identità logica. La revisione è `r-<run-id>` per un aggiornamento
o `b-<run-id>` per una baseline: si riusa il run, senza nuovi contatori. L'identità
completa è `kn-UUID@REV`; SHA-256 controlla l'integrità ed è distinto dall'ID.

```text
.knownex/memory/STATE.md
.knownex/memory/HISTORY.md
.knownex/memory/knowledge/checkpoint-0004/kn-UUID--REV.md
.knownex/memory/knowledge/checkpoint-0004/experiments/kn-UUID--REV.md
.knownex/memory/taxonomy.json
.knownex/internal/curator/checkpoint.json
.knownex/internal/curator/revisions/c-SEQUENCE.json
```

Il checkpoint mantiene un riferimento per nota corrente: ID, revisione, hash e
file relativo alla radice delle Knowledge immutabili. La cartella indica il cutoff,
non un ID HISTORY o una garanzia di validita semantica. Non esiste una copia
piatta corrente: i HEAD selezionano direttamente le revisioni. Nei workspace
legacy la radice resta curator/revisions e le proiezioni correnti non sono spostate.
[Layout e compatibilita](MEMORY-LAYOUT.md).

Ogni archivio conserva il testo completo e un commento riservato `knownex-revision`
generato dal codice: identità, percorso logico, predecessore con hash, cutoff/checksum
e hash del contenuto. Il riferimento corrente o del successore autentica l'intero
file. La nota corrente nel packet e una proiezione logica con link ribasati, non un
ulteriore file confermato. Incoerenze bloccano la lettura; il Curator non genera
metadati tecnici. Note invariate non producono revisioni; il confronto normalizza
riferimenti verso le stesse versioni.
Non sono introdotti cancellazioni, rinomine o rami.

## Checkpoint e categorie facoltative

Una nuova promozione pubblica soltanto note nuove o realmente cambiate sotto
checkpoint-NNNN/, eventualmente in una sottocartella tematica. Le note invariate
mantengono il riferimento precedente. Un noop aggiunge soltanto c-SEQUENCE.json:
non crea una cartella di Knowledge vuota ne un nuovo snapshot. La baseline dei
workspace non ancora versionati conserva una sola volta le note precedenti sotto
la cartella del loro cutoff, distinguibili dal prefisso b-. Non si ricopia
l'archivio ai checkpoint successivi.

Il registro facoltativo memory/taxonomy.json e una semplice mappa JSON:

```json
{
  "architecture": "Decisioni e vincoli architetturali del progetto",
  "experiments": "Metodi, risultati e limiti delle prove"
}
```

Chiavi stabili minuscole con lettere ASCII, cifre e trattini fra componenti;
descrizioni naturali non vuote su una riga. Sono esclusi traversal e nomi
riservati Windows. Nessun elenco di note, revisioni o checkpoint, nessuna categoria
predefinita o cap numerico. Assenza del file equivale a registro vuoto; file
malformati o symlink producono CURATOR_TAXONOMY_INVALID. Prepare congela le categorie
gia approvate in run e packet; cambi successivi valgono solo per i batch futuri.

La proposta update puo aggiungere categories, una mappa dai percorsi logici delle
sole note nuove/modificate alle chiavi approvate. Il curator valuta le descrizioni;
se nessuna e pertinente omette l'associazione e la revisione resta direttamente
nella cartella del checkpoint. Il codice non classifica per parole chiave.
Categorie sconosciute, associazioni a note invariate o a noop sono rifiutate con
CURATOR_CATEGORY_INVALID (o errore di forma per noop). Non si spostano note
confermate per riclassificarle. Il workflow ordinario non crea taxonomy.json o
nuove categorie. Proposta, approvazione e gestione retroattiva appartengono alla
skill opzionale `$knownex-taxonomy`: [workflow e limiti](TAXONOMY.md).
Le associazioni separate referenziano revisioni esatte senza spostarle,
duplicarle o cambiarne contenuto, hash e provenienza.

## Lettura

```powershell
knownex memory find "termine" --memory .knownex/memory
knownex memory read kn-UUID --memory .knownex/memory
knownex memory read kn-UUID@REV --memory .knownex/memory
knownex memory read kn-UUID --at 19 --memory .knownex/memory
knownex memory read kn-UUID --at H000002 --memory .knownex/memory
```

Usare gli ID effettivi restituiti da find/read. La ricerca resta corrente, con lo
stesso ranking e limite; aggiunge `revision` e `versionReference` nei workspace v3.
Per il nuovo layout aggiunge category, se presente, e checkpoint. Find puo cercare
chiavi come experiments o il nome esatto checkpoint-0004 nei metadati derivati
dal percorso corrente, senza indice persistente o scansione delle vecchie revisioni.
La lettura logica mantiene il contenuto corrente. La lettura qualificata restituisce
il testo della revisione senza commento tecnico, il riferimento fisico, SHA-256
del file completo e il cutoff `through`.

`--at N` richiede un checkpoint realmente confermato, inclusi i noop, non un evento
intermedio. `--at H...` usa il cutoff dello STATE precedente (`from - 1`), non quello
finale della transizione. Una nota introdotta dopo quel punto risulta assente.
La risoluzione segue solo ricevute/predecessori necessari, senza ricostruire diff.
File mancanti, hash incoerenti e catene invalide causano errori, mai fallback.
La navigazione corrente non enumera l'archivio: verifica revisioni attive e nuove
pubblicazioni dell'ultima ricevuta, oltre ai controlli preesistenti del workspace.

## Link

Il codice fissa i normali link `knowledge/topic.md` alle revisioni pertinenti;
il curator non inventa REV o percorsi d'archivio. Nel layout canonico anche i link marcati knownex:current sono risolti
alla revisione pertinente durante la pubblicazione: non esiste un alias fisico
knowledge/topic.md da seguire nel filesystem. Per la navigazione corrente usare
l'ID logico con la CLI. Nei workspace legacy il marker conserva il comportamento
precedente; non si riscrivono documenti confermati.
I nuovi segmenti HISTORY congelano i riferimenti dello STATE archiviato; i segmenti
già confermati restano un prefisso esatto. Una nota invariata conserva le fonti
usate anche se altre note cambiano. Rettifiche e validità non derivano dalla cronologia.
Revisioni locali sono verificabili tramite la rispettiva catena, senza autorizzare
file arbitrari. Artifact esterni conservano i controlli precedenti: i loro byte non
vengono congelati. Link mobili a STATE/intera HISTORY non ne sono snapshot; per il
passato usare segmenti precisi e distinguere la navigazione corrente.
I link tra cartelle e categorie vengono ribasati rispetto al documento che li
contiene. Filesystem e lettori Markdown come Obsidian possono esplorare cartelle,
link e anchor senza CLI. Il navigatore non segue link automaticamente.

## Adozione, transazione e limiti

Seed e workspace v2 restano leggibili. La prima promozione autorizzata crea la
baseline della generazione precedente verificata e le eventuali nuove revisioni,
nello stesso journal. Nessuna delega o invocazione aggiuntiva. Il noop di adozione
può congelare destinazioni dei link correnti senza aggiungere HISTORY.
Prima dell'adozione: `KNOWLEDGE_REVISIONS_UNAVAILABLE`; prima del cutoff baseline:
`KNOWLEDGE_LEGACY_HISTORY`. Nessuna garanzia retroattiva sui vecchi segmenti o link.

La recovery v1 pendente viene completata prima dell'adozione. Una vecchia validazione
senza journal richiede validate sulla stessa proposta (`CURATOR_REVALIDATION_REQUIRED`),
senza nuova delega. Il checkpoint v3 impedisce scritture con i vecchi writer.
Una copia standalone piatta legacy mantiene la lettura corrente. Una copia della
sola memoria canonica resta esplorabile come Markdown, ma per risolvere gli ID
logici e i checkpoint con la CLI servono anche i metadati internal/curator coerenti. Non è un nuovo formato
generale di esportazione dei workspace.

I nuovi run dichiarano revisionLayout=1; i batch precedenti senza tale marker
mantengono il piano piatto e i sigilli esistenti. Riferimenti di revisione legacy
senza file continuano a risolvere i nomi piatti; nuovi riferimenti includono il
percorso di pubblicazione e restano protetti dagli hash. Nessun file o segmento storico
confermato viene spostato o riscritto. Vecchi lettori/writer non comprendono i
nuovi riferimenti e falliscono conservativamente: aggiornare il software prima
di usare workspace che contengono revisioni organizzate per checkpoint.

Il journal v2 contiene alberi attivi prima/dopo e sole nuove pubblicazioni, non tutto
l'archivio. Il sigillo copre proposta, piano e hash. Validate non pubblica revisioni;
gli staging non sono input di recovery. Ordine persistente: journal → archivi e
namespace → Markdown → verifica → checkpoint → pulizia. Il replay riconosce file
identici e risincronizza senza duplicare HISTORY o revisioni. Collisioni e pubblicazioni
mancanti dopo il commit bloccano, senza ricostruzioni arbitrarie.
Le directory annidate vengono create solo dopo l'intento durevole: ogni componente
e controllato contro symlink/junction, sincronizzato insieme al proprio genitore,
poi il file e pubblicato atomicamente e il suo genitore risincronizzato prima del
checkpoint. La recovery ripete questi passaggi senza duplicare le pubblicazioni.

Restano le assunzioni NTFS/flush di [Storage Durability](STORAGE-DURABILITY.md).
Crash ed EIO simulati non dimostrano durabilità fisica. L'immutabilità è del protocollo,
non una protezione ACL contro scrittori esterni. Le revisioni vecchie sono verificate
quando richieste/percorse; non esistono scansioni periodiche o garbage collection.
Prepare/validate/hash/flush conservano il costo dell'albero attivo e della HISTORY;
la validazione può consultare metadata di riferimenti storici. Non si promette O(delta):
si evita di copiare, serializzare e sincronizzare indiscriminatamente tutto l'archivio.
