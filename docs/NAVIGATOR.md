# Navigatore deterministico

## Recall tramite agente nativo

Il principale riusa STATE e la conversazione corrente. Un riferimento già noto
(nota o finestra linkata da STATE, ID `H…`) lo legge direttamente con `memory read`:
una lettura costa meno di una delega. Solo per una ricerca delega il quesito a
`knownex_recaller`, con contesto
indipendente (`fork_turns="none"` dove supportato), workspace e riferimenti noti.
Il Recaller usa la skill `knownex-recall` e i comandi sotto; restituisce fatti
pertinenti, riferimenti, provenienza e limiti, non i documenti o il log delle
letture. Il principale attende senza navigazione duplicata. Se il ruolo non e
disponibile, segnala il limite senza fallback automatico a ricerche dirette.

`knownex_recaller` e `knownex_curator` sono ruoli distinti con modello
`gpt-6.1-terra` e reasoning `medium`: Recall non materializza memoria e non delega.
I vincoli di sola consultazione sono comportamentali, non permessi read-only
separati: il ruolo eredita la sandbox del principale. Le primitive correnti
possono acquisire lock interni e completare recovery gia autorizzate durante una
lettura; la nuova delega non introduce una garanzia tecnica di assenza di scritture.

STATE resta l'handoff automatico tra nuove sessioni, non un refresh per turno.
L'hook corrente emette STATE anche dopo compact; questo comportamento non viene
modificato e la consegna effettiva resta dipendente dall'harness.

## Comandi del Recaller

```powershell
npm run build
npm start -- memory state --memory .knownex/memory
npm start -- memory find "identita ordinamento" --type knowledge --memory .knownex/memory
npm start -- memory history --last 10 --memory .knownex/memory
npm start -- memory read H000003 --memory .knownex/memory
npm start -- memory read kn-ID-DELLA-NOTA --memory .knownex/memory
npm start -- memory read "knowledge/storage.md#flush-locale" --memory .knownex/memory
# Copiare un riferimento immutabile effettivo da STATE o da read/find:
npm start -- memory read "knowledge/checkpoint-0004/nome--kn-UUID--REV.md#policy" --memory .knownex/memory
```

Il binario `knownex` espone gli stessi argomenti. `--memory` indica la directory
del checkpoint del progetto; sostituire gli ID degli esempi con quelli trovati
tramite `find`. Prima del primo checkpoint la directory disponibile e lo STATE iniziale nella stessa memory/.
Senza opzione, le nuove installazioni usano sempre .knownex/memory, anche per lo
STATE iniziale. Nei workspace legacy restano i percorsi precedenti e il seed.
Fuori da un workspace KnowNex resta
il default standalone `memory/`.
Le copie standalone sono read-only; nei workspace il gate può completare una
recovery già autorizzata. `memory --help` mostra la sintassi. Il comando sync resta
disponibile con il contratto precedente.

- `state`: JSON `{status, content}` con il solo STATE originale. Una copia standalone
  legge solo STATE; nel workspace il gate verifica anche la memoria confermata.
- `find "query"`: massimo cinque risultati, senza letture successive automatiche.
  Ogni risultato contiene ID, tipo, titolo, estratto, percorso e riferimento
  relativo alla memoria. Per HISTORY aggiunge data e intervallo degli eventi;
  il titolo usa gli argomenti del segmento. `--type history|knowledge` restringe
  anche i file scanditi. Una query senza risultati restituisce
  `{"status":"not_found","results":[]}` con exit 0.
- `history [--last N] [--before H-ID]`: cronologia dei checkpoint dal più recente (default 10,
  massimo 50), con ID, data, eventi, argomenti, descrizione e riferimento, senza il corpo
  delle finestre. Serve a scegliere quali finestre aprire senza leggere HISTORY intero.
- `read <id|reference>`: contenuto integrale della sola finestra o segmento storico o della sola nota,
  con riferimenti risolvibili. Non segue i link. ID sconosciuto: errore
  MEMORY_NOT_FOUND, exit 1. ID malformati e argomenti invalidi: exit 2.

## Dal contesto al dettaglio

SessionStart tenta di includere lo STATE completo, cutoff e avvisi sul pending,
anche con STATE estesi e dopo compact. Non impone una soglia dimensionale interna.
Emissione di KnowNex e consegna effettiva nell'harness sono confini distinti:
vedere i limiti e la configurazione nel [runtime](RUNTIME.md).
Riutilizzare
STATE e istruzioni recall gia presenti; non eseguire un cold start a ogni domanda.
Se STATE basta non servono chiamate. Con un documento identificato, leggere il
riferimento diretto; usare find quando manca il documento o serve un altro tema.

`read` accetta ID, l'alias logico `knowledge/<nome>.md`, `HISTORY.md#h000003`,
`history/H000003.md` e il percorso fisico
`knowledge/checkpoint-NNNN/[categoria]/nome--kn-UUID--REV.md`. Il prefisso `nome--`
serve a chi sfoglia il vault; le revisioni precedenti senza prefisso restano valide. I vecchi
riferimenti `../revisions/...` restano supportati. Sono forme ristrette risolte dal navigatore,
non accesso a percorsi arbitrari. I riferimenti sono relativi alla radice memory:
un link dentro una nota va risolto rispetto al `path` di quella nota. Non si passa
l'intera sintassi `[etichetta](destinazione)` e non si aprono feed o artifact con read.
Nessun link viene seguito automaticamente; si approfondisce solo quello necessario.
Per le nuove revisioni il riferimento canonico include checkpoint ed eventuale
categoria: `knowledge/checkpoint-0004/experiments/kn-UUID--REV.md`. I nomi piatti
precedenti restano validi. Un percorso richiesto deve coincidere con quello
autenticato della revisione; non si risolve un altro file con lo stesso basename.

Un frammento ATX `#anchor` su una Knowledge, anche dopo `kn-ID@REV`, legge quella
sezione e le sottosezioni fino alla prossima intestazione di livello uguale o
superiore. Il contenuto conserva i byte UTF-8/CRLF senza frontmatter aggiuntivo;
ID, path e revisione restano nei metadati del documento originale.
`selection` dichiara anchor, fromLine, throughLine e totalLines del documento.
La SHA-256 di una revisione continua a riferirsi al file immutabile completo,
non all'estratto. Non si tronca silenziosamente il testo; una sezione puo ancora
essere lunga. Le qualificazioni globali o in altre sezioni richiedono altro contesto.
Anchor assente o ambiguo: MEMORY_SECTION_NOT_FOUND o MEMORY_AMBIGUOUS_SECTION,
exit 1; non si sceglie un'intestazione duplicata arbitrariamente.
Le intestazioni dentro fence di codice non sono sezioni. Si supportano le
intestazioni ATX del contratto, non un parser Markdown generale.

## Ricerca e identità

Nei workspace versionati, `find` e `read kn-...` restano correnti e restituiscono
anche revisione e riferimento immutabile. `read kn-...@REV` legge una versione
precisa; `read kn-... --at N` risolve un checkpoint confermato, inclusi i noop.
`--at H000002` usa il cutoff precedente al segmento (`from - 1`).
Nessun fallback per versioni mancanti o richieste anteriori alla baseline.
Un riferimento immutabile non viene sostituito con l'ultima revisione. Per leggere
il presente usare l'ID logico o il percorso corrente. Numero di checkpoint, ID
HISTORY, sequenza E del feed e identificatore di revisione hanno ruoli distinti;
`--at N` accetta solo un checkpoint confermato, non un evento qualsiasi.
L'archivio non partecipa a find: le vecchie revisioni non moltiplicano i candidati.
Find non classifica validita semantica, supersession o indipendenza dei risultati:
si leggono ambito, qualificazioni e fonti, anche nella revisione storica pertinente.
Dettagli e compatibilità: [Knowledge versionate](KNOWLEDGE-REVISIONS.md).

La ricerca è AND su parole Unicode, senza distinzione di maiuscole o accenti;
per le note correnti i nuovi percorsi forniscono anche metadati di categoria e
checkpoint. Query come `experiments` o `checkpoint-0004` li trovano senza un
indice secondario. Nei risultati category e checkpoint descrivono collocazione e
provenienza, non validita semantica. Le revisioni storiche non entrano nella
ricerca corrente e restano leggibili con ID qualificati o riferimenti storici.
duplicati nella query non aumentano il punteggio. Non usa sinonimi o inferenza.
Per ogni termine la presenza pesa 8 nel titolo, 5 nei metadati, 3 nelle
intestazioni e 1 nel corpo. La frequenza non conta. Parità: tipo e ID in ordine
lessicografico indipendente dal locale. Titoli e estratti sono limitati a 160 e
240 caratteri. L'estratto sceglie la finestra con piu termini distinti della query
(180 unita UTF-16 per le corrispondenze, fino a 60 caratteri di contesto precedente),
con parita al primo passaggio. Non cambia il ranking dei documenti e non e una
valutazione semantica. Se il passaggio appartiene a una sottosezione con anchor
unico e lungo al massimo 160 unita UTF-16, `section` ne mostra titolo/anchor
(titolo limitato a 160 caratteri) e `reference` punta direttamente li.
Le occorrenze lontane possono soddisfare AND senza entrare tutte nell'estratto.

HISTORY usa delimitatori, ID e validazione di `src/history.ts`; il riferimento
è, per esempio, `HISTORY.md#h000003`. Gli ID Knowledge provengono dal frontmatter
del contratto R1 e vengono risolti nei file `knowledge/*.md`, senza alias o indice.
Identità duplicate, segmenti invalidi, metadata non validi e UTF-8 malformato
causano errori espliciti. Percorsi arbitrari, URL, traversal e symlink/junction
lungo i percorsi letti sono rifiutati. I riferimenti alle revisioni attraversano
la catena verificata del checkpoint: non autorizzano file orfani nell'archivio.

## Organizzazione tematica

La manutenzione esplicita [knownex-taxonomy](TAXONOMY.md) aggiunge associazioni a
revisioni precise senza riscriverle. `memory category CHIAVE --memory DIRECTORY`
restituisce revisioni in ordine cronologico, originali o retroattive, con flag
`current`, `through` e riferimento immutabile. `--limit` (default 5, massimo 20)
e `--cursor` permettono pagine stabili; modifiche ai metadati/checkpoint invalidano
il cursore. La copertura storica e limitata alle note gia versionate.
Find resta corrente: `thematicCategories` indica categorie effettive,
`category` la collocazione originaria. Read conserva gli stessi byte e ID.
Gli indici Markdown in `memory/topics/` sono viste ricostruibili, non Knowledge.

Riutilizzare identita e note correnti per lo stesso tema. Titoli e intestazioni
distintivi aiutano AND e selezione dei passaggi; descrivere esplicitamente ambito,
correzioni e decisioni sostituite. Raggruppare per coesione e consultazione autonoma,
senza dividere per turno o soglia di byte. Temi come decisioni/motivazioni,
risultati/limiti, specifiche e questioni aperte sono criteri facoltativi, non
directory, tipi o tassonomie obbligatorie. Le sezioni consentono letture mirate
nelle note coerenti; un tema indipendente puo meritare una nota autonoma collegata.

## Uso selettivo e limiti

Leggere STATE una volta, riusare la risposta, cercare con parole mirate e filtro
quando disponibile, aprire solo i candidati pertinenti alle domande ancora aperte.
Un mancato risultato lessicale non prova un'assenza semantica universale: riportare
che il dato non è documentato nelle evidenze recuperate, senza inventarlo.

Il backend scandisce i file locali in memoria: O(dimensione HISTORY/Knowledge)
senza indice persistente. Al modello restituisce soltanto risultati limitati e
contenuti scelti. Nei workspace ogni operazione condivide il gate del curator;
le sezioni limitano l'output, non l'I/O di verifica o la scansione locale. Un
riferimento diretto evita find ma la risoluzione corrente controlla comunque
le identita delle note; non promette backend O(1).
non esiste una snapshot fra chiamate successive. Navigare memoria confermata
e stabile. I controlli
dei percorsi non costituiscono isolamento contro modifiche ostili simultanee
del filesystem. Il gate legge checkpoint/feed e può completare un apply già
autorizzato; le copie standalone non hanno questa integrazione.

## Evidenze e limiti della valutazione

Le fixture coprono piu note simili, dettagli secondari, due livelli di linkage,
sezioni, piu checkpoint, correzioni e versioni storiche; controllano byte,
identita, ordine, limiti degli estratti, percorsi e assenza di traversate.
SessionStart rende STATE disponibile; i test offline non dimostrano che l'agente
lo riusi effettivamente o interpreti correttamente tutte le qualificazioni.

Test001 standalone caricava recall e STATE per ogni agente nuovo: non esercitava
SessionStart. I 26610 byte di istruzioni nei sei recuperi A erano il 46,1% dello
stdout, non dei token totali. Recall ora rimanda i dettagli del pending al runtime
solo quando servono, senza imporre una nuova lettura per ogni domanda. Questo e
un cambiamento istruttivo, non un risparmio LLM misurato. Oracolo e risultati
precedenti rimangono immutati; nessun nuovo benchmark eseguito.

Nel futuro confronto MCP/CLI usare lo stesso navigatore e le stesse versioni,
query, selezioni, fonti e condizioni di contesto iniziale. Misurare separatamente
correttezza del recupero, qualita della risposta, chiamate, byte/token realmente
esposti, istruzioni, cache, trasporto e tempo. Meno output non dimostra minor
costo complessivo; sezioni prive di qualificazioni necessarie non sono recuperi
completi. Nessuna interfaccia MCP e introdotta qui.
