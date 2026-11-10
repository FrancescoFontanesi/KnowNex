# R2 — Intermedi Codex

L'adattatore `src/commentary.ts` legge uno snapshot verificato tramite il reader
S1 durante Stop, senza modificare la sorgente o mantenere un altro cursore.
Seleziona esclusivamente `response_item` con `payload.type = message`, ruolo
`assistant`, fase `commentary` e parti `output_text` testuali. Il testo concatena
le parti nell'ordine originale senza separatori aggiunti. Non interpreta reasoning,
tool, `event_msg/agent_message`, `item_completed` o risposte finali del transcript.
La selezione è limitata al turno dichiarato dal payload Stop.

## Identità e provenienza

La sessione deve coincidere con `session_meta.payload.session_id`/`id`.
Con retained metadata servono `complete: true`, ruolo assistant e `turn_id`;
`message_id` e `payload.id`, quando entrambi presenti, devono coincidere.
In assenza di retained metadata si accettano soltanto file esplicitamente
`history_mode: legacy`, un `turn_context.turn_id` precedente e messaggi con ID
e stato `completed`. Compattazione, fine turno e nuovo session_meta azzerano
l'associazione contestuale, anche all'inizio di un nuovo turno. Gli altri casi rimangono esclusi con diagnostico;
non si inventano ID o appartenenze di turno. Un file senza identità di sessione
o con sessione differente è rifiutato.

Il feed aggiunge `assistant_commentary`, `messageId` e `source`: percorso del
transcript, identità filesystem, hash dello snapshot completo, offset/lunghezza
in byte e SHA-256 della riga originale senza LF, tipo di associazione al turno,
ordinal e revisione retained quando disponibili. Il testo originale resta nel
feed; questi riferimenti permettono il confronto con sorgente o record raw del
backup S1. Non promettono che il percorso sorgente conservi per sempre la stessa
rappresentazione dopo una riscrittura.

Il writer e il lock rimangono quelli del feed S2.1. L'identità degli intermedi
è tipo/sessione/turno/messageId. Un replay identico non scrive; testo divergente
per quell'identità causa FEED_CONFLICT senza sostituire il messaggio. Identità
diverse restano distinte anche con testo uguale. Una riscrittura legacy/paginated
non viene deduplicata per testo, timestamp o posizione. Se gli ID cambiano, i
messaggi restano distinti: non è dimostrata una corrispondenza semantica.

## Finestra pendente

La sequenza fisica è sempre l'ordine di acquisizione. `prepare` mantiene il cutoff
e il checkpoint R1 fisici, ma presenta ogni gruppo contiguo dello stesso turno
come utente, intermedi, finale. Gli intermedi dello stesso snapshot seguono gli
offset originali. Fra snapshot differenti conserva l'ordine di acquisizione e
segnala COMMENTARY_ORDER_AMBIGUOUS; non confronta ordinal di rappresentazioni
diverse. Turni intercalati producono TURN_ORDER_AMBIGUOUS senza spostare interi
turni. Eventi arrivati dopo la materializzazione parziale del turno producono
TURN_PARTIALLY_MATERIALIZED: gli eventi confermati non vengono ripresentati e
non si riscrive la memoria passata.

`packet.json` e `WINDOW.md` sono proiezioni rigenerabili del feed. Le etichette
E rimangono le sequenze fisiche, anche quando la presentazione le riordina.
STATE, HISTORY e Memory Contract R1 restano invariati. L'invocazione del curator
rimane sotto il controllo del principale.

## Limiti e verifiche

Un solo scan selettivo per Stop; la lettura integra è O(dimensione transcript),
il writer esistente verifica il feed a ogni append. Nessun watcher o polling.
Timeout e concorrenza restano quelli dell'hook: gli errori sono osservabili e
richiedono un replay, senza promessa di recupero eventuale automatico.
La cattura del finale nativo e Capture S1 restano indipendenti dagli errori degli
intermedi. Una coda JSONL incompleta non produce eventi; il replay del medesimo
Stop dopo il completamento permette di recuperarla, senza inventare testo.

Le fixture coprono due intermedi con testo uguale e ID distinti, testo Unicode
esatto, provenienza a byte, esclusione dei record tecnici, replay, conflitti,
identità mancanti, sostituzione legacy/paginated, ordine pending e checkpoint R1.
La sola presenza nel JSONL non prova la visibilità nell'interfaccia VS Code.

## Prova reale VS Code — 3 novembre 2026

Una chat sacrificabile produce automaticamente un messaggio utente, due
intermedi e un finale, nello stesso turno. L'utente conferma di vedere entrambi
gli aggiornamenti R2-INTERMEDIO-1/2 e il finale. I testi acquisiti coincidono
esattamente con i record output_text originali, inclusi i prefissi AXIOM; gli ID
retained/payload coincidono. Gli offset e gli hash delle righe trovano riscontro
anche nei raw del backup Capture S1. Reasoning e chiamate/risultati dei tool sono
presenti nella sorgente di prova e assenti dagli eventi del feed.

Il replay dello Stop aggiunge zero eventi e lascia il feed identico byte per
byte. La proiezione dei quattro eventi mantiene utente, due intermedi, finale.
Una prepare reale su memoria di prova con checkpoint iniziale 1 include i tre
eventi dell'assistente successivi: il messaggio utente è già rappresentato nel
seed. Le fixture verificano separatamente tutti e quattro i messaggi nella
finestra pending, il riordino di un finale acquisito prima degli intermedi e il
successivo avanzamento del checkpoint senza replay degli eventi confermati.
Le evidenze storiche `r2-validation` sono archiviate fuori dal repository;
la posizione locale e indicata in `.local/ARCHIVE.md`.

Dopo Reload Window e ripresa della stessa chat, Codex sostituisce realmente il
transcript da legacy a paginated. I due ID messaggio e i turni retained restano
identici; cambiano offset e ordinal. Il replay sulla nuova rappresentazione
aggiunge zero record, mantenendo i riferimenti originali nel feed. Il nuovo turno
senza intermedi aggiunge soltanto utente e finale: sei eventi totali, sempre due
commentary. I prefissi precedenti di feed e Capture restano identici; la catena
Capture conserva 36 record nella prima generazione e 54 nella seconda, senza
equiparare questi record fisici a eventi logici unici.

La prepare già pendente resta congelata alle sequenze 2–4 nonostante l'arrivo di
5–6. Una conferma noop nella sola memoria di prova avanza il checkpoint a 4 senza
toccare STATE o HISTORY; la prepare successiva include soltanto 5–6. La memoria
R1 originale resta invariata. La verifica completa passa con 78 test, typecheck,
Prettier e build; dev e start funzionano. La visibilità è confermata dall'utente,
non da una lettura automatica della UI.

In questa chat di lavoro si osserva anche un UserPromptSubmit riemesso con lo
stesso turno e contenuto differente: FEED_CONFLICT preserva il messaggio
precedente. È il vincolo d'identità nativo S2.1, mantenuto da R2; non si promette
la cattura di ulteriori input con la stessa identità. La conversazione prosegue.
