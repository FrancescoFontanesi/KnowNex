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

Il comando prepare esplicito e il trigger operativo, indipendentemente dal feed.
Il runtime congela gli eventi gia acquisiti e gli snapshot prima della curatela.
I messaggi amministrativi identificabili sono esclusi; non serve un finale
assistant o un formato Codex per preparare il batch. Complete verifica il run,
le ricevute e il prefisso al cutoff: gli append successivi sono per il prossimo batch.

Sol trasmette soltanto workspace, run ID, `requestFile`, percorso della skill e
`workerMode: materialize-only`. Terra legge autonomamente la richiesta e il batch
congelato, esegue tutta la curatela e restituisce le ricevute dell'I/O canonico.
Non esegue primitive di checkpoint o App Server. Sol passa il solo run ID
a complete. Questa primitiva legge proposta e review dal run e riusa validate, policy sulle
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
percorsi condividono la stessa funzione di pubblicazione e le garanzie
transazionali; la review e v3 (v1/v2 solo per run gia scritti). Nessuna review semantica indipendente di Sol.

Il ruolo vieta ulteriori deleghe e il runtime nativo non possiede un launcher.
Codex 0.164.0 documenta solo alcune disabilitazioni di capacita per custom agent;
non documenta la rimozione per-agente dei tool di delega. Il divieto del ruolo
non e quindi una sandbox contro un agente che ignora le istruzioni. Le prove
deterministiche verificano le primitive e le istruzioni, non il comportamento LLM.
Vedere [custom agents Codex](https://developers.openai.com/codex/subagents).

## I/O del Curator

Il Curator usa la CLI indicata in io.cli per leggere gli input congelati e consegnare
proposta e review; restituisce soltanto le ricevute. La CLI riusa le primitive
canoniche, senza writer alternativo o trascrizione del chiamante. Da checkout
eseguire prima la build; skill congelata e runtime provengono dalla stessa
distribuzione. Non mescolare pacchetto installato e working tree.

## Policy di pubblicazione e limiti semantici

Il comando prepare esplicito crea un batch congelato; apply richiede il suo sigillo.
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
