# Navigatore deterministico

```powershell
npm run build
npm start -- memory state --memory .local/r3-handoff/memory
npm start -- memory find "identita ordinamento" --type knowledge --memory .local/r3-handoff/memory
npm start -- memory read H000003 --memory .local/r3-handoff/memory
npm start -- memory read kn-74113e21-74dc-4b43-8f7b-a57b604be55f --memory .local/r3-handoff/memory
```

Il binario `knownex` espone gli stessi argomenti. `--memory` indica la directory
canonica autorizzata; senza opzione si usa `memory/` nella directory corrente.
Non si crea alcun file. `memory --help` mostra la sintassi. Il comando sync resta
disponibile con il contratto precedente.

- `state`: JSON `{status, content}` con il solo STATE originale; non legge HISTORY
  o Knowledge.
- `find "query"`: massimo cinque risultati, senza letture successive automatiche.
  Ogni risultato contiene ID, tipo, titolo, estratto, percorso e riferimento
  relativo alla memoria. Per HISTORY aggiunge data e intervallo degli eventi;
  il titolo usa gli argomenti del segmento. `--type history|knowledge` restringe
  anche i file scanditi. Una query senza risultati restituisce
  `{"status":"not_found","results":[]}` con exit 0.
- `read <id>`: contenuto integrale del solo segmento storico o della sola nota,
  con riferimenti risolvibili. Non segue i link. ID sconosciuto: errore
  MEMORY_NOT_FOUND, exit 1. ID malformati e argomenti invalidi: exit 2.

## Ricerca e identità

La ricerca è AND su parole Unicode, senza distinzione di maiuscole o accenti;
duplicati nella query non aumentano il punteggio. Non usa sinonimi o inferenza.
Per ogni termine la presenza pesa 8 nel titolo, 5 nei metadati, 3 nelle
intestazioni e 1 nel corpo. La frequenza non conta. Parità: tipo e ID in ordine
lessicografico indipendente dal locale. Titoli e estratti sono limitati a 160 e
240 caratteri; il contenuto completo si ottiene soltanto con read.

HISTORY usa delimitatori, ID e validazione di `src/history.ts`; il riferimento
è, per esempio, `HISTORY.md#h000003`. Gli ID Knowledge provengono dal frontmatter
del contratto R1 e vengono risolti nei file `knowledge/*.md`, senza alias o indice.
Identità duplicate, segmenti invalidi, metadata non validi e UTF-8 malformato
causano errori espliciti. Percorsi arbitrari come ID e symlink/junction lungo i
percorsi letti sono rifiutati; i link Markdown restano dati, non percorsi da aprire.

## Uso selettivo e limiti

Leggere STATE una volta, riusare la risposta, cercare con parole mirate e filtro
quando disponibile, aprire solo i candidati pertinenti alle domande ancora aperte.
Un mancato risultato lessicale non prova un'assenza semantica universale: riportare
che il dato non è documentato nelle evidenze recuperate, senza inventarlo.

Il backend scandisce i file locali in memoria: O(dimensione HISTORY/Knowledge)
senza indice persistente. Al modello restituisce soltanto risultati limitati e
contenuti scelti. Non esiste una snapshot transazionale fra file: navigare la
memoria confermata e stabile, evitando una promozione concorrente. I controlli
dei percorsi non costituiscono isolamento contro modifiche ostili simultanee
del filesystem. Il navigatore non legge feed o checkpoint e non modifica curator.
