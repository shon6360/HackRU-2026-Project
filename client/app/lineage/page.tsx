"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { Legend, LineageGraph } from "@/components/lineage-graph";
import { Btn, Card, Empty, Joined, LoadError, Lock, MatchTable, NodeRef, Notice, PageHead, Pill, Spinner, SysBadge, TraceLink } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtInt, plural, tableHref } from "@/lib/format";
import type { Graph, SiteFile, SiteLineage, SiteList, SiteRef } from "@/lib/types";

/* One source file behind the site: a link to the file as received, how many of its rows are the site's, and
   the tables those rows went through. A file with no count holds only the site's id in that system. */
function FileRow({ f }: { f: SiteFile }) {
  return (
    <div className="border-t border-line px-[15px] py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <SysBadge system={f.system} />
        <Link href={tableHref(f.bronze)} title="Open the file as received"><code className="font-semibold">{f.file}</code></Link>
        {f.stale && <Pill tone="warn">stale</Pill>}
        <span className="text-[12.5px] text-ink-2">
          {f.rows === null ? "read to match the site's id" : `${fmtInt(f.rows)} ${plural(f.rows, "row")}`}
          {f.ids.length > 0 && <> · site id here: <Joined items={f.ids.map((id) => <code key={id}>{id}</code>)} /></>}
        </span>
      </div>
      {f.tables.map((t) => (
        <div key={t.dataset} className="mt-1 text-[12.5px] text-ink-2">
          {t.path.slice(1).map((id) => <span key={id}> &rarr; <NodeRef id={id} /></span>)}
          {f.rows !== null && <span className="text-ink-3"> · {fmtInt(t.rows)} {plural(t.rows, "row")}</span>}
          {t.also.length > 0 && <span className="text-ink-3"> · also in <Joined items={t.also.map((id) => <NodeRef key={id} id={id} />)} /></span>}
        </div>
      ))}
    </div>
  );
}

/* One site's lineage: every source file its data came from and where each file's rows went, how its ids were
   matched, and the graph of all of it. The server reads it from the signed-in role's database. */
function SiteView({ site }: { site: SiteRef }) {
  const { data: d, error } = useApi<SiteLineage>(`/api/lineage/site?site_key=${encodeURIComponent(site.site_key)}`);
  const problem = error ?? d?.error;
  if (problem) return <Notice kind="bad" icon="×">{problem}</Notice>;
  if (!d?.graph) return <Spinner />;
  const place = [site.city, site.state].filter(Boolean).join(", ");
  const files = d.files ?? [];
  const reasons = [...new Set((d.withheld ?? []).map((w) => w.denied))];

  return (
    <>
      <h2 className="mb-0.5">{site.site_name}</h2>
      <p className="text-ink-2">
        <TraceLink column="site_key" value={site.site_key} />{place && ` · ${place}`}
      </p>

      <h3 className="mt-4">Source files ({files.length})</h3>
      {files.length === 0 ? <Empty>No source file has rows for this site.</Empty> : (
        <Card>{files.map((f) => <FileRow key={f.file} f={f} />)}</Card>
      )}
      {reasons.map((why) => (
        <Notice key={why} kind="policy" icon={<Lock />} className="mt-2.5">
          The files behind <Joined items={(d.withheld ?? []).filter((w) => w.denied === why).map((w) => <NodeRef key={w.dataset} id={w.dataset} />)} /> are not listed: {why}.
        </Notice>
      ))}

      <h3 className="mt-5">Its id in each system</h3>
      {d.crosswalk?.denied ? <Notice kind="policy" icon={<Lock />}>The crosswalk is {d.crosswalk.denied}.</Notice> : <MatchTable ids={d.crosswalk?.rows ?? []} />}

      <h3 className="mt-5">The path its rows travelled</h3>
      <Legend />
      <LineageGraph graph={d.graph} markTargets />
      <div className="mt-2.5 text-[12.5px] text-ink-2">
        Hover a table or a file for how many of its rows are this site&apos;s.
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
  const [pickedKey, setPickedKey] = useState<string | null>(null);
  const [info, setInfo] = useState<ReactNode>(null);
  const failed = error ?? listError;
  if (failed) return <LoadError message={failed} />;
  if (!g || !listed) return <Spinner />;

  // a name that matches one site shows that site at once; with several, the one picked from the list
  const term = q.trim().toLowerCase();
  const found = term ? listed.sites.filter((s) => s.site_name.toLowerCase().includes(term)) : [];
  const site = found.length === 1 ? found[0] : found.find((s) => s.site_key === pickedKey) ?? null;
  const pick = (s: SiteRef) => { setPickedKey(s.site_key); setQ(s.site_name); };

  return (
    <>
      <PageHead title="Lineage">
        How every table is built, from source files to the tables people query.
      </PageHead>
      <div className="mb-[18px]">
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (!site && found.length) pick(found[0]); }}>
          <input type="text" className="max-w-[440px]" aria-label="Search by site name" disabled={!!listed.denied}
            placeholder="Search by site name…" value={q} onChange={(e) => setQ(e.target.value)} />
          {term && <span className="text-[12.5px] text-ink-3">{found.length} of {listed.sites.length} sites</span>}
          {site && <Btn onClick={() => { setPickedKey(null); setQ(""); setInfo(null); }}>Show the whole graph</Btn>}
        </form>
        {listed.denied && <Notice kind="policy" icon={<Lock />} className="mt-2.5">Site names are {listed.denied}.</Notice>}
        {term && found.length === 0 && <Empty>No site has a name like that.</Empty>}
        {found.length > 1 && (
          <Card className="mt-2.5 max-h-[300px] max-w-[640px] overflow-auto">
            {found.map((s) => (
              <button key={s.site_key} type="button" onClick={() => pick(s)}
                className={`flex w-full flex-wrap items-baseline gap-x-2.5 border-t border-line px-[15px] py-2 text-left first:border-t-0 ${s === site ? "bg-accent-soft" : "hover:bg-surface-2"}`}>
                <b>{s.site_name}</b>
                <span className="font-mono text-[12.5px] text-ink-2">{s.site_key}</span>
                <span className="text-[12.5px] text-ink-3">{[s.city, s.state].filter(Boolean).join(", ")}</span>
              </button>
            ))}
          </Card>
        )}
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
