# Checkpoint con Curator nativo

## Percorso ordinario

L'utente invoca `$knownex-checkpoint`; Sol esegue `curate native --stage prepare`,
delega una sola volta al custom agent `knownex_curator` con contesto indipendente,
attende le ricevute e poi esegue `curate native --stage complete`.
Non legge feed, packet, memoria, proposta o review e non ripete l'analisi di Terra.

La definizione project-scoped `.codex/agents/knownex_curator.toml` seleziona
`gpt-6.1-terra`, reasoning `medium`. Autenticazione, provider, permessi e MCP sono
ereditati dal principale: nessun override o fallback. Le skill sono ereditate;
bootstrap installa ruolo e skill nella stessa distribuzione. Una sessione deve
caricare questa configurazione; se il ruolo non e esposto, la skill si ferma con
`CURATOR_NATIVE_UNAVAILABLE`, senza usare un ruolo o un modello alternativo.

Sol chiama prepare con `--authorization captured-user-invocation`. Il riferimento
simbolico non e un permesso inventato dal modello: prepare risolve l'invocazione corrente acquisita nel feed,
la consuma sotto il lock esistente e registra sequenza/checksum nel run. Non e una
prova dell'identita nativa del messaggio di delega: la fonte dell'autorita rimane
l'evento utente del feed. `complete` richiede il run esplicito e ricontrolla il binding.

Sol trasmette soltanto workspace, run ID, `requestFile`, percorso della skill e
`workerMode: materialize-only`. Terra legge autonomamente la richiesta e il batch
congelato, esegue tutta la curatela e restituisce le ricevute dell'I/O canonico.
Non esegue primitive di checkpoint o App Server. Sol passa run ID e hash reali
delle ricevute a complete. Questa primitiva riusa verifica ricevute, validate, policy sulle
anomalie, sigillo e apply del controller esistente. Non lancia worker. Non serve
un secondo sistema di checkpoint o una review indipendente del principale.
Prepare e complete verificano il feed acquisito e il binding del batch, senza
App Server, history Codex, bridge o ampliamento dei permessi. I turni originali
modificati retroattivamente fuori dal feed non sono una fonte di invalidazione:
vale il compromesso esplicito del MEMORY-CONTRACT.

Il runtime si invoca direttamente: `node node_modules/knownex/dist/index.js`
nell'installazione locale, `node dist/index.js` nel checkout gia compilato.
Un runtime assente e un errore bloccante, non una richiesta di ricerca npm/npx.
Le prove d'installazione eseguono davvero questo percorso, senza cache npm.

Prepare restituisce a Sol soltanto READY, run ID, percorsi e intervallo del batch;
la richiesta completa resta in `requestFile` e viene letta soltanto da Terra.
Se Terra fallisce o le ricevute mancano, Sol termina con errore senza complete,
retry o riparazione. Un run gia preparato rimane diagnosticabile; nessun errore
del worker autorizza una nuova delega.
Il risultato conclusivo di complete e un oggetto
`SUCCESS`, `BLOCKED` o `ERROR`, con cutoff, conteggi disponibili, codice/fase,
diagnostica essenziale e riferimenti agli artefatti interni. Non contiene documenti.
Qualsiasi incertezza/anomalia dichiarata blocca l'applicazione automatica. I due
percorsi condividono la stessa funzione di pubblicazione; review v1/v2 e garanzie
transazionali restano invariate. Nessuna review semantica indipendente di Sol.

Il ruolo vieta ulteriori deleghe e il runtime nativo non possiede un launcher.
Codex 0.164.0 documenta solo alcune disabilitazioni di capacita per custom agent;
non documenta la rimozione per-agente dei tool di delega. Il divieto del ruolo
non e quindi una sandbox contro un agente che ignora le istruzioni. Le prove
deterministiche verificano le primitive e le istruzioni, non il comportamento LLM.
Vedere [custom agents Codex](https://developers.openai.com/codex/subagents).

## Launcher esterno preservato, non predefinito

Il comando seguente mantiene la modalita precedente, non deve essere invocato
da Sol o dal Curator nel percorso nativo:

```powershell
npm exec --offline -- knownex curate checkpoint --work .knownex/internal/curator
```

Prima il principale eseguiva runtime, prepare, generazione della richiesta,
delega, validate, review e apply in interazioni distinte. Ora il controller Node
esegue queste operazioni deterministiche e restituisce soltanto esito, cutoff,
conteggi disponibili e warning essenziali. Non trasferisce documenti, proposta
o rapporto al contesto di Sol. `runtime --summary` e `validate --summary` restano
interfacce diagnostiche, non passi obbligatori del principale.

Il controller usa recovery e stato runtime esistenti; inizializza soltanto il seed
vuoto quando necessario. `prepare --autonomous` congela base, batch e contratto
con hash in `inputs.json`. Il generatore della richiesta passa riferimenti,
non fonti inline. Il Curator legge il batch completo e sceglie dal catalogo le
Knowledge pertinenti; legge integralmente quelle che modifica. Le altre restano
intatte. Il controller non interpreta né sintetizza semanticamente le fonti.

## Esecuzione del launcher esterno e I/O

Il launcher verifica tramite RPC native read-only autenticazione ChatGPT, provider
corrente, modello/effort economico configurati e disponibilità del Node REPL.
Non aggiunge API key o fallback di provider. Avvia una sola `codex exec --json`
con modello/effort/provider espliciti e sandbox `workspace-write`, dalla directory
scratch del run. Hook del solo worker e ulteriori subagent sono disabilitati;
SessionStart del prodotto non cambia. La directory di lavoro non costituisce
una garanzia di isolamento da strumenti MCP esterni.

Il Curator importa il modulo JavaScript `io.module`, usa `readCurationInput`,
`stateEvidence` e `writeCurationArtifacts` e restituisce soltanto le ricevute
di proposta e review. Nessun writer alternativo o trascrizione di Sol. Da checkout
eseguire prima la build; skill e contratto congelati provengono dalla stessa
distribuzione del runtime. Non mescolare pacchetto installato e working tree.

Il controller attende il processo senza polling LLM, verifica ricevute sui byte
effettivi, esegue validate e applica con il sigillo restituito. `controller.json`
registra la policy prima dell'avvio; `worker-events.jsonl`, `worker-stderr.log`
e `worker.json` conservano evidenze e diagnostica internamente. Il worker non
esegue prepare, validate o apply e non modifica la memoria confermata.

## Policy di pubblicazione e limiti semantici

L'invocazione iniziale autorizza un batch monouso, senza seconda conferma utente.
Con validazione positiva e array `uncertainties` e `anomalies` entrambi vuoti,
il controller applica automaticamente sotto quell'autorizzazione. Qualsiasi voce
blocca la pubblicazione: non esiste classificazione permissiva per gravità o parole
chiave. Il blocco conserva gli artefatti per esame esplicito.

**La review semantica indipendente di Sol viene rimossa dal percorso ordinario.**
Il Curator conserva autoverifica di copertura, confronto storico e continuità critica.
Hash, fonti, intervalli v2, link e validazione strutturale restano obbligatori,
ma non dimostrano pertinenza semantica o assenza di omissioni non dichiarate.
Un rapporto formalmente valido può essere incompleto. Il risultato espone
`CURATOR_SEMANTIC_SELF_REVIEW_ONLY` per rendere visibile questo compromesso.

Un batch già reclamato non rilancia il worker. Gli errori restituiscono codice,
fase, cutoff confermato o null se non verificabile, azione e percorso diagnostico;
nessun dump documentale. Recovery di apply già autorizzato e replay sono idempotenti
e non richiedono deleghe nuove. Un nuovo tentativo richiede nuova invocazione
e ritiro esplicito del vecchio batch dopo la fine del worker. I comandi manuali
prepare/validate/apply restano per eccezioni e legacy, senza conversione dei pending.
Revisioni immutabili, layout, cutoff e journal non cambiano.
