"use client";

import { useApp } from "@/components/app-context";
import { Card, LoadError, Lock, Notice, NoticeList, PageHead, Pill, PlainTable, Sev, Spinner, SqlBlock, Stat, SysBadge, Td, Th } from "@/components/ui";
import { useApi } from "@/lib/api";
import { fmtInt, fmtStamp, plural } from "@/lib/format";
import type { Quality } from "@/lib/types";

/* Every rule, what it found, and how the rules score against the answer key of planted problems. Findings
   on a table the role may not see are counted but not shown. */
export default function QualityPage() {
  const { meta } = useApp();
  const { data: q, error } = useApi<Quality>("/api/quality");
  if (error) return <LoadError message={error} />;
  if (!q) return <Spinner />;
  const k = q.answer_key;
  const extra = Object.values(k.additional_by_rule);

  return (
    <>
      <PageHead title="Data quality">
        {q.totals.rules} rules run on every build. Each finding names the record, says what is wrong in plain words and points at the file and row it came from.
        The feeds were seeded with a documented set of problems so the rules can be scored against an answer key.
      </PageHead>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 md:grid-cols-4">
        <Stat value={`${k.n_caught}/${k.n_planted}`} label="planted problems caught" color="text-good" />
        <Stat value={k.n_additional} label="further findings nobody planted" />
        <Stat value={q.totals.findings} label={`findings in all, from ${q.totals.rules - q.totals.passing} of ${q.totals.rules} rules`} />
        <Stat value={`${q.feeds.filter((f) => f.is_stale).length}/${q.feeds.length}`} label="feeds past their freshness SLA" />
      </div>

      <div className="mt-3.5 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <Card pad>
          <h3>Feed freshness, as of {meta.as_of}</h3>
          <PlainTable>
            <tbody>
              {q.feeds.map((f) => (
                <tr key={f.system}>
                  <Td><SysBadge system={f.system} /></Td>
                  <Td className="text-[12.5px]">{f.owner}</Td>
                  <Td className="whitespace-nowrap text-[12.5px]">{fmtStamp(f.extracted_at)}</Td>
                  <Td>
                    {f.is_stale ? <Pill tone="warn">{Math.round(f.age_hours / 24)} days old · SLA {Math.round(f.freshness_sla_hours / 24)}d</Pill> : <Pill tone="good">{Math.round(f.age_hours)}h old</Pill>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </PlainTable>
        </Card>
        <Card pad>
          <h3>By dimension</h3>
          <PlainTable>
            <tbody>
              {q.dimensions.map((d) => (
                <tr key={d.dimension}>
                  <Td>{d.dimension}</Td>
                  <Td className="w-2/5">
                    <div className="h-1.5 min-w-[60px] overflow-hidden rounded-[3px] bg-surface-2">
                      <i className={`block h-full rounded-[3px] ${d.passing < d.rules ? "bg-warn" : "bg-accent"}`} style={{ width: `${Math.round(100 * d.passing / d.rules)}%` }} />
                    </div>
                  </Td>
                  <Td className="whitespace-nowrap text-[12.5px] text-ink-2">{d.passing}/{d.rules} rules passing</Td>
                  <Td num className="text-[12.5px]">{d.findings} {plural(d.findings, "finding")}</Td>
                </tr>
              ))}
            </tbody>
          </PlainTable>
        </Card>
      </div>

      {extra.length > 0 && (
        <Notice kind="info" icon="i" className="mt-3.5">
          <b>{k.n_additional} findings beyond the answer key.</b>{" "}
          Most are partial onset dates in the real CDISC pilot data; the rest are knock-on effects of a planted problem seen from a second system, and the two look-alike sites queued for a steward.
          <NoticeList>{extra.map((e) => <li key={e.title}>{e.n} under “{e.title}”</li>)}</NoticeList>
        </Notice>
      )}

      <Card className="mt-3.5">
        {q.rules.map((r) => (
          <details key={r.rule_id} className="border-t border-line first:border-t-0">
            <summary className="grid list-none grid-cols-[70px_1fr_60px] items-center gap-3 px-4 py-2.5 hover:bg-surface-2 sm:grid-cols-[84px_1fr_130px_110px_70px] [&::-webkit-details-marker]:hidden">
              <Sev severity={r.severity} />
              <span>{r.title}<div className="text-[12.5px] text-ink-3"><code>{r.dataset}</code></div></span>
              <span className="hidden text-[12.5px] text-ink-2 sm:block">{r.dimension}</span>
              <span className="hidden text-right text-[12.5px] tabular-nums text-ink-2 sm:block">{fmtInt(r.n_checked)} checked</span>
              <span className="text-right">{r.n_failed ? <Pill tone="bad">{r.n_failed}</Pill> : <Pill tone="good">pass</Pill>}</span>
            </summary>
            <div className="px-4 pb-3.5 pt-0.5">
              {r.hidden ? (
                <Notice kind="policy" icon={<Lock />}>{r.n_failed} {plural(r.n_failed, "finding")}. The records are {r.hidden}.</Notice>
              ) : r.failures.length === 0 ? <p className="text-[12.5px] text-ink-2">No failing records.</p> : (
                <PlainTable>
                  <thead><tr><Th>Record</Th><Th>What is wrong</Th><Th>Source</Th><Th /></tr></thead>
                  <tbody>
                    {r.failures.map((f, i) => (
                      <tr key={i}>
                        <Td><code>{f.record_key}</code></Td>
                        <Td>{f.detail}</Td>
                        <Td className="whitespace-nowrap text-[12.5px] text-ink-2">{f.file ? `${f.file}${f.row ? `, row ${f.row}` : ""}` : f.system ?? ""}</Td>
                        <Td>{f.planted && <Pill tone="accent" title="In the answer key">planted</Pill>}</Td>
                      </tr>
                    ))}
                  </tbody>
                </PlainTable>
              )}
              {r.sql && (
                <details className="mt-2">
                  <summary className="py-1 text-[12.5px] font-semibold text-ink-2">Rule SQL</summary>
                  <SqlBlock sql={r.sql} />
                </details>
              )}
            </div>
          </details>
        ))}
      </Card>
    </>
  );
}
