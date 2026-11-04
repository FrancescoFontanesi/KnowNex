# V3.3 — End-to-End Cost Reconciliation

**PARTIAL.** [Registro per ruolo, finestra, fonti e hash](../.local/v3.3-cost/cost-evidence.json).

Curator baseline → single-pass: **16 → 3 risposte**, **13 → 0 tool**;
input **419.498 → 76.564** (−81,75%), output **4.395 → 6.644** (+51,17%).
Cached **349.824 → 54.016**; non cached **69.674 → 22.548**.
Cached è incluso nell’input, non sommato nuovamente. Tre deleghe per traiettoria,
zero retry curator osservati; retry provider sconosciuti.

Principale: finestre V0 ampia e V0.2 parziale, mescolate a sviluppo/audit;
costo produttivo, token per tool e correzioni non isolabili.

Recupero Q1/V0.2: **8/10 risposte**, **15/20 comandi**, **36.756/53.250 byte**;
token e cache nel registro. Condizioni e trasporto diversi impediscono
un confronto causale.

V1: **134 esecuzioni = 115 ok + 19 not_found**; **135 trace** includono
un rifiuto senza esecuzione registrata. Questo scarto è risolto.
Le **153 toolAudit.calls** restano **UNMEASURED** rispetto alle esecuzioni:
gli scarti non dimostrano retry. Due call ID osservati non riconciliano l’universo.

Costo end-to-end confrontabile: **no**. Budget qualificanti calibrabili: **no**.
Mancano finestre produttive comparabili, correlazione completa dei tentativi
e pilot conforme. Quota d’abbonamento e costo monetario restano sconosciuti.

Limite raggiunto: **128 KiB grezzi**, incluse riletture, su un turno identificato;
nessun transcript completo. Nessuna ulteriore ricerca, modifica al prodotto,
delega, benchmark, commit o push. `npm run check` non eseguito.
