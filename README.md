# KnowNex

Memoria secondaria per progetti portati avanti con agenti LLM: codice, ricerca,
appunti. L'opposto del compacting: invece di riassumere e perdere dettaglio,
KnowNex registra la conversazione e la cura in una memoria Markdown esplorabile,
così una nuova sessione (o un'altra persona) riparte dall'ultimo stato operativo
senza rileggere tutti i documenti o ricostruire il progetto dal codice.

Versione corrente: **0.1.0-rc.11**. Provider acquisiti: Codex e Claude Code (`knownex init --provider codex,claude`).

## Come funziona

1. **Acquisizione.** Gli hook registrano messaggi utente e risposte finali
   dell'assistente in un feed JSONL locale, senza consumare token. Il feed è la
   fonte autorevole e conserva tutto.
2. **Checkpoint esplicito.** Solo l'utente lo avvia, per esempio con
   `npm exec --offline -- knownex checkpoint --codex -m gpt-6.1-sol -r medium`
   (oppure `--claude`). Il comando congela il batch di eventi, avvia una sessione
   effimera del provider che non viene registrata nel feed, e il Curator legge il
   batch e scrive una bozza (nuovo STATE, note Knowledge, rapporto). `curate write`
   la valida subito, così il Curator corregge gli errori mentre lavora; al termine
   il comando la pubblica in modo transazionale e restituisce solo l'esito. Il
   lavoro può proseguire in parallelo: gli eventi successivi vanno al checkpoint dopo.
3. **Ripresa.** All'avvio di una sessione STATE entra nel contesto. Il resto si
   apre solo quando serve: un riferimento noto si legge direttamente, una ricerca
   si delega a un subagente che segue la skill `knownex-recall`.

## La memoria

Tutto ciò che si esplora sta in `.knownex/memory/`, apribile anche come vault
Obsidian:

```text
.knownex/memory/
  STATE.md                       radice: obiettivo, decisioni, blocker, prossime azioni, link
  HISTORY.md                     indice dei checkpoint, una riga ciascuno
  history/H000012.md             finestra di un checkpoint: transizione, note scritte, STATE prodotto
  knowledge/H000012/             note scritte da quel checkpoint (stesso id di HISTORY), immutabili
    storage--kn-UUID--REV.md
```

- **STATE** è la radice dell'albero: rimanda alle Knowledge invece di contenerle.
- **Knowledge** sono note tematiche con testo e riferimenti a codice e artefatti
  (percorsi dalla radice del workspace), scritte come un diario di bordo: ogni
  checkpoint aggiunge note nuove nella propria cartella e non riscrive le esistenti,
  quindi lo stesso nome può tornare in checkpoint diversi. Se una decisione
  cambia, la nota nuova linka quella che supera; STATE linka le note con la verità
  attuale, le precedenti mostrano l'evoluzione.
- **HISTORY** si legge a finestre: `memory history` elenca i checkpoint senza aprirli,
  `memory read H000012` apre solo quello che serve.
- **Provenienza.** Ogni affermazione cita gli eventi da cui viene, come `[E017]`:
  la sequenza dell'evento nel feed. `pending` legge solo gli eventi non ancora
  curati; `memory event E017` (o `E015..E016`, al massimo 20 eventi) rilegge un evento già curato.

Feed, run, journal e ricevute stanno in `.knownex/internal/`, fuori dal vault.

```powershell
npm exec --offline -- knownex memory state
npm exec --offline -- knownex memory history --last 10
npm exec --offline -- knownex memory read H000012
npm exec --offline -- knownex memory find "termini distintivi"
npm exec --offline -- knownex pending
```

## Garanzie e limiti

- Il runtime controlla struttura, provenienza, link, identità delle note e integrità
  degli input; la pubblicazione è transazionale e recuperabile dopo un crash.
- Non garantisce la completezza semantica: cosa conservare lo decide il Curator.
  Incertezze o anomalie dichiarate bloccano la pubblicazione automatica.
- Modifiche retroattive non acquisite dagli hook non vengono rilevate.
- I test offline non dimostrano il comportamento di un modello reale.

## Documentazione

- [Installazione, aggiornamento e rimozione](docs/INSTALL.md)
- [Contratto della memoria](docs/MEMORY-CONTRACT.md) e
  [revisioni delle Knowledge](docs/KNOWLEDGE-REVISIONS.md)
- [Navigatore e recall](docs/NAVIGATOR.md)
- [Layout, compatibilità e limiti](docs/MEMORY-LAYOUT.md)
- [Indice completo](docs/README.md) · [Visione](docs/VISION.md)

## Sviluppo

Richiede Node.js 24.11+ o 26, npm e Git. Il package installato non richiede
TypeScript globale, provider o dipendenze runtime aggiuntive.

```powershell
npm ci
npm run check                           # typecheck, test, Prettier, build
node --test evaluation/tests/*.test.mjs # regressioni di retrieval e cold start
npm run dev -- --help
```

Il codice usa ESM e import relativi `.ts`; la build produce JavaScript in `dist/`.

- `src/`: CLI, acquisizione, feed, curatela, navigatore, bootstrap.
- `tests/`: verifiche deterministiche con dati sintetici.
- `evaluation/`: fixture isolati per retrieval e ripartenza a freddo.
- `.agents/skills/`: skill curator, recall e taxonomy distribuite dal package.
- `.codex/`: hook (gli stessi script servono anche Claude Code).
- `docs/`: contratti e procedure correnti.

`.knownex/`, `.local/`, `node_modules/`, `dist/` e la cache `graft/` sono esclusi da Git.
