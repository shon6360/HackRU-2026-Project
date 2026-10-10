"use client";

import { useApp } from "@/components/app-context";
import { Card, Conf, ConfBadge, LoadError, Lock, Notice, PageHead, PlainTable, Spinner, Stat, SysBadge, Td, Th, TraceLink } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtInt, SYSTEMS } from "@/lib/format";
import type { Crosswalk, XwalkSite } from "@/lib/types";

/* The map that lets one question reach all five systems: every site's id in each of them, with how it was
   matched. Uncertain matches are queued for a steward and unmatched ids are listed, never guessed. */
export default function CrosswalkPage() {
  const { role } = useApp();
  const { data: x, error } = useApi<Crosswalk>(`/api/crosswalk?role=${role}`);
  if (error) return <LoadError message={error} />;
  if (!x) return <Spinner />;
  const review = x.sites.flatMap((site) => site.ids.filter((i) => i.status === "review").map((i) => ({ ...i, site })));

  return (
    <>
      <PageHead title="Crosswalk">
        The same site is <code>SITE-0701</code> in CTMS, <code>701</code> in EDC, <code>US701</code> in IRT, a free-text name in the safety database and a vendor&apos;s legal name in finance.
        This is the map that lets one question reach all five. Every match records its method, a confidence and the evidence; hover any id to read it.
      </PageHead>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 md:grid-cols-4">
        <Stat value={x.sites.length} label="sites, each with one master key" />
        <Stat value={x.counts.auto} label="identifiers matched automatically" />
        <Stat value={x.counts.review} label="matched, queued for a steward" color="text-warn" />
        <Stat value={x.counts.unresolved} label="could not be matched" color="text-bad" />
      </div>

      <Card pad className="mt-3.5">
        <h3>What each system calls things</h3>
        <PlainTable>
          <tbody>
            {x.feeds.map((f) => (
              <tr key={f.system}>
                <Td className="whitespace-nowrap"><SysBadge system={f.system} /></Td>
                <Td>{f.system_name}</Td>
                <Td className="text-[12.5px] text-ink-2">{f.id_conventions}</Td>
              </tr>
            ))}
          </tbody>
        </PlainTable>
      </Card>

      <Card className="mt-3.5">
        <div className="px-[18px] pb-1.5 pt-4"><h3>Sites</h3></div>
        <div className="overflow-auto">
          <PlainTable>
            <thead><tr><Th>Master key</Th><Th>Site</Th>{SYSTEMS.map((s) => <Th key={s}>{s}</Th>)}</tr></thead>
            <tbody>
              {x.sites.map((site) => (
                <tr key={site.site_key}>
                  <Td><TraceLink column="site_key" value={site.site_key} /></Td>
                  <Td>{site.site_name}<div className="text-[12.5px] text-ink-3">{site.city}, {site.state} · {site.pi}</div></Td>
                  {SYSTEMS.map((sys) => <IdCell key={sys} site={site} system={sys} />)}
                </tr>
              ))}
            </tbody>
          </PlainTable>
        </div>
      </Card>

      <div className="mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <Card pad>
          <h3>Queued for a data steward</h3>
          {review.length === 0 ? <p className="text-ink-2">Nothing waiting.</p> : review.map((r) => (
            <div key={`${r.system}:${r.native_id}`} className="mb-2.5">
              <SysBadge system={r.system} /> <code>{r.native_id}</code> {r.native_label}
              <div className="text-[12.5px]">
                matched to <b>{r.site.site_key}</b> at {Number(r.confidence).toFixed(2)}, runner-up {r.runner_up_site_key} at {Number(r.runner_up_confidence).toFixed(2)}
              </div>
              <div className="text-[12.5px] text-ink-2">{r.evidence}</div>
            </div>
          ))}
          <p className="text-[12.5px] text-ink-3">Two sites in the same city with near-identical names: the match is used, and flagged wherever it matters, until a person confirms it.</p>
        </Card>
        <Card pad>
          <h3>Could not be matched</h3>
          {x.unresolved.length === 0 ? <p className="text-ink-2">Everything resolved.</p> : x.unresolved.map((r) => (
            <div key={`${r.system}:${r.native_id}`} className="mb-2.5">
              <SysBadge system={r.system} /> <code>{r.native_id}</code> {r.native_label && r.native_label !== r.native_id ? r.native_label : ""}
              <div className="text-[12.5px] text-ink-2">{r.evidence}</div>
            </div>
          ))}
          <p className="text-[12.5px] text-ink-3">Unmatched identifiers are never guessed. Their rows stay out of site totals and show up as findings on the Quality page.</p>
        </Card>
      </div>

      <Card pad className="mt-3.5">
        <h3>Subjects</h3>
        {x.subjects.denied && <Notice kind="policy" icon={<Lock />} className="mb-2.5">Subject identifiers are {x.subjects.denied}. Counts only.</Notice>}
        <PlainTable>
          <thead><tr><Th>System</Th><Th>How it is matched</Th><Th>Status</Th><Th num>Identifiers</Th><Th>Example</Th></tr></thead>
          <tbody>
            {x.subjects.groups.map((g, i) => (
              <tr key={i}>
                <Td><SysBadge system={g.system} /></Td>
                <Td>{g.method}</Td>
                <Td><Conf status={g.status}>{g.status}</Conf></Td>
                <Td num>{fmtInt(g.n)}</Td>
                <Td>{g.example ? <code>{g.example}</code> : <span className="text-ink-3"><Lock /> withheld</span>}</Td>
              </tr>
            ))}
          </tbody>
        </PlainTable>
      </Card>
    </>
  );
}

/* One system's ids for one site. Ids that follow the system's own numbering need no confidence badge. */
function IdCell({ site, system }: { site: XwalkSite; system: string }) {
  const ids = site.ids.filter((i) => i.system === system);
  if (!ids.length) return <Td className="text-ink-3">—</Td>;
  const showLabel = system !== "ctms" && system !== "edc" && system !== "irt";
  return (
    <Td className="cursor-help whitespace-nowrap font-mono text-[12px]">
      {ids.map((i) => (
        <div key={i.native_id} title={i.evidence ?? undefined}>
          {i.native_id}{i.method !== "id_pattern" && <ConfBadge id={i} />}
          {showLabel && i.native_label && i.native_label !== i.native_id && (
            <span className="block max-w-[210px] overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[11.5px] text-ink-3">{i.native_label}</span>
          )}
        </div>
      ))}
    </Td>
  );
}
