"use client";

import { useApp } from "@/components/app-context";
import { Card, Grants, LoadError, Lock, NodeRef, PageHead, Pill, PlainTable, Spinner, TagPill, Td, Th } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { AccessMatrix } from "@/lib/types";

/* The policy, laid out: what each role is granted, what each tag means, and what every tagged table gives
   each role. The policy itself is metadata, so this page is the same whoever is looking. */
export default function AccessPage() {
  const { role } = useApp();
  const { data: a, error } = useApi<AccessMatrix>("/api/access");
  if (error) return <LoadError message={error} />;
  if (!a) return <Spinner />;
  const roles = Object.entries(a.roles), tags = Object.entries(a.tags);

  return (
    <>
      <PageHead title="Access">
        The policy is {tags.length} tags and {roles.length} roles, and every account holds one role. A table carrying a tag the role lacks does not exist for that role; a column carrying one comes back empty.
        A role queries a read-only database that physically contains only what its grants may see, so the rule holds for hand-written SQL and model-written SQL alike.
      </PageHead>

      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
        {roles.map(([id, r]) => (
          <Card key={id} pad>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="m-0">{r.name}</h2>
              <span className="flex-1" />
              {id === role && <Pill tone="accent">your role</Pill>}
            </div>
            <p className="mb-2.5 mt-2 text-[12.5px]">{r.blurb}</p>
            <Grants role={r} />
          </Card>
        ))}
      </div>

      <Card pad className="mt-3.5">
        <h3>What the tags mean</h3>
        <PlainTable>
          <tbody>
            {tags.map(([t, tag]) => <tr key={t}><Td className="whitespace-nowrap"><TagPill tag={t} /></Td><Td>{tag.description}</Td></tr>)}
          </tbody>
        </PlainTable>
      </Card>

      <Card className="mt-3.5">
        <div className="px-[18px] pb-1.5 pt-4"><h3>Every tagged table, and what each role gets</h3></div>
        <div className="overflow-auto">
          <PlainTable>
            <thead><tr><Th>Table</Th><Th>Tagged</Th>{roles.map(([id, r]) => <Th key={id}>{r.name}</Th>)}</tr></thead>
            <tbody>
              {a.datasets.map((d) => (
                <tr key={d.fqn}>
                  <Td><NodeRef id={d.fqn} /></Td>
                  <Td>
                    {d.tags.map((t) => <span key={t}><TagPill tag={t} />{" "}</span>)}
                    {Object.entries(d.column_tags).map(([col, ts]) => (
                      <span key={col} className="text-[12.5px] text-ink-2"><code>{col}</code> {ts.map((t) => <TagPill key={t} tag={t} />)}{" "}</span>
                    ))}
                  </Td>
                  {roles.map(([id]) => {
                    const got = d.roles[id];
                    return (
                      <Td key={id}>
                        {got.denied ? <Pill tone="bad"><Lock /> withheld</Pill>
                          : got.masked.length ? <Pill tone="violet" title={got.masked.join(", ")}><Lock /> {got.masked.length} masked</Pill>
                          : <Pill tone="good">full</Pill>}
                      </Td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </PlainTable>
        </div>
      </Card>
    </>
  );
}
