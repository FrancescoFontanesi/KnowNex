# Checkpoint e curatela

## Comando `knownex checkpoint`

```powershell
npm exec --offline -- knownex checkpoint --codex -m gpt-6.1-sol -r medium
npm exec --offline -- knownex checkpoint --claude -m claude-opus-5-5 -r high
```

Il comando esegue prepare, avvia una sessione non interattiva e non persistita del
provider (`codex exec --ephemeral -s read-only` o `claude -p --no-session-persistence`)
con `KNOWNEX_CAPTURE=0`, cosi la curatela non entra nel feed. La sessione ha un
contesto minimo: istruzioni di sistema del provider sostituite da una riga, niente
AGENTS.md o CLAUDE.md del progetto, skill, plugin, multi-agent e nessuno strumento,
shell e server MCP compresi (Codex con override `-c`, e i server MCP spenti uno per
uno dopo `codex mcp list --json`, perche i loro nomi dipendono dal config utente;
Claude con `--safe-mode`, `--strict-mcp-config`, `--system-prompt` e `--tools ""`).
Senza strumenti la sessione non puo diventare piu chiamate al modello. Il contesto fisso scende
da circa 22k a 4k token con Codex e da 47k a 3k con Claude; resta solo
l'eventuale `~/.codex/AGENTS.md` globale, che Codex carica dalla sua home. Su stdin passa
l'intero compito in un solo messaggio: skill, WINDOW.md e STATE congelato, senza
catalogo delle note esistenti. Le note esistenti non si riscrivono ne si leggono: per
superarne una il modello copia il suo link dallo STATE (percorso dalla radice della
memoria, valido sia nel nuovo STATE sia in una nota nuova). Le note nuove si chiamano
`knowledge/<nome>.md` e il runtime le colloca in `knowledge/H000NNN/<nome>.md`, con
l'id HISTORY del checkpoint: il nome puo ripetersi tra checkpoint. Il modello risponde con un unico
JSON (proposta, STATE, note, rapporto) in una sola chiamata, invece di una
chiamata per ogni passo con strumenti: ogni chiamata ripaga il contesto fisso del
provider. Il comando scrive la bozza e la valida come `curate write`; se viene
rifiutata ripropone l'incarico una volta con il codice d'errore. Se invece la bozza
e valida ma il rapporto dichiara incertezze o anomalie, la seconda chiamata e mirata:
passa solo i punti bloccanti, gli eventi del batch che citano (tutto WINDOW.md se non ne
citano) e la risposta precedente, senza skill e STATE. Il modello risponde con
le sole chiavi che cambiano (di solito `review`) e il comando le fonde sulla risposta
precedente; toglie solo i punti risolti dalle fonti o gia registrati in memoria come
problema aperto. Se la revisione non e interpretabile o viene rifiutata resta la prima
consegna, con esito `BLOCKED`. Le chiamate restano al massimo due. Il messaggio finale e il consumo si leggono dall'output strutturato del
provider (`codex exec --json`, `claude -p --output-format json`); la risposta grezza
resta in `session.log` nel run. Poi esegue complete e stampa solo l'esito
(`SUCCESS`, `BLOCKED`, `ERROR` con codice) con `tokens`: input (cache compresa),
cached, output e reasoning di tutti i tentativi. Con `BLOCKED` l'esito riporta i
punti che bloccano (`blocking`), il rapporto da leggere (`review`) e due comandi pronti in `next`: `curate apply
--confirm <sigillo>` per pubblicare la proposta cosi com'e, `curate abandon` per
scartarla e riportare gli eventi nel pending. Modello e reasoning sono
passati invariati al provider. Un secondo avvio mentre uno e in corso restituisce
`CHECKPOINT_BUSY`; una sessione fallita senza consegna restituisce
`CHECKPOINT_PROVIDER_FAILED` e lascia il batch ripetibile.

## Prepare, batch e risultato

Il comando prepare e il trigger operativo, indipendentemente dal feed. Il runtime
congela gli eventi gia acquisiti e gli snapshot prima della curatela. I messaggi
amministrativi identificabili sono esclusi; non serve un finale assistant o un
formato Codex per preparare il batch. Complete verifica il run, le ricevute e il
prefisso al cutoff: gli append successivi sono per il prossimo batch.

Prepare e complete verificano il feed acquisito e il binding del batch, senza
App Server, history Codex, bridge o ampliamento dei permessi. I turni originali
modificati retroattivamente fuori dal feed non sono una fonte di invalidazione:
vale il compromesso esplicito del MEMORY-CONTRACT.

Il runtime si invoca con `npm exec --offline -- knownex ...`. Un runtime assente
e un errore bloccante, non una richiesta di ricerca npm/npx.

Il risultato conclusivo di complete e un oggetto `SUCCESS`, `BLOCKED` o `ERROR`,
con cutoff, conteggi disponibili, codice/fase, diagnostica essenziale e
riferimenti agli artefatti interni. Non contiene documenti. Qualsiasi
incertezza/anomalia dichiarata blocca l'applicazione automatica. Comando e percorso
manuale (`curate prepare/validate/apply/write/complete --run`) condividono la
stessa funzione di pubblicazione e le garanzie transazionali; la review e v4,
con ogni evento del batch in `sources` o in `ignored` (v1-v3 solo per run gia scritti).
`curate write` accetta solo note nuove: le Knowledge sono un diario di bordo, la
verità attuale è nelle note linkate da STATE e le precedenti mostrano l'evoluzione.

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

**Non esiste una review semantica indipendente nel percorso ordinario.**
Il Curator conserva autoverifica di copertura, confronto storico e continuità critica.
Hash, fonti, intervalli v2, link e validazione strutturale restano obbligatori,
ma non dimostrano pertinenza semantica o assenza di omissioni non dichiarate.
Un rapporto formalmente valido può essere incompleto: il risultato non lo segnala
con alcun avviso, perché un avviso sempre presente non informa.

Un batch già reclamato non rilancia la sessione. Gli errori restituiscono codice,
fase, cutoff confermato o null se non verificabile, azione e percorso diagnostico;
nessun dump documentale. Recovery di apply già autorizzato e replay sono idempotenti
e non richiedono nuove sessioni. Un batch BLOCKED si esamina con `curate validate`
e, solo dopo revisione esplicita, `curate apply --confirm`; un nuovo tentativo
richiede il ritiro esplicito del vecchio batch (`curate abandon`) dopo la fine della
sessione. I comandi manuali restano per eccezioni e legacy, senza conversione dei pending.
Revisioni immutabili, layout, cutoff e journal non cambiano.
