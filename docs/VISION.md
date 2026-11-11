# Visione KnowNex

KnowNex mira a trasformare il flusso delle conversazioni con agenti AI in un
contesto esterno, distribuito, persistente e navigabile.

## Principi confermati

- Alimentare la memoria con il feed delle conversazioni accessibili dagli harness.
- Conservare le conversazioni originali come fonte recuperabile.
- Materializzare progressivamente il contesto in documenti Markdown collegati e
  leggibili dalle persone.
- Distribuire il dettaglio tra documenti anziché comprimerlo distruttivamente.
- Consentire continuità di contesto fra agenti e sessioni.

## Questioni aperte all'avvio (S0, storico)

- Formato degli eventi e modalità di cattura dagli harness.
- Rappresentazione di State e History.
- Contratto e responsabilità del curator.
- Granularità delle note e organizzazione dei collegamenti.
- Indice dinamico e modalità di navigazione.
- Garanzie di durabilità e politica di versionamento della memoria.
- Interfacce utente e integrazioni.

Elenco storico: S0 preparava solo l'ambiente di sviluppo. Le scelte prese da
allora sono descritte nei contratti correnti: [memoria](MEMORY-CONTRACT.md),
[curator](CURATOR.md), [navigazione](NAVIGATOR.md) e [runtime](RUNTIME.md).
