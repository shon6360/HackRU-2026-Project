"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { tableHref } from "@/lib/format";
import type { Role } from "@/lib/types";
import { useApp } from "./app-context";

/* The small pieces every page is built from. Tailwind only sees class names that are written out in full,
   so anything chosen by a value from the API (a tag, a layer, a severity, a match status) is looked up in
   one of the maps below. A new value needs a new entry. */

/* ------------------------------------------------------------------ withheld */
/* Shown wherever something is withheld: a refused query, a masked column, a withheld table, a hidden finding. */
export function Lock() {
  return (
    <svg className="inline-block size-[11px] align-[-1px]" viewBox="0 0 12 12" aria-hidden="true">
      <rect x="2" y="5.2" width="8" height="5.8" rx="1.2" fill="currentColor" />
      <path d="M3.8 5.2V3.6a2.2 2.2 0 0 1 4.4 0v1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/* ------------------------------------------------------------------ pills and badges */
const PILL_TONE = {
  plain: "bg-surface-2 text-ink-2",
  good: "bg-good-soft text-good",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  accent: "bg-accent-soft text-accent-ink",
  violet: "bg-violet-soft text-violet",
  rose: "bg-rose-soft text-rose",
};
const TAG_TONE: Record<string, string> = {
  patient_level: PILL_TONE.rose,
  unblinded: PILL_TONE.violet,
  financial: PILL_TONE.good,
};
const LAYER_TONE: Record<string, string> = {
  source: "bg-surface-2 text-layer-source",
  bronze: "bg-surface-2 text-layer-bronze",
  silver: "bg-surface-2 text-layer-silver",
  master: "bg-violet-soft text-layer-master",
  gold: "bg-warn-soft text-layer-gold",
};
const CONF_TONE: Record<string, string> = {
  auto: "bg-good-soft text-good",
  review: "bg-warn-soft text-warn",
  unresolved: "bg-bad-soft text-bad",
};
const SEV_TONE: Record<string, string> = {
  critical: "text-bad",
  high: "text-warn",
  medium: "text-ink-2",
  low: "text-ink-3",
  info: "text-ink-3",
};

export function Pill({ tone = "plain", colors, title, children }: { tone?: keyof typeof PILL_TONE; colors?: string; title?: string; children: ReactNode }) {
  return <span title={title} className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-px text-[11.5px] font-semibold ${colors ?? PILL_TONE[tone]}`}>{children}</span>;
}

export function TagPill({ tag }: { tag: string }) {
  const { meta } = useApp();
  return <Pill colors={TAG_TONE[tag] ?? PILL_TONE.plain}><Lock /> {meta.tags[tag]?.label || tag}</Pill>;
}

export const LayerPill = ({ layer }: { layer: string }) => <Pill colors={LAYER_TONE[layer] ?? PILL_TONE.plain}>{layer}</Pill>;

export const SysBadge = ({ system }: { system: string }) => (
  <span className="rounded bg-surface-2 px-1.5 py-px font-mono text-[11px] uppercase tracking-[.03em] text-ink-2">{system}</span>
);

export const Conf = ({ status, children }: { status: string; children: ReactNode }) => (
  <span className={`ml-1 inline-block rounded px-[5px] font-sans text-[11px] font-bold ${CONF_TONE[status] ?? ""}`}>{children}</span>
);

/* A crosswalk match: its confidence, or the word when there is no match to have confidence in. */
export const ConfBadge = ({ id }: { id: { status: string; confidence: number | null } }) => (
  <Conf status={id.status}>{id.status === "unresolved" ? "unresolved" : Number(id.confidence).toFixed(2)}</Conf>
);

export const Sev = ({ severity }: { severity: string }) => (
  <span className={`text-[11px] font-bold uppercase tracking-[.05em] ${SEV_TONE[severity] ?? ""}`}>{severity}</span>
);

export const Spinner = () => (
  <span className="inline-block size-[15px] animate-spin rounded-full border-2 border-line border-t-accent align-[-3px] [animation-duration:.7s]" />
);

/* ------------------------------------------------------------------ layout */
export function Card({ pad, flat, className = "", ...rest }: ComponentProps<"div"> & { pad?: boolean; flat?: boolean }) {
  return <div className={`rounded-xl border border-line bg-surface ${flat ? "" : "shadow-card"} ${pad ? "px-[18px] py-4" : ""} ${className}`} {...rest} />;
}

export function PageHead({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-[18px]">
      <h1>{title}</h1>
      <p className="max-w-[760px] text-ink-2">{children}</p>
    </div>
  );
}

export function Stat({ value, label, color = "" }: { value: ReactNode; label: ReactNode; color?: string }) {
  return (
    <Card className="px-4 py-3.5">
      <div className={`text-[26px] font-bold leading-[1.15] tracking-[-.02em] ${color}`}>{value}</div>
      <div className="text-[12.5px] text-ink-2">{label}</div>
    </Card>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="p-[26px] text-center text-ink-2">{children}</div>;

const NOTICE_TONE = {
  policy: { box: "border border-violet/25 bg-violet-soft text-ink", icon: "text-violet" },
  warn: { box: "border border-warn/25 bg-warn-soft", icon: "text-warn" },
  bad: { box: "border border-bad/25 bg-bad-soft", icon: "text-bad" },
  good: { box: "border border-good/25 bg-good-soft", icon: "text-good" },
  info: { box: "bg-surface-2", icon: "" },
};

export function Notice({ kind, icon, className = "", children }: { kind: keyof typeof NOTICE_TONE; icon?: ReactNode; className?: string; children: ReactNode }) {
  const tone = NOTICE_TONE[kind];
  return (
    <div className={`flex items-start gap-2.5 rounded-[9px] px-3.5 py-2.5 text-[13.5px] ${tone.box} ${className}`}>
      {icon !== undefined && <span className={`w-[18px] flex-none text-center font-bold ${tone.icon}`}>{icon}</span>}
      <div>{children}</div>
    </div>
  );
}

/* The bulleted list inside a notice. */
export const NoticeList = ({ children }: { children: ReactNode }) => <ul className="mt-1 list-disc pl-[18px]">{children}</ul>;

export const LoadError = ({ message }: { message: string }) => <Notice kind="bad" icon="×"><b>Could not load this page.</b> {message}</Notice>;

/* ------------------------------------------------------------------ buttons */
const BTN_SIZE = {
  md: "px-[13px] py-[7px]",
  sm: "px-2.5 py-1 text-[12.5px]",
  lg: "p-2.5 text-[15px] sm:px-[22px] sm:py-0",
};

export function Btn({ primary, danger, size = "md", className = "", ...rest }: ComponentProps<"button"> & { primary?: boolean; danger?: boolean; size?: keyof typeof BTN_SIZE }) {
  const tone = primary ? "border-accent bg-accent text-white hover:brightness-[1.07]"
    : danger ? "border-line bg-surface text-bad hover:bg-bad-soft"
    : "border-line bg-surface text-ink hover:bg-surface-2";
  return <button type="button" className={`rounded-lg border font-semibold disabled:cursor-default disabled:opacity-55 ${BTN_SIZE[size]} ${tone} ${className}`} {...rest} />;
}

export const Chip = (props: ComponentProps<"button">) => (
  <button type="button" className="rounded-full border border-line bg-surface px-3 py-[5px] text-left text-[13px] text-ink hover:border-accent hover:text-accent-ink" {...props} />
);

/* A labelled form control. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[12px] text-ink-3">{hint}</span>}
    </label>
  );
}

/* ------------------------------------------------------------------ plain tables */
export function PlainTable({ className = "", ...rest }: ComponentProps<"table">) {
  return <table className={`w-full border-collapse text-[13px] [&_tr:last-child>td]:border-b-0 ${className}`} {...rest} />;
}

export function Th({ num, className = "", ...rest }: ComponentProps<"th"> & { num?: boolean }) {
  return <th className={`border-b border-line px-2.5 py-1.5 text-[11.5px] font-semibold uppercase tracking-[.05em] text-ink-3 ${num ? "text-right" : "text-left"} ${className}`} {...rest} />;
}

export function Td({ num, className = "", ...rest }: ComponentProps<"td"> & { num?: boolean }) {
  return <td className={`border-b border-line px-2.5 py-2 align-top ${num ? "text-right tabular-nums" : ""} ${className}`} {...rest} />;
}

/* Everything a role holds: each data tag, granted or not, and whether it may manage accounts. */
export function Grants({ role }: { role: Role }) {
  const { meta } = useApp();
  const held = (yes: boolean) => yes ? <span className="font-bold text-good">✓ granted</span> : <span className="font-bold text-bad">× not granted</span>;
  return (
    <PlainTable>
      <tbody>
        {Object.keys(meta.tags).map((t) => <tr key={t}><Td><TagPill tag={t} /></Td><Td num>{held(role.grants.includes(t))}</Td></tr>)}
        <tr><Td><Pill>Manage accounts</Pill></Td><Td num>{held(!!role.manages_accounts)}</Td></tr>
      </tbody>
    </PlainTable>
  );
}

/* ------------------------------------------------------------------ links and code */
/* A key that opens the trace drawer: how its ids were matched, and the source rows behind it. */
export function TraceLink({ column, value, children }: { column: string; value: string; children?: ReactNode }) {
  const { openTrace } = useApp();
  return (
    <button type="button" title="Trace to source rows" onClick={() => openTrace(column, value)}
      className="border-b border-dashed border-accent font-mono text-[12.5px] font-semibold text-accent-ink hover:bg-accent-soft">
      {children ?? value}
    </button>
  );
}

/* A table or source file by id. Tables link to the catalog; source files have no page of their own. */
export function NodeRef({ id, label, onClick }: { id: string; label?: ReactNode; onClick?: () => void }) {
  if (id.startsWith("feeds/")) return <code>{id}</code>;
  return <Link href={tableHref(id)} onClick={onClick}>{label ?? <code>{id}</code>}</Link>;
}

export const SqlBlock = ({ sql }: { sql: string }) => (
  <pre className="m-0 max-h-[380px] overflow-auto rounded-[9px] bg-surface-2 px-3.5 py-3 font-mono text-[12.5px] leading-[1.55]">{sql}</pre>
);

/* Comma-separated nodes, without building a string first. */
export function Joined({ items, sep = ", " }: { items: ReactNode[]; sep?: ReactNode }) {
  return <>{items.map((item, i) => <span key={i}>{i > 0 && sep}{item}</span>)}</>;
}
