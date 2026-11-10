# Manutenzione tematica opzionale

`$knownex-taxonomy` opera soltanto su invocazione esplicita. Non esegue un
checkpoint della conversazione e non avanza il cutoff. Il curator ordinario usa
solo categorie approvate; non crea categorie né riclassifica note invariate.
Non esistono categorie predefinite, soglie semantiche o classificazione obbligatoria.

## Proposta e approvazione

```text
knownex taxonomy prepare --work .knownex/internal/curator
knownex taxonomy validate --work .knownex/internal/curator --run ID
knownex taxonomy apply --work .knownex/internal/curator --run ID --confirm SIGILLO --approval-event SEQUENZA
knownex taxonomy rebuild --work .knownex/internal/curator
```

Prepare richiede un'invocazione utente acquisita nel feed e crea solo staging
in `taxonomy-runs/ID/`: packet, identità della richiesta, checkpoint e impronta
dei metadati. Il packet contiene un catalogo cronologico delle revisioni
raggiungibili, non tutti i loro contenuti. Il curator esistente legge selettivamente
le revisioni necessarie e propone macro-temi ricorrenti, sovrapposizioni e candidati.
Un'analisi senza cambiamenti utili è valida; validate restituisce `noop`.

Il file `proposal.json` UTF-8 contiene patch, non sostituzioni integrali:

```json
{
  "categories": { "methods": "Metodi, evidenze e limiti" },
  "assignments": { "kn-UUID@REV": ["methods"] },
  "explanations": "Motivazioni, revisioni/checkpoint rappresentativi e sovrapposizioni"
}
```

UUID e REV nell'esempio sono segnaposto: servono identità reali del catalogo.
Assenze conservano i dati precedenti; `[]` rende una revisione non classificata.
Validate restituisce sigillo, tassonomia e associazioni effettive. Il principale
presenta una proposta leggibile con motivazioni e riferimenti, ID e sigillo.
L'utente può rifiutare, modificare o aggiungere categorie. Dopo modifiche si
rivalida e si presenta il nuovo sigillo; non occorre ripetere l'analisi semantica.

Apply verifica invocazione, finale dell'assistente con quel run/sigillo e prima
risposta utente successiva nella stessa sessione, realmente acquisiti e non
esclusi dal ramo attivo. Una risposta successiva rende obsoleto quel consenso.
**Il principale interpreta l'assenso libero; la CLI non ne verifica il significato.**
Un marker o una dichiarazione del modello non sostituiscono gli eventi acquisiti;
non sono prove crittografiche della comprensione o visualizzazione umana.
Risposte ambigue, rifiuto e silenzio impongono di non chiamare apply.

Checkpoint o metadati cambiati invalidano la proposta. Una nuova invocazione
permette un nuovo run; l'analisi ancora pertinente può essere riutilizzata.
Un batch curator pendente impedisce apply tematico. Le istruzioni restano il
confine semantico dell'approvazione, come nel workflow manuale esistente.

## Dati canonici e identità

`taxonomy.json` resta la mappa minimale chiave → descrizione. Le chiavi esistenti
non vengono eliminate per omissione. Per rinominare/fondere si aggiunge una
chiave e si approvano associazioni esplicite, preservando le chiavi precedenti.
Non esistono cancellazione fisica di chiavi, alias o fusioni automatiche.

`taxonomy-associations.json` conserva solo classificazioni retroattive:

```json
{
  "version": 1,
  "assignments": { "kn-UUID@REV": ["methods"] },
  "receipt": { "id": "t-SHA256", "hash": "SHA256" }
}
```

La chiave identifica una revisione precisa, non un ID logico corrente né un
evento del feed. Un'associazione esplicita sostituisce la classificazione
originaria ricavata dal percorso; in sua assenza vale quella originaria.
Non cambia byte, hash, percorso, provenienza o significato della revisione.
Le ricevute immutabili `taxonomy-changes/t-SHA256.json` registrano proposta,
sigillo, riferimento all'approvazione, impronte prima/dopo e ricevuta precedente.
La testa autenticata rileva alterazioni dei dati canonici; non è una firma contro
scrittori esterni che possano riscrivere tutti i file. Workspace senza questi
metadati e con solo `taxonomy.json` restano validi senza migrazione.

## Navigazione e viste

`knownex memory category CHIAVE --memory .knownex/memory` restituisce
revisioni esatte in ordine cronologico, con provenienza, stato corrente e
classificazione originaria/retroattiva. Pagine: default 5, massimo 20 risultati,
`--limit N --cursor CURSORE`; cambiamenti del checkpoint o dei metadati invalidano
il cursore. Non è un limite al numero di categorie. Le note legacy non ancora
versionate restano leggibili ma non compaiono nel catalogo storico.

Find continua a cercare note correnti, includendo categorie effettive nei metadati;
`category` nei risultati rimane la collocazione originaria, `thematicCategories`
la classificazione attuale. Una parola della vecchia collocazione può ancora
corrispondere in find; usare `memory category` per la selezione tematica esatta.
Read non altera contenuti né segue link automaticamente.

`topics/index.md` e `topics/category-CHIAVE.md` sono viste derivate per lettori
Markdown/Obsidian: link relativi alle revisioni originali, raggruppati per cutoff
del checkpoint. Non sono Knowledge né fonte di verità. Rebuild le ripara dai
metadati già approvati senza nuova classificazione o delega. Le viste possono
diventare obsolete dopo checkpoint ordinari: ricostruirle quando necessario.

## Transazione e limiti

La manutenzione riusa `curator.lock`, `apply.json` e la recovery esistenti.
Il record v3 tematico contiene solo metadati prima/dopo, senza copie della memoria.
Ordine persistente: intento → ricevuta → registro → viste → associazioni/testa.
Il checkpoint rimane identico. Il replay verifica vecchi/nuovi contenuti canonici,
ripara viste derivate e completa l'operazione autorizzata senza nuova delega.
Una collisione canonica blocca; una proposta non autorizzata non viene promossa.
Prepare/validate non completano recovery pendenti; i normali gate di recovery
restano disponibili. Lettori esterni che ignorano il lock possono osservare file
intermedi; non si promettono transazioni multi-file per questi lettori.

Valgono le assunzioni di [durabilità](STORAGE-DURABILITY.md), non una dimostrazione
fisica contro power loss. I test verificano byte, riferimenti, autorizzazioni
strutturali, collisioni e replay; non qualità semantica dei temi, completezza
dell'analisi o interpretazione corretta dell'assenso da parte di un modello.
