"use client";

import { useState, type ReactNode } from "react";
import { Legend, LineageGraph } from "@/components/lineage-graph";
import { Btn, Card, Empty, Joined, LoadError, Lock, MatchTable, NodeRef, Notice, PageHead, PlainTable, Spinner, SysBadge, Td, Th, TraceLink } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtInt, plural } from "@/lib/format";
import type { Graph, SiteLineage, SiteList, SiteRef, SiteTable } from "@/lib/types";

/* Where one table's rows for the site were read from: the source files, or for a summary the tables it adds up. */
function ReadFrom({ t }: { t: SiteTable }) {
  if (!t.rows) return <span className="text-ink-3">Nothing recorded for this site.</span>;
  if (t.summary_of) return <span className="text-ink-2">A summary of <Joined items={t.summary_of.map((id) => <NodeRef key={id} id={id} />)} /></span>;
  const files = t.files ?? [];
  return (
    <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1">
      {files.map((f) => (
        <span key={f.file} className="inline-flex flex-wrap items-center gap-1.5">
          <SysBadge system={f.system} /><code>{f.file}</code>
          {files.length > 1 && <span className="text-[12.5px] text-ink-3">{fmtInt(f.rows)} {plural(f.rows, "row")}</span>}
        </span>
      ))}
    </div>
  );
}

/* One site's lineage: how its ids were matched, which files its rows were read from, and the path they
   travelled. The server reads it from the signed-in role's database, so a withheld table arrives as withheld. */
function SiteView({ site }: { site: SiteRef }) {
  const { data: d, error } = useApi<SiteLineage>(`/api/lineage/site?site_key=${encodeURIComponent(site.site_key)}`);
  const problem = error ?? d?.error;
  if (problem) return <Notice kind="bad" icon="×">{problem}</Notice>;
  if (!d?.graph) return <Spinner />;
  const place = [site.city, site.state].filter(Boolean).join(", ");

  return (
    <>
      <h2 className="mb-0.5">{site.site_name}</h2>
      <p className="text-ink-2">
        <TraceLink column="site_key" value={site.site_key} />{place && ` · ${place}`}. Open the key to see its source rows exactly as each system exported them.
      </p>

      <h3 className="mt-4">Its id in each system</h3>
      {d.crosswalk?.denied ? <Notice kind="policy" icon={<Lock />}>The crosswalk is {d.crosswalk.denied}.</Notice> : <MatchTable ids={d.crosswalk?.rows ?? []} />}

      <h3 className="mt-5">Where its rows come from</h3>
      <Card className="overflow-auto">
        <PlainTable className="min-w-[560px]">
          <thead><tr><Th>Table</Th><Th num>Rows for this site</Th><Th>Read from</Th></tr></thead>
          <tbody>
            {(d.tables ?? []).map((t) => (
              <tr key={t.dataset}>
                <Td>
                  <NodeRef id={t.dataset} />
                  <div className="line-clamp-1 max-w-[420px] text-[12.5px] text-ink-3">{t.description}</div>
                </Td>
                {t.denied ? <Td colSpan={2} className="text-ink-2"><Lock /> Withheld: {t.denied}.</Td> : (
                  <>
                    <Td num>{fmtInt(t.rows ?? 0)}</Td>
                    <Td><ReadFrom t={t} /></Td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </PlainTable>
      </Card>

      <h3 className="mt-5">The path its rows travelled</h3>
      <Legend />
      <LineageGraph graph={d.graph} markTargets />
      <div className="mt-2.5 text-[12.5px] text-ink-2">
        Only the tables that hold rows for this site, the files those rows were read from, and what lies between. Hover over a table or a file for how many of its rows are this site&apos;s.
      </div>
    </>
  );
}

/* The whole platform as one graph, which is metadata and the same for every role, and under the search one
   site's lineage, which is data and follows the role. */
export default function LineagePage() {
  const { data: g, error } = useApi<Graph>("/api/lineage");
  const { data: listed, error: listError } = useApi<SiteList>("/api/lineage/sites");
  const [q, setQ] = useState("");
  const [site, setSite] = useState<SiteRef | null>(null);
  const [info, setInfo] = useState<ReactNode>(null);
  const failed = error ?? listError;
  if (failed) return <LoadError message={failed} />;
  if (!g || !listed) return <Spinner />;

  // the matches are offered while the box holds anything but the name of the site already on screen
  const term = q.trim().toLowerCase();
  const searching = term !== "" && q !== site?.site_name;
  const found = searching ? listed.sites.filter((s) => s.site_name.toLowerCase().includes(term)) : [];
  const pick = (s: SiteRef) => { setSite(s); setQ(s.site_name); };

  return (
    <>
      <PageHead title="Lineage">
        How every table is built, from the files each system exports to the tables people query. The graph is read out of the SQL itself, so it cannot drift from what actually runs.
      </PageHead>
      <div className="mb-[18px]">
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (found.length) pick(found[0]); }}>
          <input type="text" className="max-w-[440px]" aria-label="Search by site name" disabled={!!listed.denied}
            placeholder="Search by site name to see that site's lineage: Merritt Island, Neurology…" value={q} onChange={(e) => setQ(e.target.value)} />
          {searching && <span className="text-[12.5px] text-ink-3">{found.length} of {listed.sites.length} sites</span>}
          {site && <Btn onClick={() => { setSite(null); setQ(""); setInfo(null); }}>Show the whole graph</Btn>}
        </form>
        {listed.denied && <Notice kind="policy" icon={<Lock />} className="mt-2.5">Site names are {listed.denied}.</Notice>}
        {searching && (found.length === 0 ? <Empty>No site has a name like that.</Empty> : (
          <Card className="mt-2.5 max-h-[300px] max-w-[640px] overflow-auto">
            {found.map((s) => (
              <button key={s.site_key} type="button" onClick={() => pick(s)}
                className="flex w-full flex-wrap items-baseline gap-x-2.5 border-t border-line px-[15px] py-2 text-left first:border-t-0 hover:bg-surface-2">
                <b>{s.site_name}</b>
                <span className="font-mono text-[12.5px] text-ink-2">{s.site_key}</span>
                <span className="text-[12.5px] text-ink-3">{[s.city, s.state].filter(Boolean).join(", ")}</span>
              </button>
            ))}
          </Card>
        ))}
      </div>
      {site ? <SiteView key={site.site_key} site={site} /> : (
        <>
          <Legend />
          <LineageGraph graph={g} onSelect={(n, nUp, nDown) => setInfo(n && (
            <>
              <code>{n.id}</code> is built from {nUp} upstream {plural(nUp, "node")} and feeds {nDown} downstream.{" "}
              {!n.id.startsWith("feeds/") && <NodeRef id={n.id} label="Open in the catalog" />}
            </>
          ))} />
          <div className="mt-2.5 text-[12.5px] text-ink-2">{info ?? `${g.nodes.length} nodes, ${g.edges.length} edges.`}</div>
        </>
      )}
    </>
  );
}
