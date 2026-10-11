"use client";

import { useMemo, useRef, useState } from "react";
import { Legend, LineageGraph } from "@/components/lineage-graph";
import { Btn, Card, Empty, LoadError, NodeRef, PageHead, Pill, Spinner, SysBadge } from "@/components/ui";
import { useApi } from "@/lib/api";
import { plural } from "@/lib/format";
import { layoutGraph, reach } from "@/lib/graph";
import type { GoldSource, Lineage } from "@/lib/types";

/* Every word has to match the table somewhere. A match in its name counts for more than one in its
   description, and that for more than one in a column or a source file. */
function search(gold: GoldSource[], q: string) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  return gold.flatMap((t) => {
    const name = t.fqn.toLowerCase(), text = t.description.toLowerCase(), cols = t.columns.join(" ").toLowerCase(), files = t.files.join(" ").toLowerCase();
    let score = 0;
    for (const term of terms) {
      const s = (name.includes(term) ? 5 : 0) + (text.includes(term) ? 2 : 0) + (cols.includes(term) || files.includes(term) ? 1 : 0);
      if (!s) return [];
      score += s;
    }
    return [{ t, score, hits: t.columns.filter((c) => terms.some((term) => c.toLowerCase().includes(term))) }];
  }).sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
}

const FileRef = ({ id, stale }: { id: string; stale: boolean }) => (
  <span className="inline-flex flex-wrap items-center gap-1.5">
    <SysBadge system={id.split("/")[1]} /><code>{id}</code>{stale && <Pill tone="warn">stale</Pill>}
  </span>
);

/* The whole platform as one graph. Lineage is metadata, so it is the same for every role. */
export default function LineagePage() {
  const { data: g, error } = useApi<Lineage>("/api/lineage");
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const graphBox = useRef<HTMLDivElement>(null);
  const L = useMemo(() => (g ? layoutGraph(g) : null), [g]);
  const found = useMemo(() => (g ? search(g.gold, q) : []), [g, q]);
  if (error) return <LoadError message={error} />;
  if (!g || !L) return <Spinner />;

  const stale = new Set(g.nodes.filter((n) => n.stale).map((n) => n.id));
  const node = picked ? L.byId.get(picked) : undefined;
  const nUp = node ? reach(L.byId, node.id, "parents").size - 1 : 0, nDown = node ? reach(L.byId, node.id, "children").size - 1 : 0;
  const show = (fqn: string) => { setPicked(fqn); graphBox.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); };

  return (
    <>
      <PageHead title="Lineage">
        How every table is built, from the files each system exports to the tables people query. The graph is read out of the SQL itself, so it cannot drift from what actually runs.
      </PageHead>
      <div className="mb-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <input type="text" className="max-w-[440px]" aria-label="Find the source files behind a gold table"
            placeholder="Find the source files behind a gold table: payment, kit, onset_date…" value={q} onChange={(e) => setQ(e.target.value)} />
          {q.trim() && <span className="text-[12.5px] text-ink-3">{found.length} of {g.gold.length} gold tables</span>}
        </div>
        {q.trim() && (found.length === 0 ? <Empty>No gold table matches. Try part of a table&apos;s name, a column, or a source file.</Empty> : (
          <Card className="mt-2.5 max-h-[420px] overflow-auto">
            {found.map(({ t, hits }) => (
              <div key={t.fqn} className={`border-t border-line px-[15px] py-[11px] first:border-t-0 ${picked === t.fqn ? "bg-accent-soft" : ""}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[13.5px] font-[650]"><span className="font-normal text-ink-3">gold.</span>{t.name}</span>
                  <span className="flex-1" />
                  <Btn size="sm" onClick={() => show(t.fqn)}>Show in the graph</Btn>
                </div>
                <p className="mb-1.5 mt-[3px] line-clamp-2 text-[13px] text-ink-2">{t.description}</p>
                {hits.length > 0 && (
                  <div className="mb-1.5 text-[12.5px] text-ink-2">
                    Columns: {hits.slice(0, 5).map((h, i) => <span key={h}>{i > 0 && ", "}<code>{h}</code></span>)}
                  </div>
                )}
                {t.files.length === 0 ? <div className="text-[12.5px] text-ink-2">No source file: the build makes this table itself.</div> : (
                  <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[12.5px]">
                    <b>Source {plural(t.files.length, "file")}</b>
                    {t.files.map((f) => <FileRef key={f} id={f} stale={stale.has(f)} />)}
                  </div>
                )}
                {t.id_files.length > 0 && (
                  <details className="mt-1 text-[12.5px] text-ink-2">
                    <summary>{t.id_files.length} more {plural(t.id_files.length, "file")} read only to match site and subject ids</summary>
                    <div className="mt-1 flex flex-wrap gap-x-3.5 gap-y-1">{t.id_files.map((f) => <FileRef key={f} id={f} stale={stale.has(f)} />)}</div>
                  </details>
                )}
              </div>
            ))}
          </Card>
        ))}
      </div>
      <Legend />
      <div ref={graphBox}>
        <LineageGraph graph={g} selected={picked} onSelect={setPicked} />
      </div>
      <div className="mt-2.5 text-[12.5px] text-ink-2">
        {node ? (
          <>
            <code>{node.id}</code> is built from {nUp} upstream {plural(nUp, "node")} and feeds {nDown} downstream.{" "}
            {!node.id.startsWith("feeds/") && <NodeRef id={node.id} label="Open in the catalog" />}
          </>
        ) : `${g.nodes.length} nodes, ${g.edges.length} edges.`}
      </div>
    </>
  );
}
