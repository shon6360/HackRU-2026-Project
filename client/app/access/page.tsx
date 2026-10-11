"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { useApp } from "@/components/app-context";
import { Card, Joined, LoadError, Lock, NodeRef, PageHead, Pill, PlainTable, Spinner, TagPill, Td, Th } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { AccessMatrix } from "@/lib/types";

type View = "tables" | "roles";
type Roles = [string, AccessMatrix["roles"][string]][];

const NONE = <span className="text-ink-3">—</span>;

/* The policy, laid out: what each tag means, then two lists. Tables says what every tagged table gives each
   role, Roles says what each role is granted. Roles are rows in both, never columns, because an administrator
   can add any number of them. The policy itself is metadata, so this page is the same whoever is looking. */
export default function AccessPage() {
  const { role, canManageAccounts } = useApp();
  const [view, setView] = useState<View>("tables");
  const { data: a, error } = useApi<AccessMatrix>("/api/access");
  if (error) return <LoadError message={error} />;
  if (!a) return <Spinner />;
  const roles = Object.entries(a.roles), tags = Object.entries(a.tags);
  const views: [View, string][] = [["tables", `Tables (${a.datasets.length})`], ["roles", `Roles (${roles.length})`]];

  return (
    <>
      <PageHead title="Access">
        {tags.length} tags, {roles.length} roles, one role per account. A table tagged with something a role lacks does not exist for it; a tagged column comes back empty.
      </PageHead>

      <Card pad>
        <h3>Tags</h3>
        <PlainTable>
          <tbody>
            {tags.map(([t, tag]) => <tr key={t}><Td className="whitespace-nowrap"><TagPill tag={t} /></Td><Td>{tag.description}</Td></tr>)}
          </tbody>
        </PlainTable>
      </Card>

      <div className="mt-[18px] flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="What to list" className="inline-flex gap-0.5 rounded-[9px] bg-surface-2 p-[3px]">
          {views.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={view === id} onClick={() => setView(id)}
              className={`rounded-[7px] px-3.5 py-1.5 font-semibold ${view === id ? "bg-surface text-accent-ink shadow-card" : "text-ink-2 hover:text-ink"}`}>
              {label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        {view === "roles" && canManageAccounts && <Link href="/roles" className="text-[12.5px] font-semibold">Add or change a role</Link>}
      </div>

      <Card className="mt-3 overflow-auto">
        {view === "tables" ? <TableList a={a} roles={roles} mine={role} /> : <RoleList a={a} roles={roles} mine={role} />}
      </Card>
    </>
  );
}

/* One row per tagged table: its tags, what the person looking gets, and which roles get less than all of it. */
function TableList({ a, roles, mine }: { a: AccessMatrix; roles: Roles; mine: string }) {
  const names = (ids: string[]): ReactNode => ids.length ? <Joined items={ids.map((id) => a.roles[id].name)} /> : NONE;
  return (
    <PlainTable className="min-w-[760px]">
      <thead><tr><Th>Table</Th><Th>Tagged</Th><Th>Your role</Th><Th>Withheld from</Th><Th>Masked for</Th></tr></thead>
      <tbody>
        {a.datasets.map((d) => {
          const got = d.roles[mine];
          const denied = roles.filter(([id]) => d.roles[id].denied).map(([id]) => id);
          const masked = roles.filter(([id]) => !d.roles[id].denied && d.roles[id].masked.length).map(([id]) => id);
          return (
            <tr key={d.fqn}>
              <Td><NodeRef id={d.fqn} /></Td>
              <Td>
                {d.tags.map((t) => <span key={t}><TagPill tag={t} />{" "}</span>)}
                {Object.entries(d.column_tags).map(([col, ts]) => (
                  <span key={col} className="text-[12.5px] text-ink-2"><code>{col}</code> {ts.map((t) => <TagPill key={t} tag={t} />)}{" "}</span>
                ))}
              </Td>
              <Td className="whitespace-nowrap">
                {!got ? NONE
                  : got.denied ? <Pill tone="bad"><Lock /> withheld</Pill>
                  : got.masked.length ? <Pill tone="violet"><Lock /> {got.masked.length} masked</Pill>
                  : <Pill tone="good">full</Pill>}
              </Td>
              <Td className="text-ink-2">{names(denied)}</Td>
              <Td className="text-ink-2">{names(masked)}</Td>
            </tr>
          );
        })}
      </tbody>
    </PlainTable>
  );
}

/* One row per role: what it is for, each tag granted or not, and how many of the tagged tables it gets less of. */
function RoleList({ a, roles, mine }: { a: AccessMatrix; roles: Roles; mine: string }) {
  const tags = Object.keys(a.tags);
  const held = (yes: boolean) => yes ? <span className="font-bold text-good">✓ granted</span> : <span className="font-bold text-bad">× not granted</span>;
  return (
    <PlainTable className="min-w-[760px]">
      <thead>
        <tr>
          <Th>Role</Th>
          {tags.map((t) => <Th key={t}><TagPill tag={t} /></Th>)}
          <Th>Manage accounts and roles</Th>
          <Th>Tagged tables</Th>
        </tr>
      </thead>
      <tbody>
        {roles.map(([id, r]) => {
          const denied = a.datasets.filter((d) => d.roles[id].denied).length;
          const masked = a.datasets.filter((d) => !d.roles[id].denied && d.roles[id].masked.length).length;
          return (
            <tr key={id}>
              <Td>
                <div className="flex flex-wrap items-center gap-2">
                  <b>{r.name}</b>
                  {id === mine && <Pill tone="accent">your role</Pill>}
                </div>
                <div className="mt-0.5 max-w-[340px] text-[12.5px] text-ink-2">{r.blurb}</div>
              </Td>
              {tags.map((t) => <Td key={t} className="whitespace-nowrap">{held(r.grants.includes(t))}</Td>)}
              <Td className="whitespace-nowrap">{held(!!r.manages_accounts)}</Td>
              <Td className="whitespace-nowrap">
                {denied > 0 && <><Pill tone="bad"><Lock /> {denied} withheld</Pill>{" "}</>}
                {masked > 0 && <Pill tone="violet"><Lock /> {masked} masked</Pill>}
                {!denied && !masked && <Pill tone="good">all full</Pill>}
              </Td>
            </tr>
          );
        })}
      </tbody>
    </PlainTable>
  );
}
