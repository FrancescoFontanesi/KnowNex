# Preparazione esplicita e pubblicazione del checkpoint

## Trigger operativo

L'invocazione esplicita del comando prepare, da una skill o da un chiamante
autorizzato nell'ambiente di esecuzione, prepara il batch. Il runtime non cerca
un permesso nel feed: non richiede $knownex-checkpoint, un messaggio utente
come ultimo evento, un finale assistant o un hook specifico di Codex.
La skill nativa mantiene il proprio ingresso esplicito dell'utente e non avvia
checkpoint automaticamente. Non esiste un token di consenso sostitutivo.

## Congelamento

Prepare legge il registro verificato sotto il lock del Curator e fissa il cutoff
prima di produrre gli input. Per default usa l'ultimo evento acquisito non
amministrativo; un cutoff esplicito deve essere entro il prefisso gia acquisito
e non puo precedere il checkpoint confermato. Le invocazioni pure della skill
e i relativi turni amministrativi restano nel feed, ma non sono conoscenza.
Le richieste con contenuto aggiuntivo non vengono nascoste come amministrazione.

Il run contiene packet.json, WINDOW.md, inputs.json, snapshot base/ della
memoria e skill congelati. Il manifest registra byte e SHA-256 degli input;
il run conserva l'hash del manifest. Anche un batch senza review autonoma
riceve il manifest e viene verificato prima della pubblicazione.

Il risultato identifica run, cutoff e percorsi. Un prepare ripetuto restituisce
lo stesso batch attivo e gli stessi input, non una nuova autorizzazione a delegare.
Richieste concorrenti sono serializzate o rifiutate dai lock esistenti; il binding
del feed impedisce a un secondo workspace Curator di utilizzarlo indipendentemente.
Un batch vuoto non richiede curatela. Una preparazione fallita non consuma un
messaggio del feed; una nuova esecuzione esplicita puo riprovare. Un batch gia
attivo deve essere completato o ritirato esplicitamente.

## Conversazione concorrente

Gli hook possono continuare ad appendere eventi mentre staging e curatela sono
in corso. Questi eventi non entrano nel packet e non modificano manifest o snapshot.
Non viene creata una copia completa del feed: il packet contiene il solo batch
selezionato e i riferimenti alle sequenze fisiche originali.

Il percorso del feed resta un riferimento di provenienza. Il lettore canonico
del Curator non lo espone come documento live: gli eventi del batch si leggono
dal packet congelato, evitando di includere append successivi.

## Complete, apply e recovery

Complete verifica consegna, manifest, input e review (v3; v1/v2 per run gia scritti); anomalie o incertezze
bloccano la pubblicazione automatica. Apply richiede il sigillo di validazione,
verifica il checkpoint di base e il checksum del prefisso al cutoff sotto lock,
poi registra l'intent transazionale prima di promuovere i file.
Un feed cresciuto e ammesso; un prefisso modificato o troncato non lo e.
Gli eventi dopo il cutoff restano pending per il prossimo checkpoint.

Recovery e replay usano lo stesso journal sigillato e non rilanciano il Curator.
Restano invariati revisioni immutabili, validazione della provenienza e confini
di scrittura. Gli hash controllano coerenza e modifiche osservabili, non
certificano autenticita contro un processo che controlla l'intero workspace.

## Perimetro della prima milestone

La preparazione e indipendente da provider e orchestratore. Il percorso nativo
mantiene ancora la skill Codex, la delega knownex_curator, le ricevute canoniche
e il controller prepare/complete; il launcher esterno Codex e stato rimosso.
Non sono introdotti nuovi worker, provider, adapter, daemon o installer.
