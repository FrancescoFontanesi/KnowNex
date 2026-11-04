# V3.2 — Prospective Evaluation Oracle

**READY, limitatamente all’oracolo.** Nessun gate di KnowNex è stato valutato.

Creati [oracle.json](../.local/v3.2-oracle/oracle.json),
[sigillo e manifest](../.local/v3.2-oracle/seal.json),
[checksum](../.local/v3.2-oracle/oracle.sha256), copie delle quattro sorgenti e
[costruttore/verificatore specifico](../.local/v3.2-oracle/build.cjs).

Versione **3.2.0**: **33 fatti**, **17 critical**, **14 ordinary**, **2 unavailable**.
Catalogo E1: 7/8/1; Orione: 10/6/1. Nove domande coprono decisioni sostituite,
attività aperte, prerequisiti, vincoli, storia, artefatti e informazioni assenti.
Ogni fatto include motivazione, riferimento JSON Pointer o righe CSV, citazione
e relazioni temporali pertinenti.

Solo fatti completamente corretti ricevono credito. Il gate critico richiede
tutti i critici corretti in ogni ripetizione e tutte le assenze dichiarate;
invenzioni e decisioni storiche presentate come correnti sono bloccanti.
Il 95% ordinario usa denominatori separati per scenario e variante, senza credito
parziale né pooling. Per una ripetizione servono 8/8 e 6/6: nessuna suddivisione
artificiale per creare margine.

SHA-256 dei byte congelati:

```text
e48c726571662f672154a9e09d475c65a7db55cd2f0566746965738e2f083cce
```

Controllati ID, categorie, fonti, denominatori, duplicati normalizzati e hash.
Nessuna ambiguità classificatoria nota; equivalenze semantiche richiedono grading
motivato. Gli scenari sono già usati nei pilot: non costituiscono una suite disgiunta.
Oracoli storici invariati; zero LLM, deleghe o benchmark. V3.3 non eseguita.
