# Memoria pubblica e infrastruttura interna

Il layout canonico delle nuove installazioni separa il prodotto consultabile dai
meccanismi che lo generano. La rc.11 distribuisce questo layout nelle nuove installazioni; i workspace
legacy mantengono la loro disposizione senza migrazione automatica.

```text
.knownex/
  README.md
  memory/
    STATE.md
    HISTORY.md
    knowledge/
      checkpoint-0004/
        [categoria/]
          kn-UUID--REV.md
      checkpoint-0009/
        kn-UUID--REV.md
    taxonomy.json                 # facoltativo
    taxonomy-associations.json    # facoltativo
    topics/                       # viste tematiche ricostruibili
  internal/
    install.json
    docs/
    feed/
    captures/
    curator/
      checkpoint.json
      apply.json
      revisions/c-N.json          # ricevute, non copie delle Knowledge
      runs/
      taxonomy-runs/
      taxonomy-changes/
```

## Esplorazione

Aprire `.knownex/README.md`, quindi `memory/STATE.md`. STATE collega le revisioni
pertinenti con etichette descrittive. Non è necessario conoscere il Curator o usare
la CLI. La directory `memory/` può essere aperta come vault Markdown/Obsidian:
STATE, HISTORY e Knowledge hanno collegamenti relativi reali, senza note piatte
intermedie o symlink. L'interfaccia grafica di Obsidian non è verificata dai test.
I riferimenti a feed e artifact esterni alla vault richiedono un lettore che
consenta accesso fuori dalla sua radice; non vengono duplicati dentro la memoria.

Una cartella checkpoint contiene soltanto le Knowledge pubblicate in quella
promozione. Una nota invariata resta dove si trova; STATE può quindi collegare
più checkpoint. HISTORY conserva gli STATE precedenti e i relativi link
immutabili. Il nome della cartella indica il cutoff, non un ID HISTORY o la
validità semantica di una decisione. Un noop avanza la ricevuta senza duplicare
note, STATE o cartelle Knowledge.

Gli ID logici, il formato delle revisioni e i loro hash non cambiano. I nomi
`knowledge/tema.md` restano chiavi logiche nel packet/proposal e alias CLI;
non rappresentano una seconda copia fisica. Il navigatore risolve i HEAD già
registrati nel checkpoint e cerca soltanto le note correnti. Restano disponibili
ID, ID@REV, `--at`, percorsi fisici, sezioni e lookup HISTORY. Nessun indice nuovo.

## STATE, seed e staging

Il bootstrap scrive direttamente lo STATE iniziale vuoto in `memory/STATE.md`.
Prima del primo checkpoint, questo è un template senza eventi confermati:
SessionStart lo indica come cutoff E0. Non viene creata `seed/` e non esiste un
secondo STATE attivo. L'inizializzazione del Curator a E0 usa lo stesso file.

Gli STATE e le Knowledge sotto `internal/curator/runs/*/base` e `candidate-*`
sono input congelati e candidati non confermati. Il journal conserva previous e
next per recovery; non sono punti d'ingresso alla memoria e non vanno aperti per
ricostruire il presente. Sono mantenuti perché appartengono al protocollo e alle
evidenze di validazione; non vengono eliminati con questa riorganizzazione.

## Storage e recovery

Il contratto logico del Curator resta STATE/HISTORY e note complete con chiavi
logiche. Nel nuovo layout tale vista delle note viene ricostruita dai HEAD e dai
contenuti delle revisioni, verificandone hash e collegamenti. Non è uno snapshot
persistente aggiuntivo. Il memoryHash mantiene la stessa definizione logica.

Il journal autorizzato precede le pubblicazioni. Le revisioni e i nomi delle loro
directory vengono sincronizzati prima della promozione di STATE/HISTORY e del
checkpoint. Le ricevute restano interne. I flush includono i HEAD già esistenti;
il replay usa previous/next e i file di pubblicazione del journal, senza nuova
delega o autorizzazione. Le letture CLI della memoria canonica acquisiscono il
lock dello stesso Curator e non possono aggirare recovery o verifiche d'integrità.

Un lettore esterno Markdown non acquisisce quel lock: consultare i file dopo la
conferma, non durante apply/recovery. Questa proprietà non è una transazione
multi-file offerta da Obsidian. Restano i limiti di durabilità fisica documentati
in [STORAGE-DURABILITY.md](STORAGE-DURABILITY.md); il cambio di layout non li amplia.

Taxonomy e associazioni consultabili risiedono in memory; i loro journal e le
ricevute d'approvazione rimangono interni. Le viste topics sono ricostruibili e non
modificano fatti o revisioni. Non cambiano né consenso né semantica della curatela.

## Workspace legacy

Il layout precedente usa `.knownex/seed`, `.knownex/feed`, `.knownex/captures` e
`.knownex/curator/{memory,revisions,...}`. `seed` è il template iniziale, non il
presente dopo la prima materializzazione; le note piatte sono proiezioni correnti
dell'archivio revisions. Questo layout rimane leggibile e operativo, inclusi
batch già preparati, checkpoint v2/v3 e recovery pendenti. Non viene convertito
da init, SessionStart, read, validate o apply.

La selezione del layout è basata sulle directory del workspace; la presenza
simultanea di feed legacy e canonico è rifiutata come ambigua. I due percorsi CLI
standard del work sono risolti verso il layout effettivo; gli argomenti standalone
arbitrari mantengono il comportamento precedente. Non vengono creati alias fisici.

Non è implementata una migrazione in-place di archivi confermati. Le revisioni
contengono link relativi e metadati autenticati: spostarle può cambiare i target;
riscriverle ne cambia gli hash e i riferimenti dei successori. Anche feed, batch e
journal conservano percorsi e autorizzazioni. Una migrazione esplicita richiederebbe
un contratto dedicato e una verifica completa dei target, non una sequenza di move.
`curate init` non importa un cutoff positivo nel nuovo layout; il caso viene
rifiutato prima di scrivere. Conservare il workspace legacy è l'opzione supportata.

Le copie BOREAL e gli archivi dei test non vengono aggiornati o migrati.

## Verifiche

`tests/memory-layout.test.ts` verifica note nuove, aggiornate e invariate,
classificazione facoltativa, lookup logico/fisico/storico, ricerca dei soli HEAD,
noop, HISTORY, replay da stato misto con pubblicazione mancante e blocco su
corruzione. I controlli sui link verificano i target filesystem, non la semantica.
`tests/bootstrap.test.ts` usa un payload compilato in una directory temporanea
esterna, impedendo al runtime l'accesso ai sorgenti: hook, autorizzazione manuale,
feed, SessionStart/compact, checkpoint, recovery e init idempotente. Le suite
legacy continuano a verificare il protocollo precedente.
