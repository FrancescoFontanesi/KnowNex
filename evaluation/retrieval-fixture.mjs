// Synthetic reference memory, authored independently of the oracle below.
// It is not evidence of checkpoint quality or an actual Curator run.
export const source = `# MERIDIAN — registro delle fonti
R1 | 2026-10-01 | Decisione: CLI locale per esportare misure; prima proposta SQLite; nessuna rete.
R2 | 2026-10-02 | Esperimento T1: SQLite, 20 prove concorrenti, 3 errori di locking; risultato di laboratorio.
R3 | 2026-10-03 | Decisione: JSONL append-only sostituisce SQLite per evitare il locking osservato in T1. SQLite resta storico, non backend corrente.
R4 | 2026-10-04 | Decisione: conservazione locale 7 giorni; nessun invio remoto.
R5 | 2026-10-05 | Esperimento T2: esportazione JSONL di 10000 righe, p95 42 ms, 30 prove su Linux. Non è una garanzia di produzione né una verifica Windows.
R6 | 2026-10-06 | Stato: obiettivo consegnare la CLI locale; rilascio bloccato dal test recovery Windows ancora aperto. Nessun responsabile del rilascio documentato.
`;

export const memory = {
  'STATE.md': `# MERIDIAN — stato corrente

Obiettivo: consegnare la CLI locale di esportazione misure. Rilascio bloccato: test recovery Windows ancora aperto (R6).

Backend corrente JSONL append-only; SQLite è superato (R3). Conservazione locale 7 giorni, nessun invio remoto (R4).

Dettagli: [esperimenti](knowledge/experiments.md), [decisioni](knowledge/decisions.md), [stato storico](HISTORY.md#h000001).

Fixture sintetica scritta a mano, non memoria pubblicata da un checkpoint.
`,
  'HISTORY.md': `# History

<!-- knownex-history:H000001:begin -->
## H000001

- Data: \`2026-10-03T00:00:00.000Z\`
- Eventi: \`E001..E003\`
- Fonte: R1, R2, R3 (registro sintetico, non feed acquisito)
- Argomenti: storage; decisioni
- Descrizione: JSONL sostituisce SQLite
- Transizione: SQLite superato dopo gli errori di locking di T1; JSONL corrente.

### STATE precedente

> # MERIDIAN — proposta iniziale
> SQLite proposto come backend locale (R1); T1 registra 3 errori di locking su 20 prove (R2).
<!-- knownex-history:H000001:end -->
`,
  'knowledge/experiments.md': `---
id: kn-00000000-0000-4000-8000-000000000001
type: knowledge
---
# Esperimenti MERIDIAN

## T1 — SQLite
20 prove concorrenti; 3 errori di locking in laboratorio (R2). Motiva il cambio documentato nelle [decisioni](decisions.md).

## T2 — JSONL
10000 righe esportate, p95 42 ms, 30 prove su Linux (R5). Risultato di laboratorio, non garanzia di produzione e non verifica Windows.

## Verifiche aperte
Recovery Windows ancora da eseguire; blocca il rilascio (R6). Nessuna conclusione di successo Windows è supportata.
`,
  'knowledge/decisions.md': `---
id: kn-00000000-0000-4000-8000-000000000002
type: knowledge
---
# Decisioni MERIDIAN

R1, 2026-10-01: SQLite era la proposta iniziale; CLI locale, nessuna rete.
R3, 2026-10-03: JSONL append-only sostituisce SQLite dopo T1, che ha osservato 3 errori di locking su 20 prove concorrenti (R2).
R4, 2026-10-04: conservazione locale 7 giorni, nessun invio remoto.
R6, 2026-10-06: rilascio bloccato dalla recovery Windows aperta. Responsabile del rilascio non documentato nelle fonti disponibili; non dedurlo dall'autore delle decisioni.

Vedi [esperimenti](experiments.md) e [stato storico](../HISTORY.md#h000001).
`,
};

const fact = (id, expected, line, priority = 'critical', extra = {}) => ({
  id,
  description: id,
  expected,
  priority,
  temporalScope: 'dopo R6, salvo esplicita richiesta storica',
  qualifications: [],
  sources: [{ source: 'ledger', startLine: line, endLine: line }],
  criterion: expected,
  ...extra,
});

export const facts = [
  fact('objective', 'CLI locale di esportazione misure.', 7),
  fact('blocker', 'Recovery Windows aperta: il rilascio resta bloccato.', 7),
  fact('retention', 'Conservazione locale 7 giorni, nessun invio remoto.', 5),
  fact('benchmark', 'T2: 10000 righe, p95 42 ms, 30 prove su Linux.', 6),
  fact(
    'qualification',
    'Laboratorio: nessuna garanzia di produzione o verifica Windows.',
    6,
  ),
  fact(
    'old',
    'SQLite proposto il 2026-10-01; non è il backend corrente.',
    2,
    'ordinary',
    { temporalScope: 'storico R1' },
  ),
  fact(
    'current',
    'JSONL append-only sostituisce SQLite il 2026-10-03.',
    4,
    'critical',
    { supersedes: ['old'] },
  ),
  fact(
    'reason',
    'T1: 3 errori di locking su 20 prove concorrenti in laboratorio.',
    3,
  ),
  fact(
    'owner',
    'Responsabile del rilascio non documentato; dichiarare il limite senza inventare.',
    7,
    'unavailable',
  ),
];

export const scenarios = [
  {
    id: 'cold',
    prompt:
      'Riprendi il progetto: qual è l’obiettivo e che cosa blocca il rilascio? Cita le fonti della memoria.',
    facts: ['objective', 'blocker'],
    route: [],
    targetReads: 0,
    requiresInjection: true,
  },
  {
    id: 'direct',
    prompt:
      'Quanto durano i dati locali e vengono inviati altrove? Cita le fonti della memoria.',
    facts: ['retention'],
    route: [],
    targetReads: 0,
    requiresInjection: true,
  },
  {
    id: 'deep',
    prompt:
      'Quali risultati ha dato T2 e quali conclusioni non sono giustificate? Cita esperimento e fonte.',
    facts: ['benchmark', 'qualification'],
    route: ['knowledge/experiments.md'],
    targetReads: 1,
    requiresInjection: true,
  },
  {
    id: 'historical',
    prompt:
      'Quale backend era proposto inizialmente, quale è corrente e perché è stato sostituito? Distingui date e fonti.',
    facts: ['old', 'current', 'reason'],
    route: ['HISTORY.md#h000001', 'knowledge/decisions.md'],
    targetReads: 2,
    requiresInjection: true,
  },
  {
    id: 'negative',
    prompt:
      'Chi è il responsabile del rilascio? Cita la fonte oppure dichiara il limite delle informazioni disponibili.',
    facts: ['owner'],
    route: ['knowledge/decisions.md'],
    targetReads: 1,
    requiresInjection: true,
  },
];

export const assessmentPolicy = {
  engine: 'evaluation/harness.mjs evaluate; no automatic semantic judge',
  correctness:
    'correct solo se tutti i fatti richiesti sono fedeli alle fonti; partial se incompleti; false affermazioni sono incorrect',
  completeness:
    'revisionare separatamente ogni factId richiesto, incluse qualificazioni e limiti; non omettere i not_evaluable',
  provenance:
    'citare file e passaggio della memoria, con R-ID pertinente; verificare contro ledger privato, non contro la memoria stessa',
  attribution:
    'separare memory, retrieval, use e fidelity; un errore infrastrutturale non è un errore della memoria',
  measurements: [
    'native total/cached/uncached input',
    'native responses/tools',
    'reads/navigations and opaque calls',
    'native turn duration',
    'annotated cold_start/human_wait intervals',
    'manual intervention count with evidence',
  ],
  routePolicy:
    'route e targetReads sono percorsi di riferimento, non obblighi o prove del comportamento reale; letture di integrità separate',
  missingEvidence: 'null/not_evaluable, mai zero o PASS presunto',
};
