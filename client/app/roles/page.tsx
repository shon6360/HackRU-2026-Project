"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useApp } from "@/components/app-context";
import { Btn, Card, Field, Grants, LoadError, Lock, Notice, PageHead, Pill, Spinner, TagPill } from "@/components/ui";
import { api } from "@/lib/api";
import { plural } from "@/lib/format";
import type { Account, Role } from "@/lib/types";

/* Every role, for an administrator: its name, what it is granted, and the form that adds, changes and
   removes one. A role is only a name for a set of grants. What a grant lets someone read is the policy,
   and a database for every combination of grants is already built, so a change here needs no rebuild.
   The page decides nothing: the server refuses these routes to every other role. */
const NEW = "+";  // never a role id: those are made of lower-case letters, digits and underscores

export default function RolesPage() {
  const { canManageAccounts, roleName } = useApp();
  if (canManageAccounts) return <Manage />;
  return (
    <>
      <PageHead title="Roles">The roles an account can hold, and what each is granted.</PageHead>
      <Notice kind="policy" icon={<Lock />}>
        <b>Only an administrator can create and change roles.</b> Your role is {roleName}. The <Link href="/access">Access page</Link> shows every role and what it is granted.
      </Notice>
    </>
  );
}

function Manage() {
  const { meta, role: mine, refresh } = useApp();
  const [holders, setHolders] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);  // the id of the role being changed, or NEW

  // how many accounts hold each role: a role that is held cannot be deleted
  const count = useCallback(() => api<{ accounts: Account[] }>("/api/accounts").then((r) => {
    const n: Record<string, number> = {};
    for (const a of r.accounts) n[a.role] = (n[a.role] ?? 0) + 1;
    setHolders(n);
  }, (e: Error) => setError(e.message)), []);
  useEffect(() => { void count(); }, [count]);

  // the roles on screen are the ones in the metadata, so a saved change shows once that has been loaded again
  const done = async () => { await refresh(); setOpen(null); };

  if (error) return <LoadError message={error} />;
  if (!holders) return <Spinner />;

  return (
    <>
      <PageHead title="Roles">
        A role is a name for a set of grants, and every account holds one. Changing what a role is granted changes what everyone holding it can see, from their next request on, without anyone signing in again.
      </PageHead>

      {open !== NEW && <div className="mb-3.5"><Btn primary onClick={() => setOpen(NEW)}>New role</Btn></div>}

      <div className="grid grid-cols-1 items-start gap-3.5 md:grid-cols-2">
        {open === NEW && <Card pad><h3>New role</h3><RoleForm held={0} onDone={done} onCancel={() => setOpen(null)} /></Card>}
        {Object.entries(meta.roles).map(([id, r]) => {
          const held = holders[id] ?? 0;
          return (
            <Card key={id} pad>
              {open === id ? <RoleForm id={id} role={r} held={held} onDone={done} onCancel={() => setOpen(null)} /> : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="m-0">{r.name}</h2>
                    {id === mine && <Pill tone="accent">your role</Pill>}
                    <span className="flex-1" />
                    <Btn size="sm" onClick={() => setOpen(id)}>Change</Btn>
                  </div>
                  <p className="mb-2.5 mt-2 text-[12.5px]">{r.blurb || <span className="text-ink-3">No description.</span>}</p>
                  <Grants role={r} />
                  <p className="mb-0 mt-2.5 text-[12.5px] text-ink-3">Held by {held} {plural(held, "account")} · id <code>{id}</code></p>
                </>
              )}
            </Card>
          );
        })}
      </div>
    </>
  );
}

function Check({ checked, onChange, children }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode }) {
  return (
    <label className="flex items-start gap-2.5 py-1.5">
      <input type="checkbox" className="mt-[3px] size-4 flex-none accent-accent" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>
    </label>
  );
}

/* One form for both jobs: with a role it changes that role, without one it creates a role. */
function RoleForm({ id, role, held, onDone, onCancel }: { id?: string; role?: Role; held: number; onDone: () => Promise<void>; onCancel: () => void }) {
  const { meta } = useApp();
  const [name, setName] = useState(role?.name ?? "");
  const [blurb, setBlurb] = useState(role?.blurb ?? "");
  const [grants, setGrants] = useState<string[]>(role?.grants ?? []);
  const [manages, setManages] = useState(!!role?.manages_accounts);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (request: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await request();
      await onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!role) { void run(() => api("/api/roles", { name, blurb, grants, manages_accounts: manages })); return; }
    // only what was changed is sent
    const changes = {
      ...(name !== role.name && { name }),
      ...(blurb !== role.blurb && { blurb }),
      ...([...grants].sort().join() !== [...role.grants].sort().join() && { grants }),
      ...(manages !== !!role.manages_accounts && { manages_accounts: manages }),
    };
    if (Object.keys(changes).length === 0) { onCancel(); return; }
    void run(() => api(`/api/roles/${id}`, changes, "PATCH"));
  };

  return (
    <form className="space-y-3" onSubmit={submit}>
      <Field label="Name">
        <input type="text" maxLength={60} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" hint="One or two sentences on who holds this role and why. Shown on the Access page and on each holder&apos;s profile.">
        <textarea rows={2} maxLength={300} value={blurb} onChange={(e) => setBlurb(e.target.value)} />
      </Field>

      <div>
        <span className="mb-0.5 block text-[12.5px] font-semibold text-ink-2">Granted</span>
        {Object.entries(meta.tags).map(([t, tag]) => (
          <Check key={t} checked={grants.includes(t)} onChange={(on) => setGrants(on ? [...grants, t] : grants.filter((g) => g !== t))}>
            <TagPill tag={t} /> <span className="text-[12.5px] text-ink-2">{tag.description}</span>
          </Check>
        ))}
        <Check checked={manages} onChange={setManages}>
          <Pill>Manage accounts and roles</Pill> <span className="text-[12.5px] text-ink-2">Create, change and remove accounts and roles, this one included.</span>
        </Check>
        <p className="mb-0 mt-1 text-[12px] text-ink-3">
          A table tagged with something the role is not granted does not exist for it, and a column tagged that way comes back empty.
          {role && held > 0 && <> {held} {plural(held, "account")} {held === 1 ? "holds" : "hold"} this role and will see the change on their next request.</>}
        </p>
      </div>

      {error && <Notice kind="bad" icon="×">{error}</Notice>}

      <div className="flex flex-wrap items-center gap-2">
        <Btn primary type="submit" disabled={busy}>{role ? "Save changes" : "Create role"}</Btn>
        <Btn onClick={onCancel} disabled={busy}>Cancel</Btn>
        <span className="flex-1" />
        {role && held > 0 && <span className="text-[12.5px] text-ink-3">Held by {held} {plural(held, "account")}, so it cannot be deleted.</span>}
        {role && held === 0 && !confirming && <Btn danger onClick={() => setConfirming(true)} disabled={busy}>Delete role</Btn>}
        {role && held === 0 && confirming && (
          <>
            <span className="text-[13px]">Delete <b>{role.name}</b> for good?</span>
            <Btn danger onClick={() => void run(() => api(`/api/roles/${id}`, undefined, "DELETE"))} disabled={busy}>Yes, delete</Btn>
            <Btn onClick={() => setConfirming(false)} disabled={busy}>Keep</Btn>
          </>
        )}
      </div>
    </form>
  );
}
