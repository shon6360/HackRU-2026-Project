# data/public

A committed snapshot of the real public data Concord is built on. It exists so a clean clone
runs offline and so the provenance of every real value can be shown.

Concord never reads this folder at run time. The only reader is `scripts/simulate_feeds.py`,
which turns it into `feeds/`. The only writer is `scripts/fetch_public_data.py`.

| Path | Source | Used for |
|---|---|---|
| `sdtm/dm.csv`, `ae.csv`, `sv.csv`, `ds.csv` | CDISC SDTM/ADaM pilot project, study CDISCPILOT01. Converted from SAS transport to CSV with no other change | The EDC feed, after cutting at the snapshot date |
| `ctgov/NCT07011732.json` | ClinicalTrials.gov API v2 | Registry fields of the CTMS study record, and US site geography |
| `openfda/sample_events.json` | openFDA drug adverse event API, three reports | The record layout of the safety feed only. No value from it reaches the feeds |
| `SOURCES.json` | written by the fetch script | URL, SHA-256, retrieval time and a note for each file |

## Rules

- **Do not edit these files.** They are evidence: each one's hash is recorded in
  `SOURCES.json`, and "converted unchanged" is a claim made in `docs/DATA.md`.
- Filtering, trimming and reshaping belong in `simulate_feeds.py`, which works on a copy in
  memory. That is where the full pilot study (306 subjects, 2012 to 2015) is cut down to the
  270 subjects screened by the snapshot.
- To refresh, run the fetch script, knowing that it changes every downstream number. See
  `scripts/CLAUDE.md`.
- `SOURCES.json` lists `sdtm/ex.csv`, which is not in the repository: the fetch script downloads
  it but nothing uses it.

## Things to know about the content

- The CDISC pilot study has no registry entry. NCT07011732 is a real, unrelated study of a
  xanomeline product in Alzheimer's disease, borrowed for registry fields and site locations
  only. The pairing is Concord's own and is stated in `feeds/ctms/study.json`.
- Some numeric SDTM values arrive as floats from the XPT conversion (`AGE` as `63.0`); the
  simulation normalizes them.
- Adverse event onset dates can be partial (`1977`, `2013-06`). That is real, and the quality
  rules report it rather than repair it.

## Terms

The CDISC pilot data is published by CDISC for public use. ClinicalTrials.gov and openFDA data
are US government works in the public domain; openFDA asks that its data not be presented as
medical advice.
