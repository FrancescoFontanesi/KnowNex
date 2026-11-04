# V3.1 — Unicode Boundary Verification

**PARTIAL.** [Evidenze: byte, hash e verificatore](../.local/v3.1-unicode/evidence.json).
Un campione: accenti italiani, greco, giapponese, emoji e Unicode combinante.

PASS: `curator-request` dal packet al file richiesta; writer `apply_patch` della
sessione al JSON originale; lettura UTF-8 e parsing; `memory state` allo stdout
grezzo acquisito come Buffer. Confrontati byte integrali, contenuti e SHA-256;
nessuna deduzione dalla visualizzazione. Backend validate/apply non ripetuto.

Windows PowerShell **5.1.26100.9711** espone `$OutputEncoding.WebName`:
`us-ascii`. Senza cambiarlo, la pipe nativa altera i byte prima della persistenza:
**difetto storico riprodotto nel trasporto esterno**. Il CRLF aggiunto è distinto
dalla corruzione. L’errore CP1252 iniziale riguarda soltanto lo stdout diagnostico Python.

Gli entrypoint non forniscono un writer canonico delle proposte: lo sceglie il
principale. **UNMEASURED**: consegna al modello, risposta generata, envelope dei
tool e persistenza della risposta stateless completa. Lo stdout locale non li prova.

Creati soltanto questo rapporto ed evidenze locali. Prodotto, test, memoria e V3
invariati: **A2 storico resta FAIL**. Dieci invocazioni di comandi/processi,
incluse ispezioni e figli. Zero LLM, deleghe e benchmark. `npm run check` non
eseguito: nessuna modifica a produzione o test.
