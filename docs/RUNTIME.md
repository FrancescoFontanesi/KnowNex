# Runtime KnowNex

## Comando e input ordinari

La skill e `$knownex-checkpoint`. `prepare --work .knownex/internal/curator` riceve STATE
ed eventi senza richiedere una direttiva o creare `.knownex/directive.md`.
Indicazioni aggiuntive sono facoltative e non sostituiscono le fonti.
Il vecchio nome `$knownex-handoff` non autorizza nuovi batch; resta leggibile per
filtrare amministrazione storica e completare batch gia autorizzati. Journal,
sigilli, consumo singolo e recovery non vengono riscritti dalla rinomina.

## Integrita degli eventi acquisiti

Il feed JSONL degli hook e la fonte autorevole. Runtime, pending e checkpoint
usano soltanto gli eventi registrati e la memoria locale, senza App Server o RPC
alla history Codex. L'identita nativa letta dall'intestazione locale durante la
cattura e metadato di provenienza, non una verifica dei turni attualmente retained.

Prepare congela il batch dopo il cutoff confermato. Complete verifica il feed,
i checksum del cutoff e dell'invocazione, input congelati, ricevute, proposta e
review prima dell'apply sotto il lock esistente. Un'append successiva al cutoff
resta per il prossimo batch; corruzione, troncamento o modifica del prefisso
necessario non autorizzano una pubblicazione. L'invocazione resta monouso.

I metadati storici nativeHistory e nativeThreadId non attivano letture esterne.
Le esclusioni gia registrate nei checkpoint/run restano decisioni congelate:
non vengono rimosse, ricostruite o ampliate consultando Codex. I cursori pending
continuano a verificare feed, cutoff, selezione e paginazione.

Modifiche o eliminazioni retroattive della conversazione non acquisite dagli
hook non sono rilevate automaticamente. La memoria conserva gli eventi registrati,
non una replica certificata della history Codex. La catena SHA-256 verifica
coerenza interna, non completezza, autenticita indipendente o resistenza a chi
controlla sia feed sia metadati del workspace. Nessuna ricostruzione retroattiva.

La recovery completa esclusivamente apply gia autorizzati. Gli hook continuano
a catturare deterministicamente senza LLM; solo l'invocazione esplicita autorizza
la materializzazione. Il checkpoint non richiede un eseguibile Codex nel PATH.

## Lifecycle

| Evento                               | Effetto deterministico                                                                        | LLM     |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | ------- |
| SessionStart, incluso source=compact | Verifica memoria, recovery autorizzata, conteggio pending e STATE selettivo                   | Nessuno |
| UserPromptSubmit                     | Acquisisce prompt nel feed di progetto; nessuna reiniezione STATE                             | Nessuno |
| Stop                                 | Capture originale, commentary verificabile e finale deduplicato; restituisce `{}` al successo | Nessuno |
| SessionEnd                           | Solo Capture originale, entro il timeout esistente                                            | Nessuno |

SessionStart emette integralmente lo STATE confermato in additionalContext,
sia all'avvio sia con source=compact, senza omissioni o troncamenti dimensionali
di KnowNex. Il prefisso dichiara i byte UTF-8 emessi e distingue emissione da
consegna al modello. Non carica HISTORY o Knowledge; il pending rimane selettivo.
La dimensione non vincola prepare, validate, apply, noop o letture legacy.
Errori d'integrita producono un avviso esplicito, mai uno stato misto confermato.

### Confine dell'harness

La [documentazione ufficiale degli hook](https://learn.chatgpt.com/docs/hooks#large-hook-output),
consultata il 2026-11-06, descrive una soglia predefinita approssimativa di 2500
token per ciascun messaggio di output visibile al modello. Oltre soglia Codex puo
salvare il testo completo in un file temporaneo e mostrare un'anteprima con
percorso; se la scrittura fallisce puo rimanere soltanto l'anteprima troncata.
Questa gestione, detta spilling, non e il precedente limite KnowNex di 6144 byte.

Per le versioni compatibili, additionalContextLimit sul command handler configura
il comportamento: 0 richiede il contesto completo direttamente, senza spilling
dimensionale dell'additionalContext. Knownex init imposta questo valore soltanto
sul proprio SessionStart, in configurazione locale del progetto. Non modifica
configurazioni globali o il limite di altri hook. Un aggiornamento gestito tramite
init preserva le modifiche utente secondo i controlli di conflitto esistenti;
workspace non aggiornati possono mantenere il default di Codex.

Non esiste qui una prova di consegna al modello: timeout, approvazione degli hook,
supporto della versione e finestra effettiva del modello restano limiti esterni.
Un contesto molto esteso occupa la finestra disponibile; impostare 0 non la rende
illimitata. La documentazione consiglia cautela per questo motivo. Se Codex
segnala spilling, errore o contesto incompleto, non dichiarare continuita completa.

Il wrapper distribuito `.codex/hooks/session.cjs` usa spawn asincrono e consuma
incrementalmente stdout in byte, senza maxBuffer o altra soglia dimensionale.
Conserva il payload fino a close con exit 0, valida UTF-8, JSON e forma SessionStart,
poi emette gli stessi byte. Non inoltra stderr ne prefissi da processi falliti.
Timeout del figlio: 7,5 secondi, seguito da terminazione e diagnosi SESSION_TIMEOUT;
errori di processo/stream o payload invalidi producono diagnosi distinte.
Una chiusura anticipata di stdout del figlio non basta: servono exit riuscita e
payload completo valido. Se si interrompe il canale verso Codex, il wrapper termina
con errore senza accodare una diagnosi a un payload gia iniziato.
La raccolta e la validazione richiedono memoria proporzionale all'output; limiti
Buffer/string/heap di Node, memoria OS, timeout e problemi del canale rimangono
vincoli tecnici, non soglie di STATE. Un arresto OOM non e sempre intercettabile.
Il wrapper non impone un limite interno di 64 KiB.
Le fixture verificano stdout JSON integro, byte e configurazione, senza un LLM.

La [documentazione ufficiale hooks](https://learn.chatgpt.com/docs/hooks),
consultata il 2026-11-04, supporta PreCompact e PostCompact; i loro output
non forniscono l'iniezione di contesto di SessionStart. SessionStart con
`source=compact` viene eseguito prima della continuazione del modello anche
dopo compattazione automatica. Si riusa questo evento: nessun hook aggiuntivo,
nessun blocco della compattazione, nessuna garanzia di delega LLM a PreCompact.

## Vista temporanea degli eventi acquisiti S4.3

S4/S4.2 espongono gia cutoff e conteggio pending, S4.4 distingue arretrato da
progresso, S4.6 conserva batch falliti ed eventi. Il packet esistente rende leggibile
solo una finestra gia preparata: non copriva il pending senza creare un batch e
consumare una invocazione. La primitiva read-only aggiunta riusa lo stesso feed, lock,
validazione dei frame e checkpoint, senza staging o seconda copia del feed.

STATE e autorevole fino all'ultimo checkpoint confermato; eventi successivi possono
modificare decisioni, risultati, blocker e attivita. SessionStart lo dichiara e
non carica automaticamente il pending. Quando il task richiede continuita:

```powershell
npm exec --offline -- knownex pending --limit 5
npm exec --offline -- knownex pending --from 12 --through 18
npm exec --offline -- knownex pending --cursor TOKEN
# Per una copia locale: aggiungere --workspace PERCORSO.
```

Il default inizia dopo il cutoff, congelando l'estremo della finestra corrente.
I cursori vincolano feed, checkpoint, estremo e checksum del prefisso: nuovi append
non spostano le pagine; un checkpoint cambiato o un prefisso diverso rende il
cursore obsoleto. Intervalli e limiti sono validati; limit default 5, massimo 20.
Ogni risposta JSON, newline compreso, resta entro 16384 byte UTF-8. Eventi lunghi
sono frammentati: textOffset usa unita UTF-16 dichiarate e non separa coppie
surrogate; ricomporre text nello stesso ordine di sequence/textOffset. Nessuna
normalizzazione. complete indica fine finestra, textComplete fine evento;
pendingComplete richiede copertura fino al feed attuale senza coda incompleta.
Questi flag non provano che l'agente abbia letto o compreso le pagine precedenti.
newerEvents e incompleteTailBytes segnalano altro contesto non coperto.

L'ordinamento restituito e quello della sequenza fisica del feed; sessione, turno,
timestamp, identita messaggio e metadati sorgente restano disponibili. Ogni frammento
porta checksum e intervallo byte del frame originale nel file indicato, risolvibile
in .knownex/internal/feed/. Il lungo percorso transcript non viene duplicato nell'output:
sourcePathOmitted lo dichiara; la provenienza completa rimane nel frame originale.
Il backend scansiona il Markdown/feed pertinente con gli helper esistenti; non
introduce un indice e non promette I/O proporzionale alla sola pagina.

La lettura non inizializza curator, non consuma grant e non modifica feed, memoria,
checkpoint, autorizzazione o batch; usa soltanto lock transitori. Se trova un apply da
recuperare, restituisce CURATOR_RECOVERY_REQUIRED senza eseguire recovery. Journal
corrotti bloccano la lettura. Il runtime/navigatore esistente puo completare un
apply gia autorizzato: quella e una fase di storage separata, non riconciliazione.
Si riprende la lettura soltanto con memoria coerente; i feed legacy restano
segnalati e non vengono migrati o ignorati implicitamente.

Il principale usa STATE e le pagine pertinenti per aggiornare solo il proprio
contesto temporaneo. Distingue direttive autorevoli, dichiarazioni, ipotesi e
verifiche; conserva elementi critici finche non esistono giustificazioni pertinenti.
Con STATE non consegnato integralmente o pending esaminato solo in parte dichiara il limite.
Non crea WORKING.md, non delega a Terra e non richiede Si/No per leggere. Una futura
materializzazione permanente richiede una invocazione utente di `$knownex-checkpoint`.

Le fixture sintetiche verificano disponibilita di completamento/supersession da A
in B, recupero dopo No, limiti di STATE e pagine Unicode, append durante lettura,
cursore obsoleto e letture senza cambiamenti ai file confermati o all'autorizzazione.
Le verifiche controllano byte, provenienza, ordine e lifecycle, non comprensione
semantica del modello; quella resta da validare nella simulazione reale.

## Milestone e salvaguardie

Il principale riconosce semanticamente decisioni/supersession, avanzamenti
verificati, cambio di focus, handoff e compattazione imminente significativa.
Segue `knownex-checkpoint`: suggerimento del comando, invocazione utente acquisita, STATE ed eventi, prepare, una delega economica
configurata, review, validate e apply con sigillo. Il workflow editoriale e le
verifiche restano invariati. Nessun checkpoint per turno o per tempo trascorso.

Le salvaguardie deterministiche sono feed/checksum e identita sessione/turno,
checkpoint, cutoff congelato, singolo pending e lock del curator. Un seed vuoto
si inizializza a sequenza zero senza inventare eventi. `readyThrough` indica
l'ultima risposta finale acquisita; non certifica semanticamente completezza o
veridicita del contenuto. I messaggi del turno corrente non ancora acquisiti
restano per un futuro batch. Una sessione abbandonata senza finale conserva i
prompt: il successivo batch puo includerli senza considerarli risultati verificati.

Se manca il curator o fallisce la proposta, il batch e gli eventi rimangono.
Un batch gia attivo non provoca altre deleghe automatiche; nessun retry LLM.
La recovery di un apply gia autorizzato resta deterministica e idempotente.
Un fallimento prima dell'autorizzazione richiede una risoluzione esplicita del
batch; non viene cancellato o sostituito automaticamente per forzare progresso.
Stop non richiede continuazioni, non crea checkpoint e non genera ricorsione.
SessionEnd non puo promettere elaborazione dopo la chiusura.

## Continuita e compatibilita

Nuovi workspace usano solo `.knownex/internal/feed/project.jsonl`: stesso formato di
frame, una sequenza globale e identita native per sessione. Capture resta la
fonte originale, non un secondo archivio creato da S4. Il comportamento API
precedente per feed per-sessione resta disponibile; non viene migrato.

In presenza di journal legacy `<sha256-sessione>.jsonl`, il runtime segnala
`LEGACY_SESSION_FEEDS` e riferimenti risolvibili, preservando tutti i dati.
Non ignora pending precedente e non lo copia in un archivio parallelo.
L'adozione su workspace legacy richiede una revisione esplicita, fuori da S4.
AGENTS.md conserva testo esterno a `knownex:start/end` e aggiorna solo quel
blocco; marker ambigui sono rifiutati. Altri conflitti restano espliciti.

## Evidenza offline e controllo reale residuo

`tests/bootstrap.test.ts` normalmente copia il payload compilato in un workspace
temporaneo esterno. S5 usa la stessa fixture con l'archivio npm realmente installato
offline, includendo reinstallazione e aggiornamento delle risorse S3. In entrambi
i percorsi nega ai processi runtime
l'accesso ai sorgenti. Verifica hook/skill/politica, contesto limitato, A→B con
pending, Stop ripetuto, inizializzazione zero, proposta invalida, apply/recovery,
replay senza HISTORY duplicata, checkpoint tra sessioni, bootstrap idempotente,
blocco legacy e rifiuto di memoria alterata. Le suite esistenti verificano gli
altri confini di acquisizione e recovery. Sono payload sintetici, senza LLM.

In una futura chat reale: approvare gli hook; verificare contesto SessionStart,
milestone riconosciuto senza nominarlo, disponibilita del curator economico e
una sola delega valida; chiudere A con pending e riprendere in B; verificare
anche la ripresa dopo compact. Non eseguire questi controlli come parte di S4.
La selezione effettiva delle skill e il comportamento semantico dell'agente
non sono dimostrati dai test offline. La durabilita fisica resta soggetta ai
limiti gia documentati in [Storage](STORAGE-DURABILITY.md).

## Turni amministrativi

I turni del comando puro `$knownex-checkpoint` sono esclusi dalla vista operativa:
comando, passaggi intermedi e finale nello stesso sessionId/turnId. Il feed rimane
integrale; pendingRaw e administrativePending espongono i conteggi originali.
Pending e packet non includono questi turni, senza avanzare il checkpoint.
Per leggere gli originali usare `knownex pending --include-administrative`.
I cursori mantengono fisso il filtro. Invocazioni con argomenti e vecchie risposte
Si/No restano visibili per prudenza; nessun filtro generico su tag o parole.

## Coordinamento senza rilettura di STATE

`knownex runtime --summary` esegue gli stessi controlli di runtime e restituisce
metadati, pending e autorizzazione senza il campo state. Il percorso ordinario
e SessionStart restano invariati: questa opzione serve al coordinamento della
[curatela autonoma](CURATION-WORKFLOW.md), non modifica il cold start.
