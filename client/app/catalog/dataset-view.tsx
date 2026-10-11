"use client";

import Link from "next/link";
import { Legend, LineageGraph } from "@/components/lineage-graph";
import { Card, Joined, LayerPill, LoadError, Lock, NodeRef, Notice, Pill, PlainTable, Spinner, SqlBlock, SysBadge, TagPill, Td, Th } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtInt, fmtStamp } from "@/lib/format";
import type { Dataset } from "@/lib/types";

/* One table: what it is, how fresh, every column, where it comes from, the quality rules on it and the SQL
   that builds it. A role that cannot query the table can still read about it; what is withheld is the data
   and anything derived from it. */
export function DatasetView({ fqn }: { fqn: string }) {
  const { data: d, error } = useApi<Dataset>(`/api/dataset/${encodeURIComponent(fqn)}`);
  if (error) return <LoadError message={error} />;
  if (!d) return <Spinner />;

  return (
    <>
      <div className="mb-[18px]">
        <div className="text-[12.5px]"><Link href="/catalog">Catalog</Link> / {d.schema}</div>
        <h1 className="mt-1 font-mono text-[21px]">{d.fqn}</h1>
        <div className="mb-2 mt-1.5 flex flex-wrap items-center gap-2">
          <LayerPill layer={d.layer} />
          {d.tags.map((t) => <TagPill key={t} tag={t} />)}
          {d.standard && <Pill>{d.standard}</Pill>}
          {d.stale_systems.length > 0 && <Pill tone="warn">built on a stale feed: {d.stale_systems.join(", ")}</Pill>}
        </div>
        <p className="max-w-[760px] text-ink-2">{d.description}</p>
      </div>

      {d.access.denied && (
        <Notice kind="bad" icon={<Lock />} className="mb-3.5"><b>You can read about this table but not query it.</b> It is {d.access.reason}.</Notice>
      )}

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 md:grid-cols-3">
        <Card pad>
          <h3>About</h3>
          <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-[5px] text-[13px] [&>dt]:text-ink-3">
            <dt>Owner</dt><dd>{d.owner}</dd>
            <dt>Steward</dt><dd>{d.steward}</dd>
            <dt>Grain</dt><dd>{d.grain}</dd>
            <dt>Rows</dt><dd>{fmtInt(d.row_count)}</dd>
            <dt>Source</dt>
            <dd>{d.source_file ? <code>{d.source_file}</code> : d.upstream_systems.length ? <Joined sep=" " items={d.upstream_systems.map((s) => <SysBadge key={s} system={s} />)} /> : "—"}</dd>
          </dl>
        </Card>
        <Card pad>
          <h3>Freshness</h3>
          {d.feeds.length === 0 ? <p className="text-[12.5px] text-ink-2">Not derived from a feed.</p> : (
            <PlainTable>
              <tbody>
                {d.feeds.map((f) => (
                  <tr key={f.system}>
                    <Td><SysBadge system={f.system} /></Td>
                    <Td className="text-[12.5px]">{fmtStamp(f.extracted_at)}</Td>
                    <Td>
                      {f.is_stale ? <Pill tone="warn">{Math.round(f.age_hours / 24)} days old · limit {Math.round(f.freshness_sla_hours / 24)} days</Pill> : <Pill tone="good">up to date</Pill>}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </PlainTable>
          )}
        </Card>
        <Card pad>
          <h3>FAIR checklist · {d.fair.passed}/{d.fair.total}</h3>
          <div className="grid grid-cols-[22px_1fr_20px] items-baseline gap-x-2 gap-y-1.5 text-[13px]">
            {d.fair_checks.map((c, i) => [
              <span key={`l${i}`} className="font-bold text-accent-ink">{c.letter}</span>,
              <span key={`c${i}`}>{c.check}</span>,
              <span key={`o${i}`} className={`font-bold ${c.ok ? "text-good" : "text-bad"}`}>{c.ok ? "✓" : "×"}</span>,
            ])}
          </div>
        </Card>
      </div>

      <Card className="mt-3.5">
        <div className="px-[18px] pb-1.5 pt-4"><h3>Columns</h3></div>
        <div className="overflow-auto">
          <PlainTable>
            <thead><tr><Th>Column</Th><Th>Type</Th><Th>Meaning</Th><Th num>Null</Th><Th num>Distinct</Th><Th>Common values</Th></tr></thead>
            <tbody>
              {d.columns.map((c) => (
                <tr key={c.name}>
                  <Td><code>{c.name}</code>{c.masked && <> <Pill tone="violet" title="Masked for your role"><Lock /> masked</Pill></>}</Td>
                  <Td className="whitespace-nowrap text-[12.5px] text-ink-3">{c.type}</Td>
                  <Td>{c.description} <Joined sep=" " items={c.tags.map((t) => <TagPill key={t} tag={t} />)} /></Td>
                  <Td num className="text-[12.5px]">{c.null_pct}%</Td>
                  <Td num className="text-[12.5px]">{fmtInt(c.n_distinct)}</Td>
                  <Td className="text-[12.5px] text-ink-2">
                    {c.masked || d.access.denied ? <span className="text-ink-3"><Lock /> withheld</span> : <Joined items={c.samples.map((s, i) => <code key={i}>{String(s)}</code>)} />}
                  </Td>
                </tr>
              ))}
            </tbody>
          </PlainTable>
        </div>
      </Card>

      <Card pad className="mt-3.5">
        <h3>Lineage</h3>
        <p className="text-[12.5px] text-ink-2">
          Built from {d.upstream.length ? <Joined items={d.upstream.map((id) => <NodeRef key={id} id={id} />)} /> : "nothing (root)"}
          {d.downstream.length > 0 && <>. Feeds <Joined items={d.downstream.map((id) => <NodeRef key={id} id={id} />)} /></>}.
        </p>
        <Legend />
        <LineageGraph graph={d.graph} markTargets />
      </Card>

      {d.rules.length > 0 && (
        <Card pad className="mt-3.5">
          <h3>Quality rules</h3>
          <PlainTable>
            <tbody>
              {d.rules.map((r) => (
                <tr key={r.rule_id}>
                  <Td>{r.title}</Td>
                  <Td className="text-[12.5px] text-ink-2">{r.dimension}</Td>
                  <Td className="whitespace-nowrap">{r.n_failed ? <Pill tone="bad">{r.n_failed} failing</Pill> : <Pill tone="good">passing</Pill>}</Td>
                </tr>
              ))}
            </tbody>
          </PlainTable>
          <p className="mb-0 mt-2 text-[12.5px]"><Link href="/quality">Open the quality page</Link></p>
        </Card>
      )}

      {d.sql && (
        <Card pad className="mt-3.5">
          <details open>
            <summary className="py-1 font-semibold">SQL</summary>
            <SqlBlock sql={d.sql} />
          </details>
        </Card>
      )}
    </>
  );
}
