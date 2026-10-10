import { LAYERS } from "./format";
import type { Graph, GraphNode } from "./types";

export type PlacedNode = GraphNode & { parents: string[]; children: string[]; x: number; y: number };
export type Layout = {
  byId: Map<string, PlacedNode>;
  cols: { layer: string; first: boolean; nodes: PlacedNode[] }[];
  W: number;
  H: number;
  GX: number;
  width: number;
  height: number;
};

/* One column per layer, with extra columns where a layer depends on itself. */
export function layoutGraph(graph: Graph): Layout {
  const byId = new Map<string, PlacedNode>(graph.nodes.map((n) => [n.id, { ...n, parents: [], children: [], x: 0, y: 0 }]));
  for (const [s, d] of graph.edges) {
    if (byId.has(s) && byId.has(d)) { byId.get(d)!.parents.push(s); byId.get(s)!.children.push(d); }
  }
  // rank inside a layer = longest chain of same-layer parents, so same-layer edges still flow left to right
  const rank = new Map<string, number>();
  const rankOf = (id: string): number => {
    if (rank.has(id)) return rank.get(id)!;
    const n = byId.get(id)!;
    const same = n.parents.filter((p) => byId.get(p)!.layer === n.layer);
    const r = same.length ? 1 + Math.max(...same.map(rankOf)) : 0;
    rank.set(id, r);
    return r;
  };
  byId.forEach((_, id) => rankOf(id));

  const cols: Layout["cols"] = [];
  for (const layer of LAYERS) {
    const inLayer = [...byId.values()].filter((n) => n.layer === layer);
    const maxRank = Math.max(-1, ...inLayer.map((n) => rank.get(n.id)!));
    for (let r = 0; r <= maxRank; r++) cols.push({ layer, first: r === 0, nodes: inLayer.filter((n) => rank.get(n.id) === r) });
  }

  const W = 150, H = 26, GX = 26, GY = 8, TOP = 26;
  const y = new Map<string, number>();
  cols.forEach((col, ci) => {
    // order each column by where its parents sit, to keep the edges short
    const centre = (n: PlacedNode) => { const ps = n.parents.filter((p) => y.has(p)); return ps.length ? ps.reduce((a, p) => a + y.get(p)!, 0) / ps.length : 1e6; };
    col.nodes.sort((a, b) => centre(a) - centre(b) || a.id.localeCompare(b.id));
    col.nodes.forEach((n, i) => { n.x = ci * (W + GX) + 8; n.y = TOP + i * (H + GY); y.set(n.id, n.y); });
  });
  const height = TOP + Math.max(1, ...cols.map((c) => c.nodes.length)) * (H + GY) + 6;
  return { byId, cols, W, H, GX, width: cols.length * (W + GX) + 8, height };
}

/* Everything reachable from a node in one direction, the node itself included. */
export function reach(byId: Layout["byId"], id: string, dir: "parents" | "children", seen = new Set<string>()): Set<string> {
  if (seen.has(id)) return seen;
  seen.add(id);
  byId.get(id)?.[dir].forEach((next) => reach(byId, next, dir, seen));
  return seen;
}
