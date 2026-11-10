# Checkpoint manuale e autorizzazione del batch

Il principale suggerisce `$knownex-checkpoint` ai milestone significativi e continua
il task. Non pone una domanda Si/No, non attende risposte e non materializza
in conseguenza del proprio suggerimento. Nessuna classificazione del consenso,
lista di risposte, watcher, scheduler o delega periodica.

## Avvio esplicito

L'utente invoca la skill in chat con `$knownex-checkpoint`, eventualmente seguito da
una direttiva. La CLI accetta anche il link nativo Codex alla stessa skill del
workspace. L'evento deve essere un UserPromptSubmit acquisito nel feed, nel turno
ancora aperto. Il comando deve iniziare il messaggio: citazioni, blocchi di codice,
menzioni descrittive o link a skill fuori dal progetto non autorizzano.
L'involucro IDE osservato con Open tabs e `## My request:` viene riconosciuto
strutturalmente. Non si cercano assensi dentro testi arbitrari.

L'invocazione autorizza un solo batch, senza un altro scambio di conferma.
La CLI non decide se il milestone sia significativo: questa responsabilita resta
del principale. Il feed originale e la sua provenienza rimangono intatti.

## Delega ordinaria del principale

Il principale esegue `curate native --stage prepare` con il riferimento
`captured-user-invocation`, delega una sola volta a `knownex_curator` (Terra medium)
con workspace e requestFile in modalita materialize-only, poi attende le ricevute.
Non invoca il launcher esterno `curate checkpoint`.

Sol esegue `curate native --stage complete` con le ricevute tramite il runtime
Node locale; il percorso nativo non avvia modelli. Le primitive verificano
ricevute e validano. Con rapporto valido e senza uncertainties/anomalies applicano
sotto l'invocazione iniziale monouso: non richiede un secondo assenso. Non esiste
review semantica indipendente di Sol in questo percorso; autoverifica del Curator
e validazione strutturale non provano completezza semantica. Ogni segnalazione
blocca l'applicazione automatica e conserva la diagnostica. Nessun retry worker
automatico; il replay puo soltanto completare un apply gia autorizzato.

## Comandi manuali per eccezioni e legacy

```powershell
knownex runtime
# Solo al primo uso, con runtime non inizializzato:
knownex curate init --work .knownex/curator --memory .knownex/seed --feed .knownex/feed/project.jsonl --through 0
knownex curate prepare --work .knownex/curator
# Una delega single-pass, review semantica, poi:
knownex curate validate --work .knownex/curator
knownex curate apply --work .knownex/curator --confirm SIGILLO
```

`prepare` congela il cutoff all'ultimo finale acquisito prima dell'invocazione.
Non puo includere l'invocazione o eventi successivi; un `--through` diverso viene
rifiutato. Il pending dopo il cutoff resta disponibile per un altro salvataggio.

Il journal di autorita del feed `<feed>.curator.json`, gia esistente, conserva
il workspace proprietario e l'ultima invocazione consumata: sequenza, checksum,
run e cutoff. Non e un registro di domande/risposte. Il run conserva il riferimento
all'evento utente. Consumo e proprieta vengono verificati sotto lock prima dello
staging; un altro workspace curator non puo riusare la stessa invocazione.

Una prepare ripetuta puo restituire lo stesso batch congelato; non autorizza una
nuova delega. La stessa invocazione non puo generare un altro run dopo errore o
ritiro. Apply controlla l'autorizzazione del run e il sigillo; il journal `apply.json`
conserva il protocollo di recovery esistente. Il suo replay e idempotente e non
duplica HISTORY. Le API legacy per feed diversi da project.jsonl conservano la
responsabilita esplicita del chiamante; la CLI impone sempre l'invocazione acquisita.

## Fallimento e ripresa

Delega fallita, JSON invalido, review rifiutata o errore prima di apply conservano
pending e staging. Con storage coerente il lavoro puo continuare. Per ritentare,
l'utente invoca nuovamente la skill; terminata la delega precedente, il principale
ritira l'eventuale batch non confermato:

```powershell
knownex curate abandon --work .knownex/curator --run ID
```

Il ritiro non rinnova l'invocazione consumata e non cancella gli eventi. Una recovery
obbligatoria viene eseguita prima: un apply gia autorizzato puo essere completato
senza invocazione nuova. Evidenze incomplete o corrotte bloccano ogni nuovo batch.
Nessun reset, ritiro forzato o retry LLM automatico.

## Amministrazione e aggiornamento

Il feed originale conserva comando, passaggi intermedi e report: cancellarne righe
invaliderebbe sequenze, checksum e checkpoint. La vista operativa esclude invece
l'intero turno di una invocazione pura (solo comando o link nativo), identificato
con sessione e turno: messaggio utente e messaggi assistant_commentary/final.
Non vengono esclusi eventi di altre sessioni o turni intercalati.

`runtime.pending` conta gli eventi operativi, `pendingRaw` quelli originali e
`administrativePending` gli esclusi. Il cutoff confermato non viene anticipato per
svuotare una coda amministrativa. Prepare omette gli stessi turni dal packet e da
WINDOW, dichiarandone il conteggio, e usa un finale operativo come cutoff.

`knownex pending` usa la vista filtrata; `--include-administrative` permette
l'ispezione read-only degli originali. I cursori versione 2 congelano anche la
vista; non possono essere riutilizzati cambiando filtro. Provenienza e sequenze
fisiche restano quelle del feed. I messaggi di invocazione con argomenti rimangono
visibili, per non scartare eventuali direttive o fatti nuovi. Limitare il turno di
un comando puro al solo handoff; i dettagli restano comunque recuperabili dal feed.
Le vecchie conversazioni Si/No non vengono riclassificate per parole o cancellate.

## Proposta Unicode e artifact

Il curator scrive direttamente proposal.json con un tool filesystem strutturato
(Node REPL fs.writeFile UTF-8, creazione esclusiva, o apply_patch); niente pipe
PowerShell/Python/Node, redirezioni o JSON ricopiato dal principale. Restituisce
percorso e SHA-256 dei byte scritti. Se manca il tool adatto, si ferma senza
fallback o retry. Validate rifiuta UTF-8 invalido, espone `proposalSha256` per il
confronto con la ricevuta e apply blocca modifiche successive del file.

Non si ricostruiscono caratteri perduti con euristiche. Un punto interrogativo
ASCII e testo valido: l'integrita UTF-8 da sola non prova che il trasporto precedente
non abbia sostituito caratteri. La pipeline precedente con pipe ASCII e stata
riprodotta e localizzata; il nuovo percorso strutturato evita quel confine.

Il principale deve passare `--artifacts` per i file che la memoria richiamera.
Il curator usa link Markdown relativi alle destinazioni autorizzate, non percorsi
nudi o tra backtick. Le citazioni testuali riconosciute di artifact autorizzati
senza il corrispondente link nel documento sono rifiutate con
`CURATOR_ARTIFACT_LINK_REQUIRED`. Un artifact non autorizzato richiede di segnalare
il contesto mancante, senza inventare destinazioni o aggirare i controlli.

La vecchia politica e rimossa: non esistono piu domanda registrata, decisione
semantica dell'assenso, `curate request`, `curate consent`, `curate report` o CLI
`checkpoint`. I vecchi file consent.json sono preservati ma non letti e non danno
autorizzazioni. I batch precedenti senza invocazione collegata non sono promuovibili;
possono essere ritirati conservativamente. Gli apply gia pubblicati restano
recuperabili attraverso il journal, senza un secondo protocollo di consenso.

I test deterministici verificano origine, cutoff, monouso, fallimenti, replay,
provenienza e conservazione degli eventi. Non dimostrano il riconoscimento
semantico dei milestone o la comprensione del curator in una sessione reale.
