

# ONE SOURCE OF TRUTH
### A single trial's data lives in a dozen systems that don't talk to each other. Build the map and the plumbing that let you ask one question across all of them.

---

## 1. The problem, in one breath

Running a trial generates data in many separate systems: the trial database (EDC), trial management (CTMS), drug supply (IRT), central labs, the safety database, the document archive (eTMF), finance, and more. Each uses its own IDs for studies, sites, and patients, its own codes, and its own refresh schedule. Simple questions such as "Which sites have open safety issues *and* low drug supply *and* overdue payments?" require weeks of manual extraction and matching.

The research community's answer is the **FAIR principles**: data should be **F**indable, **A**ccessible, **I**nteroperable, and **R**eusable, for people and machines alike ([Wilkinson et al., 2016](https://www.nature.com/articles/sdata201618)). Building that inside a regulated company also means tracking where every number came from (lineage) and who is allowed to see what.

## 2. Your mission

**Build a mini data ecosystem for clinical development: ingest feeds from several mock systems, harmonize their IDs, catalog everything with metadata and lineage, check quality, and let users ask cross-system questions with role-based access.**

- **Input:** Exports from four or five simulated systems (EDC, CTMS, IRT, safety, finance) with inconsistent IDs and formats.
- **Output:** A harmonized, queryable model, a searchable data catalog with lineage, data-quality dashboards, and cross-system answers.
- **User:** A clinical data engineer or a study team member asking cross-functional questions.

## 3. Clinical trials in 90 seconds

- The same site may be "SITE-0012" in one system, "12" in another, and "Mercy General" in a third.
- Some data is **sensitive**: patient-level data and unblinded treatment arms need strict access control.
- Regulated data needs **lineage**: you must be able to show exactly where a number came from.
- Standards help harmonize: CDISC for trial data, OMOP for health-record data, HL7 FHIR for exchange.

## 4. Words you'll need

| Term | Meaning |
|---|---|
| Data ecosystem / platform | The shared infrastructure for storing, cataloging, and serving data |
| Harmonization | Making data from different sources consistent |
| Master data | Authoritative records for key entities (study, site, person) |
| Data catalog | A searchable inventory of datasets and their meaning |
| Lineage | The trail from a result back to its sources |
| Data quality (DQ) | Completeness, validity, consistency, timeliness |
| FAIR | Findable, Accessible, Interoperable, Reusable |
| RBAC | Role-based access control |

## 5. How it's done today

**Who:** Data engineers, data architects, data stewards, and the many study-team members who need answers.

**Steps:** Request extracts from each system owner, reconcile them in spreadsheets, build one-off reports, and repeat for the next question.

**Example tools:**

| Job | Examples | Notes |
|---|---|---|
| Cloud data platforms | Databricks, Snowflake, AWS, Azure, Google Cloud | Storage and compute |
| Data catalogs | Collibra, Alation, open-source OpenMetadata | Metadata and lineage |
| Open-source building blocks | DuckDB, dbt, Apache Spark | Great for a hackathon |

**Where it breaks:** Every question becomes a project. IDs don't match. Nobody trusts numbers whose origin they can't see. Access rules are inconsistent.

## 6. Data you can get (all free)

| Source | What's in it | How to use it |
|---|---|---|
| [CDISC SDTM/ADaM pilot project](https://github.com/cdisc-org/sdtm-adam-pilot-project) | Trial data in standard CDISC format | Your "EDC" feed |
| [ClinicalTrials.gov API](https://clinicaltrials.gov/data-api/about-api) | Study and site records | Your "CTMS" study and site master data |
| [openFDA drug adverse event API](https://open.fda.gov/apis/drug/event/) | Safety-report-style records | Your "safety database" feed |
| [The Book of OHDSI (free)](https://book.ohdsi.org) | How a large research network harmonizes health data with the OMOP model | Learn harmonization patterns |
| [Wilkinson et al. 2016: The FAIR Guiding Principles (Scientific Data)](https://www.nature.com/articles/sdata201618) | The FAIR principles | Your design checklist |

## 7. Data you'll have to fake (and how)

- **Mock systems:** generate four or five exports for one simulated program, e.g., EDC (from the pilot data), CTMS (sites, visits), IRT (kits, randomization dates), safety (cases), and finance (payments).
- **Make IDs disagree:** different site codes and name spellings, patient IDs with prefixes, dates in different formats.
- **Plant quality problems:** duplicates, orphan records, stale feeds, and impossible dates.
- **Roles:** three user roles with different permissions, e.g., one can't see patient-level data and one can't see unblinded arms.

## 8. Build it: Good / Better / Best

**GOOD: "Harmonize + Ask."** Ingest the mock feeds into a local database (e.g., DuckDB), build a crosswalk that matches site and patient IDs, and answer five cross-system questions in a simple UI. *Demo-able by hour 10.*

**BETTER: "Catalog + Lineage + Quality."** Everything in Good, plus a searchable catalog (what each table means, its owner, its freshness), click-through lineage from any answer to its source rows, and a data-quality dashboard that catches your planted issues.

**BEST: "Ask Anything, Safely."** Everything in Better, plus natural-language questions translated to queries with the generated SQL and lineage shown, and role-based access enforced on every answer (try asking as each role).

## 9. How you'll be judged

| Criterion | What judges look for |
|---|---|
| **Solves the problem** | Would a study team get trustworthy cross-system answers in minutes instead of weeks? |
| **It works** | End-to-end demo. Runs from a clean clone, following the README. |
| **Smart use of data** | Real public data where it exists. Simulated data that is believable and documented. |
| **Explains itself** | Every output shows its evidence and reasoning |
| **Craft and demo** | Clean code, a clear story, and a good UI for the time available |

## 10. Rules of the road

Use public or synthetic data only, and cite every source. Vendor names are examples, not endorsements. Enforce your own access rules in the demo, and show what each role can't see.

---

## 11. Links

**Start here**
- [NIH: Clinical Research Trials and You](https://www.nih.gov/health-information/nih-clinical-research-trials-you)
- [NIAMS: What is a clinical trial?](https://niams.nih.gov/labs/clinical-trials/what-is-clinical-trial)

**Concepts**
- [Wilkinson et al. 2016: The FAIR Guiding Principles (Scientific Data)](https://www.nature.com/articles/sdata201618)
- [The Book of OHDSI (free)](https://book.ohdsi.org)

**Data**
- [CDISC SDTM/ADaM pilot project](https://github.com/cdisc-org/sdtm-adam-pilot-project)
- [ClinicalTrials.gov API](https://clinicaltrials.gov/data-api/about-api)
- [openFDA drug adverse event API](https://open.fda.gov/apis/drug/event/)
- [Synthea](https://github.com/synthetichealth/synthea)

**Standards and APIs**
- [HL7 FHIR R4](https://hl7.org/fhir/R4/)
- [HAPI FHIR test server](https://hapi.fhir.org/)
- [CDISC DDF-RA / USDM (GitHub)](https://github.com/cdisc-org/DDF-RA)

---
<sub>bsky_gd_data_ecosystem_(foundational)</sub>

