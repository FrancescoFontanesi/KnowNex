# V3.0 — Qualification Evidence Review

**BLOCKED.** Matrice: **16 PASS / 3 FAIL / 9 UNMEASURED**, su 28 voci distinte
fra proprietà, claim e gate. Riferimento: [contratto V0](BENCHMARK-CONTRACT.md).
La [matrice completa](../.local/v3-qualification/MATRIX.md) registra evidenza,
condizioni, limiti e blocker per ciascuna voce; il [registro](../.local/v3-qualification/evidence.json)
conserva percorsi, selettori e hash. Le evidenze locali sono private e ignorate da Git.

Confermati sui campioni: conservazione semantica Q1/V0.2, supersession, assenze
dichiarate, HISTORY e ID Knowledge, riferimenti al CSV sintetico di dodici righe.
E1 iniziale resta fallito; la successiva riparazione meccanica dei link è dichiarata.

Single-pass: input curator **419.498 → 76.564**, risposte **16 → 3**;
output **4.395 → 6.644**. È adottabile come opzione sperimentale supervisionata,
senza promozione automatica. Mancano costi end-to-end comparabili del principale.
Recall è utilizzabile come istruzione; il beneficio rimane non misurato.
L’indice V1 rimane ritirato.

Blocker: omissione critica di `A-IMPORTI` nel recupero V1/A; integrità Unicode
end-to-end non soddisfatta nei workflow storici; assenza di budget calibrati,
suite A/B conforme e contabilità completa dei tentativi. Il **95% ordinario non
è valutabile**: gli oracoli non fissano priorità per fatto. **25/27** riguarda
fatti totali, non ordinari; nessuna riclassificazione retroattiva.

Le garanzie di recovery A e persistenza condizionale B restano separate dalla
durabilità fisica C non dimostrata. C non è un blocker autonomo del contratto V0.

Il [piano residuo](../.local/v3-qualification/MATRIX.md#percorso-residuo-minimo--non-eseguito)
prevede soltanto audit deterministici circoscritti: priorità prospettiche,
riconciliazione runtime e confini UTF-8. Budget: **zero LLM**. Le cinque
ripetizioni contrattuali restano necessarie ma non vengono programmate, dato
il divieto corrente. Questi audit da soli non consentono READY.

Una sola esecuzione di [npm run check](../.local/v3-qualification/check.json):
**118 test superati**, typecheck, formato e build verdi.
Nessun nuovo test, benchmark, codice, dipendenza, commit o push.
