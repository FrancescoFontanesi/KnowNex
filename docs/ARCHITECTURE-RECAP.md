# KnowNex rc.11 — recap verificato

Questa release integra funzionalita esistenti senza un nuovo modello di memoria,
MCP o dipendenze runtime. Matrice riferita al codice distribuito; i test usano
contenuti sintetici e non dimostrano la fedelta semantica di un modello.

| Componente            | Implementazione effettiva                                                                                                                            | Verifica deterministica                                                                     | Limite reale                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquisizione          | Hook Stop/SessionEnd e Capture in `capture.ts`; prompt, commentary verificabili e finali nel feed di progetto tramite `feed-hook.ts`/`feed.ts`       | Byte Unicode, ordine, replay, code incomplete, checksum e lock                              | Esecuzione degli hook e approvazione dipendono dal runtime Codex                                                                               |
| Curatela              | `curator.ts`, `curator-request.ts` e skill curator: batch congelato, una delega, proposta, validate e apply                                          | Autorizzazione monouso acquisita, staging, linkage, provenance, no retry automatico         | Scelta dei milestone, selezione e completezza semantica richiedono sessioni reali                                                              |
| Autorizzazione        | Solo `$knownex-checkpoint` utente avvia un batch ordinario; vecchio handoff non autorizza nuove operazioni                                           | Invocazioni testuali/IDE/native, consumo, fallimenti, ritiro e ripresa                      | La validazione strutturale non dimostra completezza semantica                                                                                  |
| Cold start            | `runtime.ts`/`session-hook.ts` emettono STATE confermato intero; bootstrap configura SessionStart con `additionalContextLimit: 0`, anche per compact | Seed, STATE oltre la vecchia soglia, pending tra sessioni, compact                          | Wrapper senza cap dimensionale; validazione prima dell’emissione, memoria O(payload), timeout figlio 7,5 s. Consegna al modello non verificata |
| Memoria               | STATE operativo e collegato, Knowledge dettagliate, HISTORY con STATE precedenti; contratto e skill condivisi                                        | Link/anchor, identita, provenance e continuita strutturale                                  | Nessun controllo lessicale dimostra completezza della conoscenza                                                                               |
| Revisioni             | `knowledge-revisions.ts`: snapshot integrali immutabili, ricevute e predecessori; proiezione corrente piatta                                         | Baseline, noop, catene, hash, correzioni, collisioni e riferimenti storici                  | Immutabilita di protocollo, non ACL contro scrittori esterni                                                                                   |
| Archivio fisico       | `revisions/checkpoint-NNNN/[categoria]/kn-ID--REV.md`; compatibilita con archivio piatto e run precedenti                                            | Percorsi annidati, link ribasati, journal e symlink/junction                                | Nessuna migrazione automatica degli archivi confermati                                                                                         |
| Navigazione           | `navigator.ts` e CLI: state/find/read, sezioni, revisioni precise e checkpoint; find corrente AND lessicale                                          | Ranking riproducibile, output limitato, piu note/checkpoint, nessuna traversata implicita   | Read integrale puo essere esteso; la ricerca non valuta validita semantica o sinonimi                                                          |
| Tassonomia            | `taxonomy.ts`, `taxonomy-cli.ts`, skill esplicita: registro minimale e associazioni a revisioni esatte                                               | Proposta/noop, modifica utente, sigillo, sessione, stale, replay e recovery                 | Il principale interpreta l'assenso libero; CLI verifica eventi e associazione, non il significato                                              |
| Esplorazione tematica | `memory category`, paginazione cronologica e `topics/*.md` ricostruibili                                                                             | Revisioni di piu checkpoint, link relativi, ricostruzione senza riscrivere Markdown storici | Solo revisioni gia versionate; viste da ricostruire dopo checkpoint ordinari quando necessario                                                 |
| Integrita             | Lock e `apply.json`: v1 legacy, v2 revisioni, v3 organizzazione; recovery senza delega                                                               | Crash/EIO e modello di persistenza dichiarato, replay idempotente, blocco su corruzione     | Durabilita fisica non dimostrata; assunzioni NTFS/flush nel contratto storage                                                                  |
| Installazione         | `bootstrap.ts`, npm tgz e quattro skill; config/hooks locali, manifest degli hash                                                                    | Installazione isolata, conflitti, idempotenza e preservazione dati                          | Config personalizzate in conflitto richiedono confronto esplicito; nessun aggiornamento globale                                                |

## Contratti e compatibilita

- [Memoria](MEMORY-CONTRACT.md), [curator](CURATOR.md), [revisioni](KNOWLEDGE-REVISIONS.md).
- [Navigatore](NAVIGATOR.md), [tassonomia](TAXONOMY.md), [runtime](RUNTIME.md).
- [Autorizzazione](CHECKPOINT-CONSENT.md), [durabilita](STORAGE-DURABILITY.md).

Aggiornare il package e rieseguire init; aprire una nuova chat per caricare le
istruzioni correnti. I dati non vengono migrati/spostati. I feed legacy per-sessione
restano conservati e segnalati come bloccanti; copie standalone della sola memory
non comprendono lo storico versionato. Un workspace spostato puo conservare percorsi
assoluti nei propri checkpoint: il pacchetto non dipende dal repository originale,
ma non offre una migrazione generale dei dati tra directory.

Le chiavi tassonomiche rimangono stabili: aggiunte/riassegnazioni esplicite sostituiscono
rinomine o fusioni automatiche. La tassonomia non altera fatti storici e non avanza
il cutoff conversazionale. Il vecchio nome della skill handoff non viene distribuito.

## Verifica della versione corrente

`npm run check` esegue suite nativa, typecheck, formattazione e build.
Installazione e reinstallazione dal tgz si verificano con la procedura in
[RELEASE-CANDIDATE](RELEASE-CANDIDATE.md). Le evidenze storiche restano esterne
al pacchetto e non sono prerequisiti di uso o compilazione. I test offline
non dimostrano completezza semantica, benefici economici o durabilita fisica.
