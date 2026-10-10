"""Download the public datasets Concord is built on and snapshot them under data/public/.

The snapshot is committed, so a clean clone runs offline. Re-run this only to refresh it:

    pip install pandas        # only needed here, to convert SAS XPT -> CSV
    python scripts/fetch_public_data.py

Sources (all free, no login):
  * CDISC SDTM/ADaM pilot project  -> our "EDC" feed
  * ClinicalTrials.gov API v2      -> our "CTMS" study + site master data
  * openFDA drug adverse event API -> schema of our "safety database" feed
"""
from __future__ import annotations

import hashlib
import io
import json
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "public"

SDTM_BASE = (
    "https://raw.githubusercontent.com/cdisc-org/sdtm-adam-pilot-project/master/"
    "updated-pilot-submission-package/900172/m5/datasets/cdiscpilot01/tabulations/sdtm/"
)
SDTM_DOMAINS = ["dm", "ae", "sv", "ds", "ex"]

NCT_ID = "NCT07011732"
CTGOV_URL = f"https://clinicaltrials.gov/api/v2/studies/{NCT_ID}"

OPENFDA_URL = (
    "https://api.fda.gov/drug/event.json"
    "?search=patient.drug.medicinalproduct:%22COBENFY%22+AND+serious:1&limit=3"
)


def get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "concord-hackru/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def main() -> None:
    import pandas as pd

    sources = []

    def record(name: str, url: str, path: Path, note: str) -> None:
        sources.append(
            {
                "name": name,
                "url": url,
                "file": str(path.relative_to(ROOT)),
                "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                "retrieved_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "note": note,
            }
        )

    sdtm_dir = OUT / "sdtm"
    sdtm_dir.mkdir(parents=True, exist_ok=True)
    for dom in SDTM_DOMAINS:
        url = f"{SDTM_BASE}{dom}.xpt"
        df = pd.read_sas(io.BytesIO(get(url)), format="xport", encoding="utf-8")
        path = sdtm_dir / f"{dom}.csv"
        df.to_csv(path, index=False)
        record(f"CDISC pilot SDTM {dom.upper()}", url, path, f"{len(df)} rows, converted XPT -> CSV unchanged")
        print(f"sdtm/{dom}.csv  {len(df)} rows")

    ct_dir = OUT / "ctgov"
    ct_dir.mkdir(parents=True, exist_ok=True)
    study = json.loads(get(CTGOV_URL))
    path = ct_dir / f"{NCT_ID}.json"
    path.write_text(json.dumps(study, indent=1))
    record(f"ClinicalTrials.gov {NCT_ID}", CTGOV_URL, path, "full study record incl. locations")
    print(f"ctgov/{NCT_ID}.json")

    fda_dir = OUT / "openfda"
    fda_dir.mkdir(parents=True, exist_ok=True)
    events = json.loads(get(OPENFDA_URL))
    for r in events["results"]:
        for d in r.get("patient", {}).get("drug", []):
            d.pop("openfda", None)
    path = fda_dir / "sample_events.json"
    path.write_text(json.dumps(events, indent=1))
    record("openFDA drug/event sample", OPENFDA_URL, path, "3 real FAERS reports; used as the schema template only")
    print("openfda/sample_events.json")

    (OUT / "SOURCES.json").write_text(json.dumps(sources, indent=1))
    print(f"wrote {len(sources)} source records -> data/public/SOURCES.json")


if __name__ == "__main__":
    main()
