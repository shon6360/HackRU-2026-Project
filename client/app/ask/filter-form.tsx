"use client";

import type { ReactNode } from "react";
import { useApp } from "@/components/app-context";
import { Btn, Field, Joined, Lock, Notice, Spinner, SysBadge } from "@/components/ui";
import { useApi } from "@/lib/api";
import type { FilterCategory, FilterCondition, FilterField, FilterOptions, FilterSpec } from "@/lib/types";

/* The filter form: a site, a subject, a category of data, and limits on that category's fields. The server
   draws it for the signed-in role (/api/filters), so the lists hold only what the role's own database holds,
   and it writes the query from what is picked (/api/filter). The form decides nothing: a category or a field
   the role may not see is shown with the lock and the server's reason. What is picked lives in the provider,
   so it is still here after a visit to another page. */
export function FilterForm() {
  const { person, roleName, picked, setPicked, runFilter, filtering } = useApp();
  const { data: form, error } = useApi<FilterOptions>("/api/filters");
  if (error) return <Notice kind="bad" icon="×" className="mt-3"><b>Could not load the filters.</b> {error}</Notice>;
  if (!form) return <div className="mt-3"><Spinner /></div>;

  const category = form.categories.find((c) => c.id === picked.category) ?? form.categories[0];
  const subjects = form.subjects.options.filter((s) => !picked.site_key || s.site_key === picked.site_key);
  const set = (change: Partial<FilterSpec>) => setPicked({ ...picked, category: category.id, ...change });
  const setCondition = (i: number, c: FilterCondition) => set({ conditions: picked.conditions.map((old, j) => (j === i ? c : old)) });

  // a subject belongs to one site, so a site that is not theirs lets go of them
  const pickSite = (key: string) => {
    const theirs = form.subjects.options.find((s) => s.subject_key === picked.subject_key)?.site_key;
    set({ site_key: key || null, subject_key: !key || theirs === key ? picked.subject_key : null });
  };
  // a category that is kept per site has nothing to say about one subject: move to the first one that has
  const pickSubject = (key: string) => {
    const perSubject = form.categories.find((c) => c.by_subject && !c.denied) ?? form.categories.find((c) => c.by_subject);
    set({ subject_key: key || null, ...(key && !category.by_subject && perSubject ? { category: perSubject.id, conditions: [] } : {}) });
  };
  const run = () => runFilter({ ...picked, category: category.id, conditions: picked.conditions.filter((c) => isSet(c, category)) });

  return (
    <form className="mt-3" onSubmit={(e) => { e.preventDefault(); run(); }}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Site">
          <select value={picked.site_key ?? ""} onChange={(e) => pickSite(e.target.value)}>
            <option value="">All sites</option>
            {form.sites.map((s) => <option key={s.site_key} value={s.site_key}>{s.site_key} · {s.site_name}</option>)}
          </select>
        </Field>
        <Field label="Subject" hint={form.subjects.denied ? <><Lock /> Subjects are {form.subjects.denied}.</> : picked.site_key ? `${subjects.length} at this site` : undefined}>
          <select value={picked.subject_key ?? ""} disabled={!!form.subjects.denied} onChange={(e) => pickSubject(e.target.value)}>
            <option value="">Any subject</option>
            {subjects.map((s) => <option key={s.subject_key} value={s.subject_key}>{s.subject_key}</option>)}
          </select>
        </Field>
        <Field label="Category of data">
          <select value={category.id} onChange={(e) => set({ category: e.target.value, conditions: [] })}>
            {form.categories.map((c) => {
              const perSite = !!picked.subject_key && !c.by_subject;
              return <option key={c.id} value={c.id} disabled={perSite}>{c.label}{c.denied ? " (withheld)" : perSite ? " (kept per site, not per subject)" : ""}</option>;
            })}
          </select>
        </Field>
      </div>

      <p className="mb-0 mt-2.5 text-[12.5px] text-ink-2">
        {category.description} Reads <Joined sep=" " items={category.systems.map((s) => <SysBadge key={s} system={s} />)} />
      </p>

      {category.denied ? (
        <Notice kind="bad" icon={<Lock />} className="mt-3">
          <b>{person} cannot see {category.label.toLowerCase()}.</b> <code>{category.table}</code> is {category.denied}.
          Running it anyway shows the refusal, and under <b>Compare roles</b> which roles it runs for.
        </Notice>
      ) : (
        <>
          <h3 className="mt-4">Filters</h3>
          {picked.conditions.length === 0 && <p className="text-[12.5px] text-ink-3">None yet, so every row of {category.label.toLowerCase()} for the site and subject above comes back.</p>}
          <div className="space-y-2">
            {picked.conditions.map((c, i) => (
              <ConditionRow key={i} category={category} c={c} onChange={(next) => setCondition(i, next)}
                onRemove={() => set({ conditions: picked.conditions.filter((_, j) => j !== i) })} />
            ))}
          </div>
          <Btn size="sm" className="mt-2" onClick={() => set({ conditions: [...picked.conditions, { field: "" }] })}>+ Add a filter</Btn>
        </>
      )}

      <div className="mt-3.5 flex flex-wrap items-center gap-2.5">
        <Btn primary type="submit" disabled={filtering}>Show results as {person}</Btn>
        {(picked.site_key || picked.subject_key || picked.conditions.length > 0) && (
          <Btn onClick={() => set({ site_key: null, subject_key: null, conditions: [] })}>Clear</Btn>
        )}
      </div>
      <p className="mb-0 mt-2.5 text-[12.5px] text-ink-3">
        No language model is involved: the query is written from what you pick, goes through the same policy check as a question,
        and runs in a database that holds only what the {roleName} role is granted.
      </p>
    </form>
  );
}

/* Whether a filter says anything yet. One that does not is left out of the query, not sent to be refused. */
function isSet(c: FilterCondition, category: FilterCategory): boolean {
  const kind = category.fields.find((f) => f.name === c.field)?.kind;
  if (kind === "choice") return !!c.any_of?.length;
  if (kind === "text") return !!c.contains?.trim();
  if (kind === "flag") return typeof c.equals === "boolean";
  return !!kind && (isGiven(c.min) || isGiven(c.max));
}

const isGiven = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== "";

/* ------------------------------------------------------------------ one filter */
function ConditionRow({ category, c, onChange, onRemove }: { category: FilterCategory; c: FilterCondition; onChange: (c: FilterCondition) => void; onRemove: () => void }) {
  const field = category.fields.find((f) => f.name === c.field);
  return (
    <div className="grid grid-cols-1 items-start gap-2 rounded-[9px] bg-surface-2 p-2.5 sm:grid-cols-[230px_1fr_auto]">
      <select aria-label="Field to filter on" value={field ? c.field : ""} onChange={(e) => onChange({ field: e.target.value })}>
        <option value="">Choose a field…</option>
        {category.fields.map((f) => <option key={f.name} value={f.name} disabled={!!f.masked}>{f.label}{f.masked ? " (withheld)" : ""}</option>)}
      </select>
      <div className="min-w-0">
        {!field ? <p className="mb-0 py-2 text-[12.5px] text-ink-3">Pick what to filter on.</p>
          : field.masked ? <p className="mb-0 py-2 text-[12.5px] text-violet"><Lock /> {field.label} is {field.masked}.</p>
          : <Control field={field} c={c} onChange={onChange} />}
        {field && !field.masked && <Hint field={field} />}
      </div>
      <Btn size="sm" onClick={onRemove}>Remove</Btn>
    </div>
  );
}

/* The control for one kind of field: pick from its values, search its text, give a range, or say yes or no. */
function Control({ field, c, onChange }: { field: FilterField; c: FilterCondition; onChange: (c: FilterCondition) => void }) {
  if (field.kind === "choice") {
    const on = c.any_of ?? [];
    return (
      <div className="flex max-h-[136px] flex-wrap gap-1.5 overflow-auto py-0.5">
        {(field.values ?? []).map((v) => (
          <Toggle key={v} on={on.includes(v)} onClick={() => onChange({ field: c.field, any_of: on.includes(v) ? on.filter((x) => x !== v) : [...on, v] })}>{v}</Toggle>
        ))}
      </div>
    );
  }
  if (field.kind === "flag") {
    return (
      <div className="flex gap-1.5 py-0.5">
        <Toggle on={c.equals === true} onClick={() => onChange({ field: c.field, equals: true })}>Yes</Toggle>
        <Toggle on={c.equals === false} onClick={() => onChange({ field: c.field, equals: false })}>No</Toggle>
      </div>
    );
  }
  if (field.kind === "text") {
    return <input type="text" aria-label={`${field.label} contains`} placeholder="Contains…" autoComplete="off" value={c.contains ?? ""} onChange={(e) => onChange({ field: c.field, contains: e.target.value })} />;
  }
  const date = field.kind === "date";
  const end = (which: "min" | "max", label: string) => (
    <label className="flex flex-1 items-center gap-2 text-[12.5px] text-ink-2">
      <span className="whitespace-nowrap">{label}</span>
      <input type={date ? "date" : "number"} step="any" value={c[which] ?? ""} onChange={(e) => onChange({ ...c, [which]: e.target.value })} />
    </label>
  );
  return <div className="flex flex-col gap-2 sm:flex-row sm:gap-3.5">{end("min", date ? "From" : "At least")}{end("max", date ? "To" : "At most")}</div>;
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick}
      className={`rounded-full border px-2.5 py-1 text-left text-[12.5px] ${on ? "border-accent bg-accent-soft font-semibold text-accent-ink" : "border-line bg-surface text-ink-2 hover:border-accent"}`}>
      {children}
    </button>
  );
}

/* What the field is, and for a range what is on record, so a limit can be set without guessing. */
function Hint({ field }: { field: FilterField }) {
  const range = (field.kind === "number" || field.kind === "date") && isGiven(field.min) ? `On record: ${String(field.min)} to ${String(field.max)}.` : "";
  const many = field.kind === "choice" && (field.values?.length ?? 0) > 1 ? "Pick one or more." : "";
  const text = [field.description && `${field.description.replace(/\.$/, "")}.`, range, many].filter(Boolean).join(" ");
  return text ? <p className="mb-0 mt-1.5 text-[12px] text-ink-3">{text}</p> : null;
}
