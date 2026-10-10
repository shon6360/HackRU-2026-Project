"""Turn the public snapshot (data/public/) into five mock source-system exports (feeds/).

Deterministic: same seed -> byte-identical feeds. The output is committed, so you only need
to run this if you change the simulation.

    python scripts/simulate_feeds.py

What is real and what is simulated is documented in docs/DATA.md. In short:
  * EDC    - REAL rows from the CDISC pilot SDTM, cut at the snapshot date so the trial is "live"
  * CTMS   - REAL study record + site geography from ClinicalTrials.gov; site names, PIs and
             monitoring visits are synthetic
  * IRT    - synthetic randomization + kit inventory, derived from the real EDC visits/arms
  * Safety - synthetic cases in the openFDA drug/event schema, derived from the real EDC AEs
  * Finance- synthetic site payments, priced off the real EDC visit counts

Every system deliberately uses its own site / subject / study identifiers and date formats,
and a known set of data-quality problems is planted and written to feeds/ANSWER_KEY.json.
"""
from __future__ import annotations

import csv
import json
import random
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "data" / "public"
FEEDS = ROOT / "feeds"

SEED = 40
AS_OF = date(2014, 1, 31)
NCT_ID = "NCT07011732"

rng = random.Random(SEED)
planted: list[dict] = []


def plant(pid: str, system: str, rule: str, key: str, what: str) -> None:
    planted.append({"id": pid, "system": system, "rule_id": rule, "record_key": key, "what": what})


# ----------------------------------------------------------------------------- helpers
def read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, rows: list[dict], cols: list[str] | None = None) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = cols or list(rows[0].keys())
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, lineterminator="\n")
        w.writeheader()
        w.writerows(rows)
    return len(rows)


def d(s: str) -> date | None:
    """Parse the date part of an SDTM ISO 8601 value; partial dates return None."""
    s = (s or "")[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def approx(s: str) -> date:
    """Mid-period stand-in for a partial SDTM date ('2013' or '2013-06')."""
    s = (s or "").strip()
    return d(s + "-15") if len(s) == 7 else d(s[:4] + "-07-01")


def us(x: date | None) -> str:  # CTMS style
    return x.strftime("%m/%d/%Y") if x else ""


def sas(x: date | None) -> str:  # IRT style
    return x.strftime("%d%b%Y").upper() if x else ""


def compact(x: date | None) -> str:  # safety (E2B / openFDA) style
    return x.strftime("%Y%m%d") if x else ""


def eu(x: date | None) -> str:  # finance (ERP) style
    return x.strftime("%d.%m.%Y") if x else ""


def money(x: float) -> str:
    return f"{x:,.2f}"


# Sensitivity classification each source owner declares for their export. Concord's access policy
# is driven entirely by these tags (and the ones on the models built from them).
CLASSIFICATION = {
    "edc/dm.csv": {"tags": ["patient_level"], "column_tags": {"arm": ["unblinded"], "armcd": ["unblinded"],
                                                                 "actarm": ["unblinded"], "actarmcd": ["unblinded"]}},
    "edc/ae.csv": {"tags": ["patient_level"]},
    "edc/sv.csv": {"tags": ["patient_level"]},
    "edc/ds.csv": {"tags": ["patient_level"]},
    "irt/randomization.csv": {"tags": ["patient_level"], "column_tags": {"trt_cd": ["unblinded"], "trt_desc": ["unblinded"]}},
    "irt/kits.csv": {"column_tags": {"kit_type": ["unblinded"], "lot": ["unblinded"], "disp_subject": ["patient_level"]}},
    "safety/cases.json": {"tags": ["patient_level"]},
    "finance/vendors.csv": {"column_tags": {"payment_terms": ["financial"]}},
    "finance/site_payments.csv": {"tags": ["financial"]},
}


def manifest(system: str, name: str, owner: str, steward: str, extracted: datetime, sla_hours: int,
             files: list[dict], notes: str) -> None:
    for f in files:
        f.update(CLASSIFICATION.get(f"{system}/{f['file']}", {}))
    (FEEDS / system / "_manifest.json").write_text(json.dumps({
        "system": system, "system_name": name, "owner": owner, "steward": steward,
        "extracted_at": extracted.isoformat(timespec="seconds"), "freshness_sla_hours": sla_hours,
        "id_conventions": notes, "files": files,
    }, indent=1) + "\n")


# ----------------------------------------------------------------------------- EDC (real)
dm_all = read_csv(PUBLIC / "sdtm" / "dm.csv")
ae_all = read_csv(PUBLIC / "sdtm" / "ae.csv")
sv_all = read_csv(PUBLIC / "sdtm" / "sv.csv")
ds_all = read_csv(PUBLIC / "sdtm" / "ds.csv")


def on_or_before(s: str) -> bool:
    x = d(s)
    return x is not None and x <= AS_OF if len((s or "")[:10]) == 10 else (s or "")[:7] <= AS_OF.strftime("%Y-%m")


def blank_if_after(row: dict, *cols: str) -> None:
    for c in cols:
        x = d(row.get(c, ""))
        if x and x > AS_OF:
            row[c] = ""


dm = [dict(r) for r in dm_all if on_or_before(r["DMDTC"])]
for r in dm:
    r["SITEID"] = str(int(float(r["SITEID"])))
    r["SUBJID"] = str(int(float(r["SUBJID"])))
    r["AGE"] = str(int(float(r["AGE"])))
    if not on_or_before(r["RFSTDTC"]):  # screened but not yet randomized at the snapshot
        for c in ("RFSTDTC", "RFXSTDTC"):
            r[c] = ""
    blank_if_after(r, "RFENDTC", "RFXENDTC", "RFPENDTC", "DTHDTC")
    if not r["DTHDTC"]:
        r["DTHFL"] = ""
    r.pop("DMDY", None)
subjects = {r["USUBJID"]: r for r in dm}

ae = [dict(r) for r in ae_all if r["USUBJID"] in subjects and on_or_before(r["AESTDTC"])]
for r in ae:
    r["AESEQ"] = str(int(float(r["AESEQ"])))
    end = d(r["AEENDTC"])
    if end and end > AS_OF:
        r["AEENDTC"] = ""
        r["AEOUT"] = "NOT RECOVERED/NOT RESOLVED"
    for c in ("AESTDY", "AEENDY", "AELLTCD", "AEPTCD", "AEHLTCD", "AEHLGTCD", "AEBDSYCD", "AESOCCD", "AEDTC"):
        r.pop(c, None)

sv = [dict(r) for r in sv_all if r["USUBJID"] in subjects and on_or_before(r["SVSTDTC"])]
for r in sv:
    r["VISITNUM"] = str(float(r["VISITNUM"])).rstrip("0").rstrip(".")
    r.pop("VISITDY", None)

ds = [dict(r) for r in ds_all if r["USUBJID"] in subjects and on_or_before(r["DSSTDTC"])]
for r in ds:
    r["DSSEQ"] = str(int(float(r["DSSEQ"])))
    for c in ("DSSTDY", "DSSPID", "VISITNUM"):
        r.pop(c, None)

edc_files = [
    {"file": "dm.csv", "rows": write_csv(FEEDS / "edc" / "dm.csv", dm), "description": "SDTM DM - one row per screened subject"},
    {"file": "ae.csv", "rows": write_csv(FEEDS / "edc" / "ae.csv", ae), "description": "SDTM AE - adverse events"},
    {"file": "sv.csv", "rows": write_csv(FEEDS / "edc" / "sv.csv", sv), "description": "SDTM SV - subject visits"},
    {"file": "ds.csv", "rows": write_csv(FEEDS / "edc" / "ds.csv", ds), "description": "SDTM DS - disposition events"},
]
manifest("edc", "Electronic Data Capture (trial database)", "Clinical Data Management", "L. Marchetti",
         datetime(2014, 1, 31, 2, 0), 24, edc_files,
         "Study CDISCPILOT01; site = SITEID '701'; subject = USUBJID '01-701-1015'; ISO 8601 dates")

# Derived facts the other systems are simulated from
site_ids = sorted({r["SITEID"] for r in dm})
randomized = {u: r for u, r in subjects.items() if r["ARM"] != "Screen Failure" and r["RFSTDTC"]}
disposed = {r["USUBJID"] for r in ds if r["DSCAT"] == "DISPOSITION EVENT"}
active = {u for u in randomized if u not in disposed}
active_by_site: dict[str, int] = defaultdict(int)
for u in active:
    active_by_site[subjects[u]["SITEID"]] += 1
first_screen = {s: min(d(r["DMDTC"]) for r in dm if r["SITEID"] == s) for s in site_ids}
# "Reportable" = serious or severe, with onset on/after screening. The real pilot data also holds
# pre-study events with partial dates ('1977'); those are history, not study cases.
reportable = [r for r in ae if (r["AESER"] == "Y" or r["AESEV"] == "SEVERE")
              and r["AESTDTC"][:10] >= subjects[r["USUBJID"]]["DMDTC"][:10]]
reportable_by_site: dict[str, int] = defaultdict(int)
for r in reportable:
    reportable_by_site[subjects[r["USUBJID"]]["SITEID"]] += 1

# The story: two sites are in trouble on all three axes, a few more on one or two.
ranked = sorted(site_ids, key=lambda s: (-(reportable_by_site[s] > 0 and active_by_site[s] > 0),
                                         -reportable_by_site[s], s))
TRIPLE = ranked[:2]
others = [s for s in site_ids if s not in TRIPLE]
with_cases = [s for s in others if reportable_by_site[s] > 0]
with_active = [s for s in others if active_by_site[s] > 0]
OPEN_CASE_SITES = set(TRIPLE) | set(rng.sample(with_cases, 4))
LOW_SUPPLY_SITES = set(TRIPLE) | set(rng.sample(with_active, 3))
OVERDUE_SITES = set(TRIPLE) | set(rng.sample(others, 4))

# ----------------------------------------------------------------------------- CTMS
study = json.loads((PUBLIC / "ctgov" / f"{NCT_ID}.json").read_text())["protocolSection"]
locs = [l for l in study["contactsLocationsModule"]["locations"] if l.get("country") == "United States"]
by_city: dict[tuple, dict] = {}
for l in sorted(locs, key=lambda l: (l["state"], l["city"], l.get("zip", ""))):
    by_city.setdefault((l["state"], l["city"]), l)
cities = list(by_city.values())
rng.shuffle(cities)
# 16 distinct cities + one city that hosts two similarly named sites (the hard matching case)
site_locs = cities[:16] + [cities[0]]

NAME_STYLES = ["Memory & Aging Center", "Neuroscience Research Institute", "Clinical Research Associates",
               "University Medical Center", "Neurology Partners", "Institute for Brain Health",
               "Geriatric Psychiatry Clinic", "Center for Clinical Trials", "Medical Research Group"]
FIRST = ["Amara", "Daniel", "Priya", "Marcus", "Elena", "Hiroshi", "Fatima", "Jonah", "Ingrid", "Rafael",
         "Naomi", "Tobias", "Leila", "Samuel", "Yuki", "Beatriz", "Owen", "Chidi"]
LAST = ["Okafor", "Lindqvist", "Raman", "Delacroix", "Petrov", "Tanaka", "Haddad", "Whitfield", "Sorensen",
        "Mendoza", "Abrams", "Keller", "Farouk", "Osei", "Nakamura", "Cardoso", "Bright", "Eze"]
CRAS = ["J. Alvarez", "M. Chen", "S. Novak", "R. Gupta"]
STATE_ABBR = {"Arizona": "AZ", "California": "CA", "Colorado": "CO", "Florida": "FL", "Louisiana": "LA",
              "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Missouri": "MO", "Nevada": "NV",
              "New Jersey": "NJ", "New York": "NY", "Oklahoma": "OK", "South Carolina": "SC", "Texas": "TX",
              "Utah": "UT", "Vermont": "VT", "Washington": "WA"}

sites: dict[str, dict] = {}
styles = NAME_STYLES * 2
rng.shuffle(styles)
for i, sid in enumerate(site_ids):
    loc = site_locs[i]
    style = styles[i]
    if i == 16:  # same city as site 0: make the names confusable on purpose
        style = "Memory & Aging Institute" if "Memory" in sites[site_ids[0]]["name"] else "Neuroscience Research Center"
    if i == 0:
        style = "Memory & Aging Center"
    sites[sid] = {
        "name": f"{loc['city']} {style}",
        "pi_first": FIRST[i], "pi_last": LAST[i],
        "city": loc["city"], "state": loc["state"], "st": STATE_ABBR[loc["state"]], "zip": loc.get("zip", "")[:5],
        "lat": loc["geoPoint"]["lat"], "lon": loc["geoPoint"]["lon"],
        "activated": first_screen[sid] - timedelta(days=rng.randint(10, 35)),
        "cra": CRAS[i % len(CRAS)],
    }

ctms_sites = []
for sid in site_ids:
    s = sites[sid]
    ctms_sites.append({
        "Site Number": f"SITE-0{sid}", "Site Name": s["name"],
        "Principal Investigator": f"Dr. {s['pi_first']} {s['pi_last']}",
        "City": s["city"], "State/Province": s["state"], "Postal Code": s["zip"], "Country": "United States",
        "Latitude": s["lat"], "Longitude": s["lon"],
        "Site Status": "Active" if active_by_site[sid] else "Enrollment Complete",
        "Activation Date": us(s["activated"]), "CRA": s["cra"], "Protocol": "CDISC-PILOT-01",
    })
# planted: the same site keyed twice with a re-typed name
dup_site = site_ids[5]
dup_row = dict(next(r for r in ctms_sites if r["Site Number"] == f"SITE-0{dup_site}"))
dup_row["Site Name"] = dup_row["Site Name"].replace("&", "and").upper()
ctms_sites.append(dup_row)
plant("P18", "ctms", "uniq_ctms_site_number", f"SITE-0{dup_site}", "same site number listed twice in CTMS with a re-typed name")

mon = []
vid = 5000
last_visit: dict[str, date] = {}
STALE_MONITORING = set(rng.sample([s for s in site_ids if active_by_site[s]], 3))
for sid in site_ids:
    s = sites[sid]
    cur = s["activated"] + timedelta(days=rng.randint(0, 5))
    kind = "Site Initiation Visit"
    stop = AS_OF - timedelta(days=rng.randint(100, 150)) if sid in STALE_MONITORING else AS_OF
    while cur <= stop:
        vid += 1
        is_last = cur + timedelta(days=42) > stop
        mon.append({
            "Visit ID": f"MV-{vid}", "Site Number": f"SITE-0{sid}", "Visit Type": kind,
            "Visit Date": us(cur), "Monitor": s["cra"],
            "Open Action Items": rng.randint(0, 6) if is_last else 0,
            "Protocol Deviations Noted": rng.choice([0, 0, 0, 1, 1, 2, 3]),
            "Report Status": "Draft" if is_last and rng.random() < 0.4 else "Finalized",
        })
        last_visit[sid] = cur
        kind = rng.choice(["Interim Monitoring Visit"] * 4 + ["Remote Monitoring Visit"])
        cur += timedelta(days=rng.randint(42, 70))
vid += 1
mon.append({"Visit ID": f"MV-{vid}", "Site Number": "SITE-0799", "Visit Type": "Interim Monitoring Visit",
            "Visit Date": us(date(2013, 11, 12)), "Monitor": "M. Chen", "Open Action Items": 2,
            "Protocol Deviations Noted": 0, "Report Status": "Finalized"})
plant("P06", "ctms", "fk_monitoring_site", f"MV-{vid}", "monitoring visit for a site number that is not in the site master")
future_mv = mon[len(mon) // 2]
future_mv["Visit Date"] = future_mv["Visit Date"][:6] + "2041"
plant("P12", "ctms", "valid_monitoring_date_not_future", future_mv["Visit ID"], "monitoring visit dated in 2041")

ident = study["identificationModule"]
ctms_study = {
    "protocol_number": "CDISC-PILOT-01",
    "registry_id": ident["nctId"],
    "registry_note": "Registry fields below are the real ClinicalTrials.gov record of a xanomeline Alzheimer's "
                     "study, borrowed because the CDISC pilot study itself has no registry entry.",
    "brief_title": ident["briefTitle"],
    "phase": ",".join(study["designModule"].get("phases", [])),
    "conditions": study["conditionsModule"].get("conditions", []),
    "lead_sponsor": study["sponsorCollaboratorsModule"]["leadSponsor"]["name"],
    "overall_status": study["statusModule"]["overallStatus"],
    "planned_sites": len(site_ids),
}
(FEEDS / "ctms").mkdir(parents=True, exist_ok=True)
(FEEDS / "ctms" / "study.json").write_text(json.dumps(ctms_study, indent=1) + "\n")
manifest("ctms", "Clinical Trial Management System", "Clinical Operations", "D. Abara",
         datetime(2014, 1, 31, 3, 15), 24, [
             {"file": "study.json", "rows": 1, "description": "Study master record"},
             {"file": "sites.csv", "rows": write_csv(FEEDS / "ctms" / "sites.csv", ctms_sites), "description": "Site master"},
             {"file": "monitoring_visits.csv", "rows": write_csv(FEEDS / "ctms" / "monitoring_visits.csv", mon), "description": "Monitoring visit log"},
         ], "Protocol CDISC-PILOT-01; site = 'SITE-0701'; no subject-level data; MM/DD/YYYY dates")

# ----------------------------------------------------------------------------- IRT
ARM_CODE = {"Placebo": ("A", "PBO PATCH"), "Xanomeline Low Dose": ("B", "XAN 54MG PATCH"),
            "Xanomeline High Dose": ("C", "XAN 81MG PATCH")}


def irt_subject(usubjid: str) -> str:
    _, site, subj = usubjid.split("-")
    return f"{site}{subj}"


rand_rows = []
for n, (u, r) in enumerate(sorted(randomized.items(), key=lambda kv: (kv[1]["RFSTDTC"], kv[0])), start=1):
    code, _ = ARM_CODE[r["ARM"]]
    rand_rows.append({
        "RAND_NO": f"R-{n:05d}", "SUBJECT_NO": irt_subject(u), "SITE": f"US{r['SITEID']}",
        "RAND_DT": sas(d(r["RFSTDTC"])), "TRT_CD": code, "TRT_DESC": r["ARM"],
        "STRATUM": "AGE>=75" if int(r["AGE"]) >= 75 else "AGE<75", "STUDY": "PILOT01",
    })
for row in rng.sample(rand_rows, 2):  # planted: randomized before the subject was screened
    u = next(u for u in randomized if irt_subject(u) == row["SUBJECT_NO"])
    row["RAND_DT"] = sas(d(subjects[u]["DMDTC"]) - timedelta(days=rng.randint(20, 60)))
    plant("P08", "irt", "seq_randomized_after_screening", row["SUBJECT_NO"], "IRT randomization date is before the EDC screening date")
rand_rows.append({"RAND_NO": f"R-{len(rand_rows) + 1:05d}", "SUBJECT_NO": "7019999", "SITE": "US701",
                  "RAND_DT": sas(date(2014, 1, 14)), "TRT_CD": "B", "TRT_DESC": "Xanomeline Low Dose",
                  "STRATUM": "AGE<75", "STUDY": "PILOT01"})
plant("P03", "irt", "fk_randomization_subject", "7019999", "IRT randomization for a subject that does not exist in EDC")

DISPENSE_VISITS = {"BASELINE", "WEEK 2", "WEEK 4", "WEEK 6", "WEEK 8", "WEEK 12", "WEEK 16", "WEEK 20", "WEEK 24"}
kits = []
kit_no = 100000
LOTS = {"PBO PATCH": "LP", "XAN 54MG PATCH": "LX54", "XAN 81MG PATCH": "LX81"}


def new_kit(site: str, ktype: str, status: str, expiry: date, subj: str = "", disp: date | None = None) -> dict:
    global kit_no
    kit_no += rng.randint(1, 9)
    row = {"KIT_ID": f"K-{kit_no}", "SITE": f"US{site}", "KIT_TYPE": ktype,
           "LOT": f"{LOTS[ktype]}-{expiry.strftime('%y%m')}", "EXPIRY": sas(expiry), "STATUS": status,
           "DISP_SUBJECT": subj, "DISP_DT": sas(disp)}
    kits.append(row)
    return row


for v in sorted(sv, key=lambda r: (r["SVSTDTC"], r["USUBJID"])):
    if v["VISIT"] in DISPENSE_VISITS and v["USUBJID"] in randomized:
        vd = d(v["SVSTDTC"])
        if vd is None:
            continue
        r = randomized[v["USUBJID"]]
        new_kit(r["SITEID"], ARM_CODE[r["ARM"]][1], "DISPENSED", vd + timedelta(days=rng.randint(120, 400)),
                irt_subject(v["USUBJID"]), vd)
for row in rng.sample([k for k in kits if k["STATUS"] == "DISPENSED"], 2):  # planted: dispensed after expiry
    disp = datetime.strptime(row["DISP_DT"], "%d%b%Y").date()
    row["EXPIRY"] = sas(disp - timedelta(days=rng.randint(5, 40)))
    plant("P10", "irt", "valid_kit_dispensed_before_expiry", row["KIT_ID"], "kit dispensed to a subject after its expiry date")
for sid in site_ids:
    n_active = active_by_site[sid]
    if sid in LOW_SUPPLY_SITES:
        n_avail = rng.randint(0, max(0, n_active - 1))
    else:
        n_avail = n_active * 2 + rng.randint(3, 9)
    for _ in range(n_avail):
        new_kit(sid, rng.choice(list(LOTS)), "AVAILABLE", AS_OF + timedelta(days=rng.randint(45, 300)))
    for _ in range(rng.randint(0, 2)):
        new_kit(sid, rng.choice(list(LOTS)), "EXPIRED", AS_OF - timedelta(days=rng.randint(3, 90)))
    if sid in LOW_SUPPLY_SITES and rng.random() < 0.6:
        for _ in range(rng.randint(4, 8)):
            new_kit(sid, rng.choice(list(LOTS)), "IN_TRANSIT", AS_OF + timedelta(days=rng.randint(200, 330)))
kits.sort(key=lambda k: k["KIT_ID"])
manifest("irt", "Interactive Response Technology (randomization & drug supply)", "Clinical Supply Chain", "W. Brandt",
         datetime(2014, 1, 31, 1, 30), 24, [
             {"file": "randomization.csv", "rows": write_csv(FEEDS / "irt" / "randomization.csv", rand_rows), "description": "Randomization list - UNBLINDED"},
             {"file": "kits.csv", "rows": write_csv(FEEDS / "irt" / "kits.csv", kits), "description": "Kit inventory and dispensing - kit type is UNBLINDING"},
         ], "Study PILOT01; site = 'US701'; subject = '7011015' (site + subject number run together); DDMONYYYY dates")

# ----------------------------------------------------------------------------- Safety (openFDA shape)
ABBREV = [("Center", "Ctr"), ("Institute", "Inst."), ("University", "Univ."), ("Associates", "Assoc."),
          ("Research", "Rsch"), ("Medical", "Med."), (" & ", " and "), ("Clinical", "Clin.")]


typo_rng = random.Random(SEED + 1)  # separate stream, so adding typos does not reshuffle the rest


def typo(name: str) -> str:
    """Drop one interior letter from the longest word, the way a re-keyed name goes wrong."""
    words = name.split(" ")
    i = max(range(len(words)), key=lambda k: len(words[k]))
    w = words[i]
    cut = typo_rng.randint(2, len(w) - 2)
    words[i] = w[:cut] + w[cut + 1:]
    return " ".join(words)


def safety_name(name: str, misspell: bool) -> str:
    out = name
    for a, b in rng.sample(ABBREV, 3):
        out = out.replace(a, b)
    return typo(out) if misspell else out


# every third site is also misspelled; the two same-city sites are left alone (hard enough already)
safety_site_name = {sid: safety_name(sites[sid]["name"], i % 3 == 1 and i not in (0, 16))
                    for i, sid in enumerate(site_ids)}
cases = []
case_no = 10004000
missing_in_safety = rng.sample(reportable, 3)
for r in missing_in_safety:
    plant("P16", "edc", "recon_sae_missing_in_safety", f"{r['USUBJID'][3:]}#{r['AESEQ']}",
          "serious/severe AE recorded in EDC with no case in the safety database")
onset_mismatch = rng.sample([r for r in reportable if r not in missing_in_safety and d(r["AESTDTC"])], 2)

for r in sorted(reportable, key=lambda r: (r["AESTDTC"], r["USUBJID"], int(r["AESEQ"]))):
    if r in missing_in_safety:
        continue
    subj = subjects[r["USUBJID"]]
    sid = subj["SITEID"]
    onset = d(r["AESTDTC"]) or approx(r["AESTDTC"])
    recv = min(AS_OF, onset + timedelta(days=rng.randint(1, 6)))
    resolved = bool(r["AEENDTC"])
    is_open = (sid in OPEN_CASE_SITES and (not resolved or rng.random() < 0.6)) or (sid not in OPEN_CASE_SITES and False)
    case_no += rng.randint(3, 40)
    case_onset = onset
    if r in onset_mismatch:
        case_onset = onset + timedelta(days=rng.choice([-9, -6, 7, 12]))
    case = {
        "safetyreportid": str(case_no), "safetyreportversion": "1",
        "companynumb": f"US-SPONSOR-{recv.year}-{case_no % 100000:06d}",
        "primarysourcecountry": "US", "reporttype": "2",
        "serious": "1" if r["AESER"] == "Y" else "2",
        "seriousnessdeath": "1" if r["AESDTH"] == "Y" else "2",
        "seriousnesshospitalization": "1" if r["AESHOSP"] == "Y" else "2",
        "seriousnesslifethreatening": "1" if r["AESLIFE"] == "Y" else "2",
        "receivedateformat": "102", "receivedate": compact(recv),
        "primarysource": {"reportercountry": "US", "qualification": "1"},
        "patient": {
            "patientonsetage": subj["AGE"], "patientonsetageunit": "801",
            "patientsex": "1" if subj["SEX"] == "M" else "2",
            "reaction": [{"reactionmeddrapt": r["AEDECOD"].capitalize(),
                          "reactionoutcome": "1" if resolved else "3"}],
            "drug": [{"drugcharacterization": "1", "medicinalproduct": "XANOMELINE TTS (BLINDED)"}],
        },
        "study": {"protocol": "CDISCPILOT-01", "site_name": safety_site_name[sid],
                  "investigator": f"{sites[sid]['pi_last'].upper()}, {sites[sid]['pi_first'][0]}",
                  "subject_number": subj["SUBJID"], "onset_date": compact(case_onset)},
        "case": {"status": "OPEN" if is_open else "CLOSED",
                 "followup_due": compact(recv + timedelta(days=rng.choice([15, 30, 45]))) if is_open else "",
                 "assessor": rng.choice(["PV-East", "PV-West"])},
    }
    cases.append(case)
    if r in onset_mismatch:
        plant("P17", "safety", "recon_sae_onset_mismatch", case["safetyreportid"], "onset date in the safety case differs from the EDC AE onset")

# guarantee the story: every OPEN_CASE site has at least one open case
for sid in OPEN_CASE_SITES:
    mine = [c for c in cases if c["study"]["site_name"] == safety_site_name[sid]]
    if mine and not any(c["case"]["status"] == "OPEN" for c in mine):
        c = mine[-1]
        c["case"]["status"] = "OPEN"
        c["case"]["followup_due"] = compact(datetime.strptime(c["receivedate"], "%Y%m%d").date() + timedelta(days=30))

clean = [c for c in cases if c["safetyreportid"] not in {p["record_key"] for p in planted}]
dup_src = clean[7]
dup_case = json.loads(json.dumps(dup_src))
case_no += 17
dup_case["safetyreportid"] = str(case_no)
dup_case["safetyreportversion"] = "2"
cases.append(dup_case)
plant("P02", "safety", "uniq_safety_company_number", dup_case["companynumb"], "same case transmitted twice under two report IDs")

sex_case = clean[12]
sex_case["patient"]["patientsex"] = "2" if sex_case["patient"]["patientsex"] == "1" else "1"
plant("P13", "safety", "consist_sex_edc_vs_safety", sex_case["safetyreportid"], "patient sex in the safety case disagrees with EDC")

future_case = clean[20]
future_case["study"]["onset_date"] = "20990101"
plant("P09", "safety", "valid_case_onset_not_future", future_case["safetyreportid"], "case onset date in 2099")

case_no += 23
cases.append({**json.loads(json.dumps(clean[3])), "safetyreportid": str(case_no),
              "companynumb": f"US-SPONSOR-2013-{case_no % 100000:06d}",
              "study": {**clean[3]["study"], "subject_number": "9999"}})
plant("P05", "safety", "fk_case_subject", str(case_no), "safety case for a subject number that does not exist in EDC")

case_no += 31
cases.append({**json.loads(json.dumps(clean[5])), "safetyreportid": str(case_no),
              "companynumb": f"US-SPONSOR-2013-{case_no % 100000:06d}",
              "study": {**clean[5]["study"], "site_name": "St. Elsewhere Clinic", "investigator": "UNKNOWN"}})
plant("P15", "safety", "xwalk_site_unresolved", "St. Elsewhere Clinic", "site name in a safety case that matches no site in the master")

(FEEDS / "safety").mkdir(parents=True, exist_ok=True)
safety_extract = datetime(2014, 1, 30, 23, 0)
(FEEDS / "safety" / "cases.json").write_text(json.dumps({
    "meta": {"disclaimer": "SIMULATED cases in the openFDA drug/event schema. Not real safety reports.",
             "last_updated": safety_extract.date().isoformat(), "results": {"total": len(cases)}},
    "results": cases}, indent=1) + "\n")
manifest("safety", "Pharmacovigilance safety database", "Global Patient Safety", "N. Iyer", safety_extract, 24, [
    {"file": "cases.json", "rows": len(cases), "description": "Individual case safety reports (openFDA drug/event shape + study/case blocks)"},
], "Protocol CDISCPILOT-01; site = free-text name only, no site number; subject = bare subject number '1015'; YYYYMMDD dates")

# ----------------------------------------------------------------------------- Finance
SUFFIX = [", LLC", " INC", ", P.A.", " FOUNDATION", " LLC", ", INC."]


def legal_name(name: str, misspell: bool) -> str:
    out = name.upper().replace("&", rng.choice(["&", "AND"]))
    return (typo(out) if misspell else out) + rng.choice(SUFFIX)


vendors = []
vendor_of: dict[str, dict] = {}
for i, sid in enumerate(site_ids):
    s = sites[sid]
    v = {"VendorID": f"V-{20400 + i * 7 + rng.randint(0, 5)}", "Vendor Legal Name": legal_name(s["name"], i % 4 == 2 and i not in (0, 16)),
         "City": s["city"].upper(), "State": s["st"], "Payment Terms": rng.choice(["NET30", "NET45"])}
    vendors.append(v)
    vendor_of[sid] = v
courier = {"VendorID": "V-31990", "Vendor Legal Name": "NORTHSTAR COURIER SERVICES INC", "City": "MEMPHIS",
           "State": "TN", "Payment Terms": "NET30"}
vendors.append(courier)
rng.shuffle(vendors)

visits_by_site_q: dict[tuple, int] = defaultdict(int)
for v in sv:
    vd = d(v["SVSTDTC"])
    if vd:
        visits_by_site_q[(subjects[v["USUBJID"]]["SITEID"], vd.year, (vd.month - 1) // 3 + 1)] += 1

fin_extract = datetime(2014, 1, 7, 6, 0)  # planted: this feed is 24 days stale
fin_asof = fin_extract.date()
pay = []
doc = 4500100
for (sid, yr, q), n in sorted(visits_by_site_q.items()):
    q_end = date(yr, q * 3, 28) + timedelta(days=4)
    q_end = q_end - timedelta(days=q_end.day)  # last day of quarter
    inv = q_end + timedelta(days=rng.randint(4, 15))
    if inv > fin_asof:
        continue
    v = vendor_of[sid]
    terms = 30 if v["Payment Terms"] == "NET30" else 45
    due = inv + timedelta(days=terms)
    amount = n * rng.choice([420, 465, 510]) + rng.choice([0, 0, 750, 1500])
    last_two = (yr, q) >= (2013, 3)
    unpaid = (sid in OVERDUE_SITES and last_two) or (inv + timedelta(days=20) > fin_asof)
    paid = None if unpaid else inv + timedelta(days=rng.randint(12, terms + 6))
    if paid and paid > fin_asof:
        paid = None
    doc += rng.randint(1, 30)
    pay.append({"Doc No": str(doc), "VendorID": v["VendorID"], "Payee": v["Vendor Legal Name"], "Project": "PRJ-CDP01",
                "Description": f"Site visit payments {yr} Q{q} ({n} visits)", "Invoice Date": eu(inv),
                "Due Date": eu(due), "Paid Date": eu(paid), "Amount": money(amount), "Currency": "USD",
                "Status": "PAID" if paid else "OPEN"})
for sid in site_ids:  # start-up fee, always paid
    s = sites[sid]
    inv = s["activated"] + timedelta(days=rng.randint(3, 12))
    doc += rng.randint(1, 30)
    v = vendor_of[sid]
    pay.append({"Doc No": str(doc), "VendorID": v["VendorID"], "Payee": v["Vendor Legal Name"], "Project": "PRJ-CDP01",
                "Description": "Site start-up fee", "Invoice Date": eu(inv), "Due Date": eu(inv + timedelta(days=30)),
                "Paid Date": eu(inv + timedelta(days=rng.randint(10, 28))), "Amount": money(rng.choice([4500, 5000, 6500])),
                "Currency": "USD", "Status": "PAID"})
pay.sort(key=lambda r: r["Doc No"])

paid_rows = [p for p in pay if p["Status"] == "PAID"]
pick = rng.sample(paid_rows, 5)
for row in pick[:2]:
    pay.append(dict(row))
    plant("P01", "finance", "uniq_payment_document", row["Doc No"], "payment document appears twice in the extract")
x = pick[2]
x["Paid Date"] = eu(datetime.strptime(x["Invoice Date"], "%d.%m.%Y").date() - timedelta(days=11))
plant("P11", "finance", "seq_paid_after_invoice", x["Doc No"], "paid date is before the invoice date")
x = pick[3]
x["Amount"] = "-" + x["Amount"]
plant("P14", "finance", "valid_payment_amount_positive", x["Doc No"], "negative payment amount")
x = pick[4]
x["Due Date"] = ""
plant("P19", "finance", "complete_payment_due_date", x["Doc No"], "payment with no due date")
doc += 12
pay.append({"Doc No": str(doc), "VendorID": courier["VendorID"], "Payee": courier["Vendor Legal Name"],
            "Project": "PRJ-CDP01", "Description": "Site visit payments 2013 Q3 (misposted)", "Invoice Date": eu(date(2013, 10, 9)),
            "Due Date": eu(date(2013, 11, 8)), "Paid Date": eu(date(2013, 11, 1)), "Amount": money(2310), "Currency": "USD",
            "Status": "PAID"})
plant("P04", "finance", "fk_payment_site", str(doc), "site payment posted to a vendor that is not a study site")
plant("P07", "finance", "fresh_feed_within_sla", "finance", "finance extract is 24 days old against a 7-day SLA")

manifest("finance", "ERP - site payments ledger", "R&D Finance", "C. Whitlock", fin_extract, 168, [
    {"file": "vendors.csv", "rows": write_csv(FEEDS / "finance" / "vendors.csv", vendors), "description": "Vendor master"},
    {"file": "site_payments.csv", "rows": write_csv(FEEDS / "finance" / "site_payments.csv", pay), "description": "Site payment documents"},
], "Project PRJ-CDP01; site = vendor legal name + VendorID, no site number; DD.MM.YYYY dates; amounts as '12,450.00'")

# ----------------------------------------------------------------------------- snapshot + answer key
(FEEDS / "_snapshot.json").write_text(json.dumps({
    "as_of": AS_OF.isoformat(), "seed": SEED,
    "note": "Everything is evaluated as of this date: the EDC extract is cut here so the trial is still running.",
}, indent=1) + "\n")
(FEEDS / "ANSWER_KEY.json").write_text(json.dumps({
    "description": "Data-quality problems planted by scripts/simulate_feeds.py. The pipeline never reads this file; "
                   "only the Quality page does, to score how many the rules caught.",
    "story_sites": {"all_three_problems": TRIPLE, "open_safety_cases": sorted(OPEN_CASE_SITES),
                    "low_supply": sorted(LOW_SUPPLY_SITES), "overdue_payments": sorted(OVERDUE_SITES),
                    "no_recent_monitoring": sorted(STALE_MONITORING)},
    "planted": planted,
}, indent=1) + "\n")

print(f"as of {AS_OF}: {len(dm)} screened, {len(randomized)} randomized, {len(active)} active, {len(site_ids)} sites")
print(f"feeds: edc ae={len(ae)} sv={len(sv)} ds={len(ds)} | ctms mon={len(mon)} | irt rand={len(rand_rows)} kits={len(kits)} "
      f"| safety cases={len(cases)} | finance payments={len(pay)}")
print(f"planted {len(planted)} issues; triple-problem sites: {TRIPLE}")
