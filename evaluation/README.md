# Framework di valutazione KnowNex

## Fixture indipendente Cold Start / Retrieval

`node evaluation/retrieval.mjs F:\KnowNex-Retrieval-NUOVO` prepara cinque
workspace separati MERIDIAN e protocolli congelati nell'harness esistente.
Eseguire prima `npm run build`. La destinazione deve essere nuova ed esterna al
repository. Nessun modello, checkpoint, modifica globale o approvazione automatica.
La preparazione crea un archivio con `npm pack` e installa ogni workspace con
`npm install --offline`: npm genera gli shim della CLI, senza copie manuali del
runtime. Init e Recall usano `npm exec --offline -- knownex ...`. Ogni workspace
ha un repository Git vuoto, senza commit, richiesto da `codex exec`.
Ogni scenario ha un feed vuoto proprio: i prompt di un test non contaminano i successivi.

La memoria e un **seed sintetico scritto a mano**, non il risultato di una curatela:
questi scenari isolano retrieval e infrastruttura, non misurano la qualita del Curator.
Il registro sorgente, gli oracle e i prompt restano in `inputs/` fuori dai workspace.
`scenarios.json` contiene criteri atomici, qualificazioni, provenienza e percorsi di
riferimento: cold, direct, deep, historical, negative. Le letture di riferimento
non sono vincoli sull'autonomia dell'agente ne misure del suo comportamento.

Preparazione e test mantengono `modelCalls: 0`. Prima di una prova LLM autorizzata,
creare un nuovo protocollo con limiti espliciti, verificare versione/configurazione
effettive e approvazione nativa di **SessionStart**, oltre agli hook di acquisizione.
Non sostituire un SessionStart mancante con un prompt che incolli STATE: sarebbe
un'altra condizione. L'esecuzione manuale del comando hook dimostra emissione integra,
non attivazione nativa o consegna al modello. Un blocco di trust/discovery/approvazione
va registrato come infrastrutturale e la qualita resta non valutabile.

Per le prove future: una nuova sessione per scenario, nessuna conversazione originale,
solo il prompt congelato; poi `start/collect/evaluate` dell'harness. Usare oracle privato
e citazioni di memoria e risposta per separare `memory`, `retrieval`, `use`, `fidelity`.
Misurare usage nativo totale/cached/non cached, tool e letture riconoscibili; ispezionare
le chiamate opache senza attribuire loro zero letture. Annotare interventi manuali
con conteggio ed evidenze e intervalli `human_wait`/`cold_start`: la durata del turno
non misura da sola il tempo di bootstrap. Mancanze di trace restano `null`.
Non generare risposte o giudizi sintetici da presentare come risultati reali.

`node --test evaluation/tests/retrieval.test.mjs` verifica installazione ordinaria,
emissione byte-per-byte dello STATE, isolamento, riferimenti e navigazione reale
tramite CLI. Le prove LLM richiedono un via libera separato.

Tool locale di osservazione e revisione, **separato dal prodotto e dal suo tgz**.
Non installa KnowNex, non lancia Codex/modelli e non esegue neppure `memory state`:
la CLI del prodotto potrebbe completare una recovery. Legge solo file esplicitamente
selezionati e scrive in una directory di esperimento esterna al workspace osservato.
Nessuna dipendenza nuova, server, database o telemetria. Richiede Node 24.11+.

L'harness usa `../scripts/measure.ts` gia presente per il conteggio nativo degli
usage. Eseguire la CLI dalla sua posizione nella repository; il workspace dei test
puo essere ovunque. Non serve installare il prodotto nella repository di sviluppo.
Per trasferire il tool conservare anche quel file nella posizione relativa indicata.

## Ciclo operativo

1. Installare separatamente KnowNex nel workspace di prova. Preparare scenario,
   fonti e ground truth **prima di osservare le risposte**. Nessuno scenario A/B/C
   viene definito da questo tool.
2. Creare una directory privata per gli output e un file config. `init` congela
   configurazione, fonti, oracolo, codice e hash dell'implementazione del misuratore.
3. `start` crea un UUID e fotografa memoria/istruzioni/config iniziali. Il comando
   non avvia la sessione: usare Codex normalmente, senza cambiare hook o skill.
4. A lavoro concluso/interrotto, selezionare esplicitamente trace e turni pertinenti
   e chiamare `collect`. Conservare anche le sessioni fallite. Non leggere tutta
   CODEX_HOME: non esiste ricerca automatica dei transcript.
5. Revisionare separatamente contenuto materializzato, evidenze recuperate e
   risposta; importare `evaluate`. Ripetere per una revisione corretta: la precedente
   rimane immutata. `report` rigenera solo output derivati.
6. `compare` conserva tutti i run e produce delta solo fra quelli con controlli
   dichiarati uguali ed evidenza completa nel perimetro selezionato.

Da qualsiasi cartella, indicando il percorso reale del tool:

```powershell
node "C:\tools\KnowNex\evaluation\cli.mjs" init --config "C:\test-config\config.json" --out "C:\risultati\esperimento"
node "C:\tools\KnowNex\evaluation\cli.mjs" start --experiment "C:\risultati\esperimento"+# Eseguire manualmente la prova autorizzata in Codex, annotando gli ID.
node "C:\tools\KnowNex\evaluation\cli.mjs" collect --experiment "C:\risultati\esperimento" --run UUID --capture "C:\test-config\capture.json"
node "C:\tools\KnowNex\evaluation\cli.mjs" evaluate --experiment "C:\risultati\esperimento" --run UUID --review "C:\test-config\review.json"
node "C:\tools\KnowNex\evaluation\cli.mjs" report --experiment "C:\risultati\esperimento" --run UUID
node "C:\tools\KnowNex\evaluation\cli.mjs" compare --runs "C:\risultati\esperimento\runs\UUID,C:\risultati\altro\runs\ALTRO_UUID" --out "C:\risultati\confronto"
```

I percorsi del config/capture sono relativi al rispettivo file, non alla cwd.
La directory padre degli output deve esistere; init e compare richiedono una
directory destinazione nuova. I comandi sullo stesso esperimento sono sequenziali;
non esiste un servizio o un lock distribuito per esecuzioni concorrenti dell'harness.

## Configurazione minima

```json
{
  "version": 1,
  "scenario": "nome-scenario",
  "condition": "knownex-current",
  "workload": "identificativo-carico-congelato",
  "comparisonGroup": "gruppo-controllato",
  "instructionPolicy": "istruzioni-e-differenze-autorizzate",
  "transport": "versione-e-configurazione-tool",
  "model": "MODELLO_EFFETTIVO_ATTESO",
  "reasoning": "medium",
  "knownexVersion": "0.1.0-rc.11",
  "synthetic": false,
  "workspace": "../workspace-osservato",
  "groundTruth": "oracle.json",
  "sources": [{ "id": "source-1", "path": "fonti-originali.txt" }],
  "controlPaths": ["AGENTS.md", ".codex/config.toml"],
  "environment": { "codexVersion": null, "hooksApproved": null },
  "limits": { "retrievalOperations": 8, "durationMs": 300000 }
}
```

`limits` documenta le condizioni: l'harness osservatore **non le impone** a Codex.
Non inserire versioni o approvazioni presunte: usare null se non verificabili.
L'identita del pacchetto effettivamente installato e i suoi file configurativi
sono acquisiti prima del run. Un mismatch di versione esclude il confronto.
Per una baseline senza KnowNex usare `knownexVersion: null` e condizioni esplicite.

Snapshot predefiniti: `.knownex/seed`, `.knownex/curator`, `.knownex/feed`,
`.knownex/install.json`, `.codex`, `.agents/skills`, `AGENTS.md` e il package.json
di KnowNex installato, dist e risorse runtime del package. Includono ricevute,
revisioni, journal, staging e packet;
non vengono interpretati tramite il runtime. Per artifact aggiuntivi usare
`snapshotPaths`: sostituisce l'elenco, non lo estende implicitamente. Capture
integrale `.knownex/captures` e artifact investigativi richiedono scelta esplicita.
Percorsi relativi, senza traversal o symlink/junction. Non si cancella nulla.

`controlPaths` (default AGENTS.md) deve essere coperto dagli snapshot: i suoi hash
iniziali devono corrispondere per confrontare due run. Se una differenza di istruzioni
e intenzionale, dichiararla nel protocollo e scegliere esplicitamente i controlli
comuni; non cancellarli dopo aver visto gli esiti. L'uguaglianza degli hash non
prova che il modello abbia ricevuto tutte le istruzioni o che due carichi siano equivalenti.

## Ground truth congelata

```json
{
  "version": 1,
  "id": "reference-v1",
  "facts": [
    {
      "id": "F001",
      "description": "Verifica funzionale ancora aperta",
      "expected": "Il collaudo deve ancora essere eseguito.",
      "priority": "critical",
      "temporalScope": "corrente dopo la decisione D2",
      "qualifications": ["Il risultato tecnico non equivale al collaudo."],
      "supersedes": [],
      "sources": [{ "source": "source-1", "startLine": 1, "endLine": 3 }],
      "criterion": "Preserva esplicitamente il collaudo aperto senza dichiararlo completato."
    }
  ]
}
```

Priorita: critical, ordinary, unavailable. Per unavailable l'esito atteso e
riconoscere il limite; non inventare un valore. Distinguere un fatto atomico da
un elenco di requisiti compositi. `supersedes` indica altri ID del registro;
ambito temporale, qualificazioni e criterio rimangono testo esplicito per il revisore.
Le fonti vengono copiate esattamente, con righe e SHA-256 verificabili.

Non esiste modifica dell'oracolo in-place. Per correggerlo creare un nuovo
esperimento, documentando nel config l'ID/hash di quello precedente e la ragione.
Gli oracoli diversi non vengono confrontati automaticamente come se fossero uguali.
I sigilli rilevano modifiche accidentali; non proteggono da chi possa riscrivere
contemporaneamente tutti i file, i manifest e gli hash.

## Acquisizione e attribuzione

```json
{
  "status": "completed",
  "traces": [
    {
      "path": "trace-principale.jsonl",
      "threadId": "ID_NATIVO_SESSION_META",
      "role": "principal",
      "turns": [
        {
          "id": "ID_TURNO",
          "phase": "creation",
          "operation": "checkpoint-review"
        }
      ]
    }
  ]
}
```

Stati: completed, failed, timeout, policy_blocked, interrupted. Ruoli:
principal/curator/other. Fasi: creation/consultation/other; operation e un'etichetta
dell'intero turno, non un'allocazione inventata fra tool. Per il curator aggiungere
il trace figlio con ID verificato nella sua session_meta; il ruolo semantico resta
una dichiarazione dell'osservatore, sostenuta dalla delega e dai metadati originali.
Un ID sessione del feed KnowNex non e automaticamente il thread ID di Codex.

L'adapter supporta gli export nativi con session_meta, turn_context,
token_usage_record, response_item ed event_msg task_started/task_complete.
Formati non compatibili, contatori mancanti o scope incerti rimangono non misurati
o producono un run incompleto con errore registrato. Non dedurre usage dai byte,
dai soli token_count cumulativi o dal numero di comandi.

Per annotare attese o durate non esposte, capture puo contenere `intervals` con
kind human_wait/cold_start/curation/checkpoint/navigation, start/end ISO, explanation
ed evidence con file/startLine/endLine. I riferimenti sono relativi al run congelato
(esempio raw/001.jsonl). Le durate annotate sono unioni di intervalli per tipo,
separate dai tempi nativi. Non dimostrano completezza delle attese e non vengono
sottratte automaticamente per fabbricare un tempo automatico netto.

| Misura                          | Fonte e significato                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Input, output, cache, reasoning | Usage per risposta univoca; verifica dei cumulativi del turno. Cached e reasoning sono sottoinsiemi, non addendi aggiuntivi              |
| Non cached                      | Input meno cached soltanto quando entrambi disponibili                                                                                   |
| Sessione/fase/operazione/ruolo  | Somme dei soli turni selezionati e dichiarati. Nessuna ripartizione arbitraria del costo del principale                                  |
| Risposte del modello            | Response ID con usage; non conteggio garantito di retry/chiamate interne non esportate                                                   |
| Tool call                       | Call ID nativi deduplicati, con tipo e righe del trace. I tool annidati in JavaScript opaco non sono enumerati                           |
| Navigazione e riletture         | Tentativi riconosciuti di CLI diretta; conteggio parziale, non prova di lettura riuscita. Shell composte e orchestrazione restano opache |
| Latenza tool                    | Timestamp call → output; include scheduling/trasporto, non solo backend                                                                  |
| Tempi di fase                   | Unione degli intervalli dei turni completi, non somma di lavoro parallelo                                                                |
| Byte tool                       | UTF-8 della rappresentazione serializzata nel trace, non contenuto garantito nel contesto del modello                                    |
| Creazione/consultazione         | Separate per fase e ruolo; la review del principale resta creation se cosi registrata                                                    |
| Cold start, attese, deleghe     | Solo evidenze/annotazioni esplicite; nessuna deduzione dal silenzio o da una menzione di skill                                           |
| Monetario e quota               | Non disponibili: nessun listino verificato integrato e nessuna conversione byte/token/quota                                              |

Le tool call con nome exec_command sono riconosciute solo quando gli argomenti
sono JSON statico con cmd e un singolo comando CLI semplice. Nessun eval o parser
approssimativo di JavaScript. Questa scelta puo lasciare gran parte delle operazioni
non attribuite nel runtime corrente: e un limite misurato, non zero attivita.
Usare i trace originali per revisione manuale; non cambiare il prodotto per ottenere
contatori piu favorevoli. I riferimenti diretti e il caricamento automatico di STATE
non equivalgono necessariamente a una chiamata CLI osservabile.

## Registro delle valutazioni

```json
{
  "reviewer": { "kind": "human", "id": "revisore-1" },
  "assessments": [
    {
      "factId": "F001",
      "verdict": "correct",
      "memory": "correct",
      "retrieval": "correct",
      "use": "correct",
      "fidelity": "correct",
      "errors": [],
      "explanation": "Fonti, memoria e risposta mantengono lo stesso requisito aperto.",
      "evidence": [
        {
          "file": "after/.knownex/curator/memory/STATE.md",
          "startLine": 1,
          "endLine": 5
        }
      ]
    }
  ]
}
```

Ogni campo di grading usa correct/partial/incorrect/omitted/not_evaluable.
La revisione della conservazione deve citare memoria e fonti; quella di uso deve
citare output recuperati e risposta. Il verificatore controlla presenza/hash/righe,
non il significato delle citazioni. Per memory=omitted e obbligatorio searchCoverage:
spiegare l'insieme ispezionato. Non si prova assenza semantica con una ricerca vuota.
Evidenze: before/after/raw relative al run, oppure reference/ relative all'esperimento.
Errori: contradiction/invented/misattributed/temporal_confusion/qualification_lost.

Localizzazioni derivate con prudenza: absent_memory, present_not_retrieved,
retrieved_misused, correctly_used oppure unresolved. Le combinazioni parziali o
insufficienti non diventano automaticamente una colpa del curator o del navigatore.
Il registro mantiene anche i cinque grading separati e tutte le spiegazioni.

Un giudice esterno LLM puo fornire lo stesso JSON con kind=llm_assisted e modello
esplicito; l'harness non lo invoca e non trasforma il suo giudizio in ground truth.
Una seconda revisione conserva originale, input e catena hash. Il report indica se
i giudizi critici correnti sono tutti umani, senza presumere infallibilita umana.
Il tipo fixture e riservato ai protocolli synthetic=true: la demo non attribuisce
a un revisore umano o a un modello valutazioni generate deterministicamente.

Denominatori distinti critical/ordinary/unavailable, per completezza, fedelta e
utilita. Partial non riceve credito pieno. I fatti non revisionati restano distinti
da omissioni; un'accuratezza completa non e calcolata finche ci sono giudizi mancanti
o non valutabili. I gate critici separati falliscono su errori noti anche quando
l'accuratezza ordinaria e alta. Non sono una qualificazione generale di KnowNex.

## Output e conservazione

```text
esperimento/
  protocol.json, protocol.sha256
  reference/                 # configurazione, oracolo e fonti originali
    implementation/          # copia eseguibile di harness e misuratore usati
  runs/UUID/
    run.json, initial.json   # ID, ambiente, snapshot iniziale e versione rilevata
    before/, after/          # copie esatte, manifest con hash e mtime
    raw/                     # capture originale e trace selezionati
    collection.json          # scope, metriche, eventi/timing e limiti
    evidence.json, evidence.sha256
    reviews/                 # revisioni, input originali e sidecar hash
    event-UUID.json          # esiti ed errori; failure.json se incompleto
    metrics.json, REPORT.md  # derivati rigenerabili
confronto/
  comparison.json, comparison.csv, REPORT.md
```

Gli snapshot fanno due inventari attorno alla copia e non acquisiscono lock del
prodotto: non sono snapshot atomiche del filesystem. Fermare o mettere in pausa la
prova prima di collect; una variazione rilevata esclude il confronto. Il semplice
accesso in lettura puo aggiornare atime per politica del filesystem; non si scrivono
byte, mtime, feed, checkpoint o journal del workspace osservato.

Una raccolta fallita rimane registrata; non viene sovrascritta da un retry.
Per ripetere la prova creare un nuovo run. Le directory di output non devono essere
nel workspace osservato. I confronti richiedono oracolo/fonti/controlli/modello/
reasoning/workload/transport/limiti dichiarati compatibili e stato completato,
usage completo e versione corretta. Tutti gli altri run restano nel riepilogo esclusi.
Run reali che condividono una sessione nativa non vengono presentati come confronti
indipendenti. La demo sintetica puo riutilizzare lo stesso trace noto: dimostra il
calcolo, non indipendenza empirica. Il riepilogo per condizione conta anche fallimenti.
Non si sommano finestre diverse per ricavare un costo end-to-end.

Una modifica all'harness richiede un nuovo esperimento: gli hash del codice sono
parte del protocollo. Per riprodurre un report precedente usare la CLI conservata
in `reference/implementation/evaluation/cli.mjs` di quell'esperimento. Non sostituire
il codice congelato. I cambiamenti di istruzioni controllate o runtime installato
rilevati durante un run lo escludono dai confronti.

Quando principale e Curator usano modelli diversi, congelare nel config anche
`roleModels`, per esempio `{"principal":{"model":"gpt-6.1-sol","reasoning":"medium"},"curator":{"model":"gpt-6.1-terra","reasoning":"medium"}}`.
Ogni trace e verificato rispetto al proprio ruolo; senza questa mappa resta valida
la configurazione model/reasoning unica. La mappa partecipa ai controlli del confronto;
non modifica né deduce i contatori di usage. Il ruolo rimane da correlare alle fonti native.

## Privacy e limiti

Selezionare solo fonti autorizzate: trace e staging possono contenere conversazioni,
istruzioni, segreti e dati personali. Anche i JSON derivati possono contenere
comandi sensibili. File locali privati (mode 0600/0700 dove supportato), nessun invio
remoto o redazione automatica. Su Windows tali mode non sono una garanzia ACL:
usare una directory con accesso controllato. Per condividere risultati creare una
copia redatta dichiarata, conservando gli originali protetti e i loro hash.

La session_meta e i file di istruzioni non provano l'intero contesto del modello.
Usage e output nativi non provano assenza di CCR/compressione in altri trasporti.
Differenze di cache, istruzioni, esecuzione parallela, versioni e selezione dei turni
possono distorcere i risultati. I confronti sono descrittivi; nessuna significativita
statistica, risparmio monetario o causalita viene inferita automaticamente.

## Verifica sintetica e dimostrazione

Dalla repository:

```powershell
npm --prefix evaluation test
node evaluation/demo.mjs .local/evaluation-demo-current
```

La demo genera due run esclusivamente sintetici con fonti, oracolo, trace, revisioni
e report comparativo. Nessuna sessione Codex, nessun modello, nessun checkpoint.
Il gate di conservazione resta non misurato quando memory=not_evaluable: la risposta
corretta non dimostra da sola che la memoria abbia conservato il fatto.
Usare gli input generati come esempio di formato, non come scenario qualificante.
