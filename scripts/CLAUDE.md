# scripts

Two scripts that regenerate committed data. Neither is needed to run Concord: a clean clone
already has `data/public/` and `feeds/`. Run them from `meow/`.

```
fetch_public_data.py   internet     -> data/public/   (real public data + SOURCES.json)
simulate_feeds.py      data/public/ -> feeds/         (five mock systems + manifests + answer key)
```

## fetch_public_data.py

Downloads the CDISC SDTM pilot domains (converted from SAS transport to CSV), the
ClinicalTrials.gov record for NCT07011732, and three openFDA reports used as a layout template.
Writes `data/public/SOURCES.json` with the URL, SHA-256 and retrieval time of each file.

- Needs the network and `pandas`, which is not in `requirements.txt` (`pip install pandas`).
- Re-running it rewrites every hash and timestamp, and the upstream sources can change. A
  changed snapshot changes the feeds, the story and every quoted figure. Do not run it casually.
- It also downloads the `ex` domain, which the simulation does not use; `ex.csv` is not in the
  repository even though `SOURCES.json` lists it.

## simulate_feeds.py

Standard library only. It is a script, not a module: it runs top to bottom on execution and
writes into `feeds/` in place. Sections, in order: EDC (real rows, filtered) -> facts derived
from EDC -> choose the story sites -> CTMS -> IRT -> safety -> finance -> snapshot and answer key.

```bash
python scripts/simulate_feeds.py
git status --short feeds/     # prints nothing if the output is still byte-identical
```

### Determinism is fragile by construction

One `rng = random.Random(SEED)` is consumed in program order. Adding, removing or reordering
any call on it shifts every draw after it: which sites are in trouble, which records get a
planted problem, vendor ids, amounts, dates. Before touching the script, decide which you want:

- **Keep the existing feeds stable**: draw new randomness from a separate stream, as
  `typo_rng = random.Random(SEED + 1)` does, or add the new draws after everything else.
- **Accept new feeds**: fine, but the answer key, the story sites, the figures in the docs
  and the screenshots all change with it.

Do not use the global `random` module, the clock, or iteration order of a `set` anywhere the
order matters or the rng is consumed.

### Planting a problem

Corrupt the row, then record it:

```python
plant("P20", "irt", "valid_kit_status_domain", row["KIT_ID"], "kit with an unknown status")
```

`rule_id` must be the `id` of a rule in `concord/quality.py`, and `record_key` must be exactly
what that rule returns as its first column, or the problem will be reported as missed. For
safety cases the script picks records to corrupt from ones not already planted
(`clean = [...]`), so that one case does not carry two problems; do the same elsewhere.

### Other things defined here

- `AS_OF` and `SEED`: written to `feeds/_snapshot.json`, which is what the platform reads.
- `CLASSIFICATION`: the sensitivity tags each source owner places on files and columns. It is
  written into the manifests and is where bronze-level access tags come from.
- `us()`, `sas()`, `compact()`, `eu()`, `money()`: each system's own date and amount format.
- `ABBREV`, `typo()`, `safety_name()`, `legal_name()`: how site names are degraded for the
  safety and finance systems. The two same-city sites are never misspelled; they are the hard
  matching case as they are.
- Site names, investigators and monitors are invented from the lists at the top. Keep them
  invented: real geography from ClinicalTrials.gov, never a real institution's name.

### After regenerating

1. `python -m concord build` and read the summary line by line.
2. `python tests/test_concord.py`.
3. Update the hand-written figures in `README.md`, `docs/DATA.md`, `docs/DEMO.md`, `docs/DECK.md`.
4. Retake any screenshot in `docs/screenshots/` that shows a changed number.
