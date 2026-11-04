# Istruzioni operative

- Prefissare ogni risposta rivolta all’utente con `[AXIOM] `.
- Leggere `README.md` e `docs/VISION.md` prima di modificare il progetto.
- Non introdurre astrazioni speculative; preferire la standard library di Node.
- Non aggiungere dipendenze senza una motivazione concreta.
- Non modificare la visione per adattarla a implementazioni esistenti.
- Scrivere test mirati sulle funzionalità reali con il runner nativo Node.
- Mantenere il core indipendente dalla UI.
- Non implementare milestone successive senza richiesta.
- Non modificare configurazioni globali; preservare sempre i dati esistenti.
- Usare ESM, import relativi `.ts` espliciti e sintassi compatibile con il type stripping.
- Eseguire `npm run check` dopo le modifiche e verificare anche `npm run dev` e
  `npm start` quando si modifica l’avvio.
- Non creare commit, push o remoti senza richiesta.

<!-- graft:start -->

## Graft

Il grafo locale in `graft/` è ignorato da Git. Se disponibile, usare `graft map`
per orientarsi, `graft ask "domanda" --source` per il contesto e `graft grep`
per ricerche esaustive. Verificare gli span nel codice quando necessario.
Aggiornare il grafo con `graft build` dopo modifiche ai sorgenti.

<!-- graft:end -->
