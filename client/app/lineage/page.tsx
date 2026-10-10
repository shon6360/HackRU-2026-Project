"use client";

import { useState, type ReactNode } from "react";
import { Legend, LineageGraph } from "@/components/lineage-graph";
import { LoadError, NodeRef, PageHead, Spinner } from "@/components/ui";
import { useApi } from "@/lib/api";
import { plural } from "@/lib/format";
import type { Graph } from "@/lib/types";

/* The whole platform as one graph. Lineage is metadata, so it is the same for every role. */
export default function LineagePage() {
  const { data: g, error } = useApi<Graph>("/api/lineage");
  const [info, setInfo] = useState<ReactNode>(null);
  if (error) return <LoadError message={error} />;
  if (!g) return <Spinner />;

  return (
    <>
      <PageHead title="Lineage">
        How every table is built, from the files each system exports to the tables people query. The graph is read out of the SQL itself, so it cannot drift from what actually runs.
      </PageHead>
      <Legend />
      <LineageGraph graph={g} onSelect={(n, nUp, nDown) => setInfo(n && (
        <>
          <code>{n.id}</code> is built from {nUp} upstream {plural(nUp, "node")} and feeds {nDown} downstream.{" "}
          {!n.id.startsWith("feeds/") && <NodeRef id={n.id} label="Open in the catalog" />}
        </>
      ))} />
      <div className="mt-2.5 text-[12.5px] text-ink-2">{info ?? `${g.nodes.length} nodes, ${g.edges.length} edges.`}</div>
    </>
  );
}
