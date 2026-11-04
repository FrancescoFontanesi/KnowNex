# KnowNex 0.1.0-rc.1 — evidenza offline S5

Verdetto: **READY per i criteri offline**. Nessuna qualificazione semantica reale
e dichiarata sulla base di queste prove.

- Archivio locale: `.local/s5-rc/package/knownex-0.1.0-rc.1.tgz`.
- SHA-256: `8dc883a35258ca3aa225d01f9f20679c6b6226b4d09ce246bd8e919f9e8f9531`.
- Package: 32 file, 70.701 byte compressi, nessuna dipendenza runtime.
- `npm run check`: 138 test superati, zero fallimenti; typecheck, formatter e
  compilazione della CLI e del helper single-pass superati.
- Una prova integrata dell'archivio realmente installato offline in un workspace
  temporaneo esterno supera bootstrap, hook sintetici, Capture/feed, due sessioni,
  STATE/pending, lettura bounded, consensi Si/No, validate/apply e recovery,
  batch fallito/ritiro/nuovo consenso e helper single-pass compilato.
- I processi runtime hanno accesso filesystem limitato al workspace; una lettura
  esplicita del checkout sorgente viene rifiutata. Nessun accesso al sorgente e
  necessario per i comandi installati.
- Reinstallazione della stessa RC e secondo init: file confermati, conoscenza,
  consenso, journal e feed conservano byte e mtime; nessuna riscrittura gestita.
- Una precedente risorsa riconosciuta dal manifest viene aggiornata; una modifica
  dell'utente agli hook viene rifiutata con conflitto esplicito e senza sovrascrittura.
- L'upgrade dall'archivio S3 originale aggiorna solo risorse con hash esatti noti;
  STATE/HISTORY/Knowledge, checkpoint, journal e Capture/feed esistenti rimangono
  byte-identici. I feed legacy per-sessione sono preservati e segnalati come
  bloccati: **non viene eseguita una migrazione** nel feed di progetto.
- AGENTS personale e ignore preesistenti rimangono preservati. Git ignora i feed,
  journal privati e node_modules nel workspace di prova.

Log e risultati locali: `.local/s5-check.txt`, `.local/s5-rc/pack.json`,
`.local/s5-rc/smoke.txt`, `.local/s5-rc/result.json`. Non sono versionati.
L'archivio S3 storico rimane intatto; nessun nuovo archivio contiene log, sorgenti
TypeScript, test, feed privati, `.local/` o preferenze modello locali.

Restano UNMEASURED nella sessione reale: approvazione/esecuzione effettiva degli
hook da Codex, attivazione spontanea delle skill, riconoscimento dei milestone,
interpretazione semantica del pending e della continuita critica, dialogo Si/No
e disponibilita/delega del curator economico. Non sono stati avviati modelli,
subagenti o benchmark LLM. Le garanzie di storage restano condizionate al modello
documentato, senza nuova dimostrazione di durabilita fisica.

Installazione e rimozione: [INSTALL](INSTALL.md). Il commit che include questo
documento consolida la RC; nessun tag, push o pubblicazione npm e richiesto.
