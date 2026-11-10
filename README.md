# KnowNex

Il feed JSONL acquisito dagli hook e la fonte autorevole della materializzazione.
Il checkpoint verifica gli eventi registrati senza interrogare la history Codex.
Modifiche retroattive non acquisite dagli hook non vengono rilevate automaticamente.
Introduzione, installazione e
modifiche della rc.11: [README dell'installer](docs/INSTALLER-README.md).

Memoria procedurale locale per il lavoro in Codex: STATE conserva il contesto
confermato, HISTORY gli stati precedenti e Knowledge i dettagli riutilizzabili.
Il feed conserva gli eventi; il recupero e selettivo, senza ricerca LLM.

La release candidate corrente e **0.1.0-rc.11**. Dopo l'installazione nel progetto
e `knownex init`, aprire una nuova chat dalla radice del workspace e approvare
gli hook se richiesto. Il principale suggerisce il salvataggio ai milestone;
solo l'invocazione utente di `$knownex-checkpoint` avvia una materializzazione.
Nessuna domanda Si/No o interpretazione di assensi: un comando autorizza un batch.
La memoria consultabile risiede in .knownex/memory/: STATE, HISTORY e Knowledge
immutabili per checkpoint. Feed, run, journal e ricevute sono in .knownex/internal/.
Le nuove installazioni non creano seed/ o copie piatte delle note correnti.
I workspace legacy mantengono il proprio layout, senza conversione automatica.
[Layout, compatibilita e limiti](docs/MEMORY-LAYOUT.md).

- [Installazione, aggiornamento e rimozione](docs/INSTALL.md)
- [Indice della documentazione corrente](docs/README.md)
- [Visione del progetto](docs/VISION.md)
- [Evidenza offline della release candidate](docs/RELEASE-CANDIDATE.md)

Le verifiche funzionali non garantiscono completezza semantica, scelta dei
milestone o efficienza in ogni progetto. I test offline non dimostrano il
comportamento di un modello; le singole prove reali non costituiscono una
qualificazione generale.

## Sviluppo

Richiede Node.js 24.11+ o 26, npm e Git. Il package installato non richiede
TypeScript globale, provider o dipendenze runtime aggiuntive.

```powershell
npm ci
npm run check
npm run dev -- --help
npm start -- --help
```

`check` esegue typecheck, test nativi Node, controllo Prettier e build. Il codice
usa ESM e import relativi `.ts`; la build produce JavaScript in `dist/`.

## Struttura

- `src/`: CLI, acquisizione, feed, navigatore, curator e bootstrap.
- `tests/`: verifiche deterministiche con dati sintetici.
- `.agents/skills/`: checkpoint, curator, recall e taxonomy distribuiti dal package.
- `.codex/hooks/`: entrypoint degli hook.
- `docs/`: contratti e procedure correnti.
- `.local/`: contesto e artefatti locali mantenuti, esclusi da Git.

Feed, journal e dati privati di progetto risiedono in `.knownex/`, esclusa da Git.
Anche `node_modules/`, `dist/` e la cache opzionale `graft/` sono ignorati.
Le evidenze storiche e gli script di prova superati sono archiviati fuori dal
repository; il percorso locale e registrato in `.local/ARCHIVE.md`.
