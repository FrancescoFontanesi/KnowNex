# Runtime autonomo S4

S4.2 aggiunge [consenso binario utente](CHECKPOINT-CONSENT.md) prima della
materializzazione proposta dal principale: la politica non autorizza piu
implicitamente i checkpoint. Gli hook restano deterministici e non chiedono
conferme ne invocano LLM.

La release candidate S5 distribuisce il payload S4–S4.6 aggiornato;
`knownex init` installa la politica locale;
nessuna configurazione globale. Avviare Codex dalla radice del workspace e
approvare gli hook quando richiesto. Non occorre chiedere cosa preservare.

## Lifecycle

| Evento                               | Effetto deterministico                                                                        | LLM     |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | ------- |
| SessionStart, incluso source=compact | Verifica memoria, recovery autorizzata, conteggio pending e STATE selettivo                   | Nessuno |
| UserPromptSubmit                     | Acquisisce prompt nel feed di progetto; nessuna reiniezione STATE                             | Nessuno |
| Stop                                 | Capture originale, commentary verificabile e finale deduplicato; restituisce `{}` al successo | Nessuno |
| SessionEnd                           | Solo Capture originale, entro il timeout esistente                                            | Nessuno |

SessionStart include STATE solo se intero entro 6144 byte UTF-8; oltre tale
limite indica il percorso e rimanda a recall. Non carica HISTORY/Knowledge nel
contesto del modello. `knownex runtime` espone pending, through, latest,
readyThrough, activeRun e percorso della memoria. Errori d'integrita producono
contesto di avviso, mai un albero misto accettato come confermato.

La [documentazione ufficiale hooks](https://learn.chatgpt.com/docs/hooks),
consultata il 2026-11-04, supporta PreCompact e PostCompact; i loro output
non forniscono l'iniezione di contesto di SessionStart. SessionStart con
`source=compact` viene eseguito prima della continuazione del modello anche
dopo compattazione automatica. Si riusa questo evento: nessun hook aggiuntivo,
nessun blocco della compattazione, nessuna garanzia di delega LLM a PreCompact.

## Riconciliazione temporanea S4.3

S4/S4.2 espongono gia cutoff e conteggio pending, S4.4 distingue arretrato da
progresso, S4.6 conserva batch falliti ed eventi. Il packet esistente rende leggibile
solo una finestra gia preparata: non copriva il pending senza creare un batch e
consumare consenso. La primitiva read-only aggiunta riusa lo stesso feed, lock,
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
in .knownex/feed/. Il lungo percorso transcript non viene duplicato nell'output:
sourcePathOmitted lo dichiara; la provenienza completa rimane nel frame originale.
Il backend scansiona il Markdown/feed pertinente con gli helper esistenti; non
introduce un indice e non promette I/O proporzionale alla sola pagina.

La lettura non inizializza curator, non consuma grant e non modifica feed, memoria,
checkpoint, consenso o batch; usa soltanto lock transitori. Se trova un apply da
recuperare, restituisce CURATOR_RECOVERY_REQUIRED senza eseguire recovery. Journal
corrotti bloccano la lettura. Il runtime/navigatore esistente puo completare un
apply gia autorizzato: quella e una fase di storage separata, non riconciliazione.
Si riprende la lettura soltanto con memoria coerente; i feed legacy restano
segnalati e non vengono migrati o ignorati implicitamente.

Il principale usa STATE e le pagine pertinenti per aggiornare solo il proprio
contesto temporaneo. Distingue direttive autorevoli, dichiarazioni, ipotesi e
verifiche; conserva elementi critici finche non esistono giustificazioni pertinenti.
Con STATE omesso per dimensione o pending esaminato solo in parte dichiara il limite.
Non crea WORKING.md, non delega a Terra e non richiede Si/No per leggere. Una futura
materializzazione permanente continua a richiedere S4.2.

Le fixture sintetiche verificano disponibilita di completamento/supersession da A
in B, recupero dopo No, limiti di STATE e pagine Unicode, append durante lettura,
cursore obsoleto e letture senza cambiamenti ai file confermati o al consenso.
Le verifiche controllano byte, provenienza, ordine e lifecycle, non comprensione
semantica del modello; quella resta da validare nella simulazione reale.

## Milestone e salvaguardie

Il principale riconosce semanticamente decisioni/supersession, avanzamenti
verificati, cambio di focus, handoff e compattazione imminente significativa.
Segue `knownex-handoff`: proposta con Si/No acquisito, direttiva breve, prepare, una delega economica
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

Nuovi workspace usano solo `.knownex/feed/project.jsonl`: stesso formato di
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
