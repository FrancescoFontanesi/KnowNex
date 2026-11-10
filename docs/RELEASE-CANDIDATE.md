# KnowNex 0.1.0-rc.11 ? verifiche e limiti

## Contratto corrente

Il feed acquisito dagli hook e la fonte conversazionale del checkpoint.
Sol esegue prepare, Terra materializza, Sol esegue complete. Il percorso non
richiede history Codex, App Server annidati o review semantica di Sol.
Autorizzazione monouso, cutoff, hash, ricevute, revisioni e recovery rimangono
obbligatori. La compatibilita dei dati legacy fa parte della versione corrente.

## Verifiche riproducibili

Dalla repository:

```powershell
npm ci
npm run check
npm --prefix evaluation test
npm pack --pack-destination "C:\pacchetti"
```

Per verificare l'archivio reale con installazione e reinstallazione offline:

```powershell
$env:KNOWNEX_INSTALL_ARCHIVE = "C:\pacchetti\knownex-0.1.0-rc.11.tgz"
node --test tests/bootstrap.test.ts
```

La suite verifica CLI locale, skill e ruolo nativo, hook, emissione di STATE,
preservazione dei dati, autorizzazioni, cutoff, apply e recovery sintetici.
La prova dell'originale fixture S3 e opzionale: un caso saltato non dimostra
compatibilita con quella specifica installazione storica.

## Limiti aperti

- Trust del workspace e approvazione degli hook richiedono intervento esplicito.
- Emissione integra di STATE e consegna effettiva al modello sono confini diversi.
- La review del Curator e i controlli strutturali non provano completezza semantica.
- Il feed conserva gli eventi acquisiti; edit retroattivi non acquisiti non sono
  rilevati automaticamente. Gli hash non certificano una conversazione esterna.
- `DESTINATION_BUSY` e stato osservato in una suite completa; la causa resta
  non accertata. I lock conservativi non vengono aggirati con retry arbitrari.
- Le prove offline non qualificano comportamento LLM, prestazioni generali o
  durabilita fisica del dispositivo.

Le evidenze storiche e i vecchi pacchetti sono conservati fuori dalla repository.
Per l'uso consultare [INSTALL](INSTALL.md), [workflow](CURATION-WORKFLOW.md) e
[durabilita](STORAGE-DURABILITY.md).
