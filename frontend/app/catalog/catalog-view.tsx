"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useApp } from "@/components/app-context";
import { Empty, LayerPill, LoadError, Lock, PageHead, Pill, Spinner, TagPill } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtInt, tableHref } from "@/lib/format";
import type { DatasetSummary } from "@/lib/types";
import { DatasetView } from "./dataset-view";

const LAYER_FILTERS = ["all", "gold", "master", "silver", "bronze"];
const LAYER_ORDER: Record<string, number> = { gold: 0, master: 1, silver: 2, bronze: 3 };

export function CatalogView() {
  const table = useSearchParams().get("table");
  return table ? <DatasetView fqn={table} /> : <CatalogList />;
}

/* A match in the table's name counts for more than one in its description, and that for more than one in a column. */
function search(datasets: DatasetSummary[], q: string, layer: string) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  return datasets.flatMap((d) => {
    if (layer !== "all" && d.layer !== layer) return [];
    const name = d.fqn.toLowerCase(), text = `${d.description} ${d.owner} ${d.tags.join(" ")} ${d.standard}`.toLowerCase(), cols = d.column_text.toLowerCase();
    let score = 0;
    for (const t of terms) {
      const s = (name.includes(t) ? 5 : 0) + (text.includes(t) ? 2 : 0) + (cols.includes(t) ? 1 : 0);
      if (!s) return [];
      score += s;
    }
    const hits = terms.length ? d.column_names.filter((c) => terms.some((t) => c.toLowerCase().includes(t))) : [];
    return [{ d, score, hits }];
  }).sort((a, b) => b.score - a.score || LAYER_ORDER[a.d.layer] - LAYER_ORDER[b.d.layer] || a.d.name.localeCompare(b.d.name));
}

function CatalogList() {
  const { catalogFilter: f, setCatalogFilter } = useApp();
  const { data, error } = useApi<{ datasets: DatasetSummary[] }>("/api/catalog");
  if (error) return <LoadError message={error} />;
  if (!data) return <Spinner />;
  const found = search(data.datasets, f.q, f.layer);

  return (
    <>
      <PageHead title="Data catalog">
        Every table in the platform, from raw export to query-ready, with what it means, who owns it, how fresh it is and who may see it.
        Metadata is visible to everyone; the data itself follows the access policy.
      </PageHead>
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <input type="text" className="max-w-[380px]" placeholder="Search tables and columns: overdue, onset, kit, site_key…" value={f.q} onChange={(e) => setCatalogFilter({ ...f, q: e.target.value })} />
        <div className="inline-flex rounded-lg bg-surface-2 p-0.5">
          {LAYER_FILTERS.map((l) => (
            <button key={l} type="button" onClick={() => setCatalogFilter({ ...f, layer: l })}
              className={`rounded-md px-2.5 py-1 text-[12.5px] font-semibold ${f.layer === l ? "bg-surface text-ink shadow-card" : "text-ink-2"}`}>
              {l}
            </button>
          ))}
        </div>
        <span className="text-[12.5px] text-ink-3">{found.length} of {data.datasets.length} tables</span>
      </div>
      {found.length === 0 ? <Empty>Nothing matches.</Empty> : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {found.map(({ d, hits }) => (
            <Link key={d.fqn} href={tableHref(d.fqn)}
              className={`block rounded-xl border border-line bg-surface px-[15px] py-[13px] text-inherit shadow-card hover:border-accent hover:no-underline ${d.access.denied ? "opacity-[.78]" : ""}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13.5px] font-[650]"><span className="font-normal text-ink-3">{d.schema}.</span>{d.name}</span>
                <span className="flex-1" />
                {d.access.denied ? <Pill tone="bad"><Lock /> withheld from you</Pill>
                  : d.access.n_masked ? <Pill tone="violet"><Lock /> {d.access.n_masked} column{d.access.n_masked > 1 ? "s" : ""} masked</Pill> : null}
              </div>
              <p className="mb-2 mt-[5px] line-clamp-2 text-[13px] text-ink-2">{d.description}</p>
              {hits.length > 0 && (
                <div className="-mt-[3px] mb-[7px] text-[12.5px] text-ink-2">
                  Columns: {hits.slice(0, 5).map((h, i) => <span key={h}>{i > 0 && ", "}<code>{h}</code></span>)}
                </div>
              )}
              <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                <LayerPill layer={d.layer} />
                {d.tags.map((t) => <TagPill key={t} tag={t} />)}
                <span className="text-ink-2">{fmtInt(d.row_count)} rows · {d.owner}</span>
                <span className="flex-1" />
                {d.stale_systems.length > 0 && <Pill tone="warn">stale: {d.stale_systems.join(", ")}</Pill>}
                <Pill tone={d.fair.passed === d.fair.total ? "good" : "plain"} title="FAIR checklist">FAIR {d.fair.passed}/{d.fair.total}</Pill>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
