# V2.2 — Recall selettivo

La [skill knownex-recall](../.agents/skills/knownex-recall/SKILL.md) guida il
principale attraverso i comandi R4 esistenti. Non aggiunge codice, indici o
orchestrazione. La riduzione del consumo LLM rimane **non dimostrata**.

## Evidenze consultate e regole corrispondenti

Sono stati consultati soltanto report, metadati delle chiamate e parti pertinenti
dei riepiloghi; nessun transcript completo o nuovo benchmark agentico.

| Evidenza locale                                                   | Osservazione                                                                                                                                                                                                                            | Regola della skill                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `.local/r4-validation/trial-1-calls.jsonl` e `verification.json`  | 17 chiamate, STATE due volte, lettura di tutti e tre i Knowledge; cinque documenti aperti. Il secondo trial selettivo usa 8 chiamate e due documenti, ma ha una risposta meno completa.                                                 | STATE una volta, riuso del contesto, lettura dei soli ID necessari senza sacrificare i fatti richiesti.         |
| `.local/v0.2-single-pass/evidence/navigation.jsonl` e `REPORT.md` | 20 chiamate/53.250 byte, 11 operazioni distinte: STATE ripetuto, H000004–H000006 e due note riletti. `find export` e `find Catalogo` individuano le stesse note.                                                                        | Non ripetere letture o ricerche equivalenti quando i risultati sono già disponibili.                            |
| `.local/v1-index-pilot/diagnosis.json` e `REPORT.md`              | Compressione/troncamento contribuiscono alle riletture; ricerca RAM vuota non dimostra un difetto semantico. Metadati della transizione e STATE archiviato possono confondere la cronologia. Indice ritirato, beneficio non dimostrato. | Gestire il limite del trasporto, fermare riformulazioni prive di indizi e distinguere storia da stato corrente. |

Queste osservazioni motivano le istruzioni; i trial precedenti hanno condizioni
diverse e non misurano l'effetto causale della nuova skill.

## Verifiche deterministiche

Validare frontmatter, nome e assenza di placeholder con il validatore di
`skill-creator`; verificare anche il limite di 50 righe. `npm run check` copre
la CLI e i test R4: STATE, ranking stabile, massimo cinque risultati, filtri,
risoluzione degli ID, contenuti selettivi, assenze ed errori, byte e mtime invariati
sulla fixture standalone. I test curator coprono inoltre lock e recovery V2.1.

Esito V2.2: skill valida, 44 righe; `npm exec --offline --yes -- knownex memory
--help` conferma la sintassi documentata. `npm run check` passa con 113 test,
typecheck, controllo formato e build. Nessun sorgente applicativo modificato.

Limiti osservati: `find` esegue una scansione lineare; `read` restituisce l'intera
nota o segmento selezionato, senza limite globale di byte. La skill riduce le
letture richieste, non il costo delle scansioni interne né la dimensione di un
singolo documento. Non si modifica il navigatore per questi limiti.

La protezione V2.1 dei workspace, tramite `withConfirmedMemory` e `stateAt`, legge
anche feed e albero completo per verificarne l'integrità e può completare un apply
autorizzato. Quindi le affermazioni R4 «state legge soltanto STATE» e «navigazione
senza scritture» descrivono le directory standalone, non ogni workspace V2.1.
Questo limite preesistente è documentato qui; correggerlo esula da V2.2.

## Confronto futuro minimo — non eseguito

1. Riutilizzare senza modifiche le cinque domande di
   `.local/r4-validation/questions.json` e l'oracolo in
   `.local/r4-validation/oracle.json`. Usare la memoria R3 indicata da
   `verification.json`. Sigillare con hash domande, oracolo, corpus, skill e build;
   non mostrare l'oracolo all'agente e non riscriverlo in base alle risposte.
2. Preparare due copie standalone identiche della sola memoria confermata,
   verificandone gli hash, fuori da workspace con recovery. Stesso modello,
   configurazione, trasporto non compresso e limiti per entrambe le condizioni.
   Un contesto nuovo per condizione riceve tutte e cinque le domande nello stesso
   ordine, così il riuso è osservabile; B riceve anche la skill, A no.
   Nessun feed, documento originale o storico agentico come scorciatoia.
3. Consentire soltanto `state`, `find`, `read` sulle copie autorizzate; nessun retry
   agentico o correzione dopo il grading. Registrare per ogni chiamata argomenti,
   esito, ID consultati e byte UTF-8 effettivi di stdout/stderr, senza stime da caratteri.
4. Registrare chiamate totali/distinte, query ripetute, ricerche vuote e documenti
   riletti (STATE incluso). Registrare token input/output realmente esposti dal
   runtime, quota cached separata e costo della skill incluso; se non disponibili,
   segnare «non misurabile», senza ricavare token dai byte. Verificare hash e mtime
   di memoria ed eventuali checkpoint prima/dopo.
5. Valutare ogni risposta contro l'oracolo invariato, inclusi completezza e dettagli
   inventati; confrontare chiamate, byte e token solo insieme alla correttezza.
   Una coppia di esecuzioni è un pilot descrittivo, non una prova statistica o una
   riduzione garantita. Fermarsi e riferire limiti di trasporto o token mancanti.

Questa fase definisce il protocollo senza eseguire agenti, prove stateless o
confronti A/B. Nessuna invocazione LLM aggiuntiva è necessaria ai controlli locali.
