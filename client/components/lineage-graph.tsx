"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { fmtInt, LAYERS, tableHref } from "@/lib/format";
import { layoutGraph, reach } from "@/lib/graph";
import type { Graph } from "@/lib/types";

/* The lineage graph, drawn by hand as inline SVG. Click a node to light up everything upstream and
   downstream of it; click it again to open the table in the catalog. A page that also selects nodes from
   outside the graph, such as from a search, passes `selected` and keeps it up to date from `onSelect`. */

export function Legend() {
  return (
    <div className="my-2 flex flex-wrap gap-3.5 text-[12px] text-ink-2">
      {LAYERS.map((l) => (
        <span key={l}>
          <i className="mr-[5px] inline-block size-2.5 rounded-[2px] align-[-1px]" style={{ background: `var(--layer-${l})` }} />
          {l === "source" ? "source file" : l}
        </span>
      ))}
      <span className="text-ink-3">Click a table to light up everything upstream and downstream; click it again to open it.</span>
    </div>
  );
}

type Props = {
  graph: Graph;
  markTargets?: boolean;
  selected?: string | null;
  onSelect?: (id: string | null) => void;
};

export function LineageGraph({ graph, markTargets, selected: given, onSelect }: Props) {
  const router = useRouter();
  const L = useMemo(() => layoutGraph(graph), [graph]);
  const [own, setOwn] = useState<string | null>(null);
  const picked = given === undefined ? own : given;
  const selected = picked && L.byId.has(picked) ? picked : null;  // a selection does not carry over to a different graph
  const keep = useMemo(() => selected ? new Set([...reach(L.byId, selected, "parents"), ...reach(L.byId, selected, "children")]) : null, [L, selected]);
  const targets = new Set(markTargets ? graph.targets : []);

  const select = (id: string) => {
    if (selected === id) { if (!id.startsWith("feeds/")) router.push(tableHref(id)); return; }
    setOwn(id);
    onSelect?.(id);
  };
  const clear = () => { setOwn(null); onSelect?.(null); };

  return (
    // shrink to fit the page when it is close; scroll sideways when it is not
    <div className="overflow-auto rounded-[10px] border border-line bg-surface" onClick={clear}>
      <svg className="block w-full" viewBox={`0 0 ${L.width} ${L.height}`} style={{ maxWidth: L.width, minWidth: Math.round(L.width * 0.72) }}>
        {L.cols.map((col, ci) => col.first && (
          <text key={ci} x={ci * (L.W + L.GX) + 8} y={14} className="fill-ink-3 font-sans text-[10.5px] font-semibold uppercase tracking-[.08em]">
            {col.layer === "source" ? "source files" : col.layer}
          </text>
        ))}
        {graph.edges.map(([s, d]) => {
          const a = L.byId.get(s), b = L.byId.get(d);
          if (!a || !b) return null;
          const x1 = a.x + L.W, y1 = a.y + L.H / 2, x2 = b.x, y2 = b.y + L.H / 2, mx = (x1 + x2) / 2;
          const on = !!keep && keep.has(s) && keep.has(d);
          return (
            <path key={`${s}>${d}`} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`} fill="none"
              strokeWidth={on ? 1.8 : 1.2} strokeOpacity={on ? 1 : 0.38}
              className={`${on ? "stroke-accent" : "stroke-ink-3"} ${keep && !on ? "opacity-[.22]" : ""}`} />
          );
        })}
        {[...L.byId.values()].map((n) => {
          const hi = n.id === selected, target = targets.has(n.id);
          const stroke = n.stale ? "stroke-warn" : hi || target ? "stroke-accent" : "stroke-line";
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`} className={`cursor-pointer ${keep && !keep.has(n.id) ? "opacity-[.22]" : ""}`}
              onClick={(e) => { e.stopPropagation(); select(n.id); }}>
              <title>{`${n.id}${n.rows !== undefined ? ` · ${fmtInt(n.rows)} rows` : ""}${n.stale ? " · STALE feed" : ""}`}</title>
              <rect width={L.W} height={L.H} rx={6} strokeWidth={target ? 2 : 1} strokeDasharray={n.stale ? "3 2" : undefined}
                className={`${hi ? "fill-accent-soft" : "fill-surface"} ${stroke}`} />
              <rect width={4} height={L.H} rx={2} style={{ fill: `var(--layer-${n.layer})` }} />
              <text x={11} y={17} className="pointer-events-none fill-ink font-mono text-[11px]">{n.label.length > 20 ? n.label.slice(0, 19) + "…" : n.label}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
