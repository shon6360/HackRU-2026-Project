"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useApp } from "@/components/app-context";
import { Btn, Card, Field, LoadError, Lock, Notice, PageHead, Pill, PlainTable, Spinner, TagPill, Td, Th } from "@/components/ui";
import { api } from "@/lib/api";
import { fmtWhen } from "@/lib/format";
import type { Account } from "@/lib/types";

/* Every account, for an administrator: who can sign in, the role each holds, and the forms to add, change
   and remove them. The page decides nothing. The server refuses these routes to every other role, and it
   is the server that will not let the last administrator be removed. */
export default function AccountsPage() {
  const { canManageAccounts, roleName } = useApp();
  if (canManageAccounts) return <Manage />;
  return (
    <>
      <PageHead title="Accounts">Who can sign in, and with which role.</PageHead>
      <Notice kind="policy" icon={<Lock />}><b>Only an administrator can manage accounts.</b> Your role is {roleName}.</Notice>
    </>
  );
}

function Manage() {
  const { meta, user } = useApp();
  const [list, setList] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | "new" | null>(null);  // the account being changed, or the form for a new one

  const reload = useCallback(() => api<{ accounts: Account[] }>("/api/accounts").then((r) => setList(r.accounts), (e: Error) => setError(e.message)), []);
  useEffect(() => { void reload(); }, [reload]);
  const done = () => { setOpen(null); void reload(); };

  if (error) return <LoadError message={error} />;
  if (!list) return <Spinner />;

  return (
    <>
      <PageHead title="Accounts">
        Who can sign in, and with which role. Roles are set on the <Link href="/roles">Roles page</Link>.
      </PageHead>

      {open === "new"
        ? <Card pad className="mb-3.5"><h3>New account</h3><AccountForm onDone={done} onCancel={() => setOpen(null)} /></Card>
        : <div className="mb-3.5"><Btn primary onClick={() => setOpen("new")}>New account</Btn></div>}

      <Card>
        <div className="overflow-auto">
          <PlainTable>
            <thead><tr><Th>Name</Th><Th>Username</Th><Th>Role</Th><Th>Can see</Th><Th>Status</Th><Th>Last sign-in</Th><Th /></tr></thead>
            <tbody>
              {list.flatMap((a) => {
                const role = meta.roles[a.role];
                const row = (
                  <tr key={a.id}>
                    <Td className="whitespace-nowrap font-semibold">{a.name}{a.id === user.id && <> <Pill tone="accent">you</Pill></>}</Td>
                    <Td><code>{a.username}</code></Td>
                    <Td className="whitespace-nowrap">{role?.name ?? a.role}</Td>
                    <Td>
                      {(role?.grants ?? []).map((t) => <span key={t}><TagPill tag={t} />{" "}</span>)}
                      {role?.manages_accounts && <Pill>Manage accounts and roles</Pill>}
                    </Td>
                    <Td>{a.active ? <Pill tone="good">Active</Pill> : <Pill>Deactivated</Pill>}</Td>
                    <Td className="whitespace-nowrap text-[12.5px]">{fmtWhen(a.last_login_at)}</Td>
                    <Td num>{open !== a.id && <Btn size="sm" onClick={() => setOpen(a.id)}>Change</Btn>}</Td>
                  </tr>
                );
                if (open !== a.id) return [row];
                return [row, <tr key={`${a.id}-form`}><Td colSpan={7} className="bg-surface-2"><AccountForm account={a} onDone={done} onCancel={() => setOpen(null)} /></Td></tr>];
              })}
            </tbody>
          </PlainTable>
        </div>
      </Card>
    </>
  );
}

/* One form for both jobs: with an account it changes that account, without one it creates an account. */
function AccountForm({ account, onDone, onCancel }: { account?: Account; onDone: () => void; onCancel: () => void }) {
  const { meta, user, setUser } = useApp();
  const [name, setName] = useState(account?.name ?? "");
  const [username, setUsername] = useState(account?.username ?? "");
  const [role, setRole] = useState(account?.role ?? Object.keys(meta.roles)[0]);
  const [active, setActive] = useState(account?.active ?? true);
  const [password, setPassword] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const own = account?.id === user.id;

  const run = async (request: () => Promise<Account | null>) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await request();
      if (saved && own) setUser(saved);
      onDone();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!account) { void run(() => api<Account>("/api/accounts", { username, name, role, password })); return; }
    // only what was changed is sent, so the server can tell a new role from an untouched one
    const changes = {
      ...(name !== account.name && { name }),
      ...(username !== account.username && { username }),
      ...(role !== account.role && { role }),
      ...(active !== account.active && { active }),
      ...(password && { password }),
    };
    if (Object.keys(changes).length === 0) { onCancel(); return; }
    void run(() => api<Account>(`/api/accounts/${account.id}`, changes, "PATCH"));
  };

  const remove = () => run(async () => { await api(`/api/accounts/${account!.id}`, undefined, "DELETE"); return null; });

  return (
    <form onSubmit={submit}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Field label="Name">
          <input type="text" maxLength={60} required autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Username" hint="Lower-case letters, digits, dots, hyphens and underscores.">
          <input type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={32} required value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field label="Role" hint={meta.roles[role]?.blurb}>
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            {Object.entries(meta.roles).map(([id, r]) => <option key={id} value={id}>{r.name}</option>)}
          </select>
        </Field>
        {own ? (
          <Field label="Password"><span className="block py-[9px] text-[12.5px] text-ink-2">Change your own password on your profile page.</span></Field>
        ) : (
          <Field label={account ? "New password" : "Password"} hint={account ? "Leave empty to keep the current one." : "At least 8 characters."}>
            <input type="password" autoComplete="new-password" minLength={8} required={!account} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
        )}
      </div>

      {account && (
        <label className="mt-3 flex items-center gap-2 text-[13px]">
          <input type="checkbox" className="size-4 accent-accent" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active. A deactivated account cannot sign in.
        </label>
      )}

      {error && <Notice kind="bad" icon="×" className="mt-3">{error}</Notice>}

      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Btn primary type="submit" disabled={busy}>{account ? "Save changes" : "Create account"}</Btn>
        <Btn onClick={onCancel} disabled={busy}>Cancel</Btn>
        <span className="flex-1" />
        {account && !confirming && <Btn danger onClick={() => setConfirming(true)} disabled={busy}>Delete account</Btn>}
        {account && confirming && (
          <>
            <span className="text-[13px]">Delete <b>{account.name}</b> for good?</span>
            <Btn danger onClick={() => void remove()} disabled={busy}>Yes, delete</Btn>
            <Btn onClick={() => setConfirming(false)} disabled={busy}>Keep</Btn>
          </>
        )}
      </div>
    </form>
  );
}
