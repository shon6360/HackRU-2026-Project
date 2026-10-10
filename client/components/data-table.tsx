"use client";

import { fmtCell } from "@/lib/format";
import type { Cell, Column } from "@/lib/types";
import { Lock, TraceLink } from "./ui";

/* Every result grid: an answer, the source rows in the trace drawer. A masked column that
   came back empty says so; a traceable key opens the trace drawer. */
export function DataTable({ columns, rows, masked = [], traceable = [] }: { columns: Column[]; rows: Cell[][]; masked?: string[]; traceable?: string[] }) {
  const isMasked = new Set(masked.map((m) => m.toLowerCase()));
  const isTraceable = new Set(traceable.map((m) => m.toLowerCase()));
  const cell = "border-b border-line px-[11px] py-1.5 align-top";
  return (
    <div className="max-h-[480px] overflow-auto rounded-[10px] border border-line">
      <table className="w-full border-collapse text-[13px] [&_tbody_tr:last-child>td]:border-b-0">
        <thead>
          <tr>
            {columns.map((c, i) => {
              const hidden = isMasked.has(c.name.toLowerCase());
              return (
                <th key={i} className={`sticky top-0 z-[1] whitespace-nowrap border-b border-line bg-surface-2 px-[11px] py-[7px] text-left font-mono text-[12px] font-semibold ${hidden ? "text-violet" : "text-ink-2"}`}>
                  {hidden && <><Lock />{" "}</>}{c.label ?? c.name}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r} className="hover:bg-accent-soft/45">
              {row.map((v, i) => {
                const c = columns[i], key = c.name.toLowerCase();
                if (isMasked.has(key) && v === null) return <td key={i} className={`${cell} whitespace-nowrap bg-violet-soft/55 text-[12px] text-violet`}><Lock /> withheld</td>;
                if (v === null || v === undefined) return <td key={i} className={`${cell} whitespace-nowrap text-ink-3`}>—</td>;
                const text = fmtCell(v, c);
                if (isTraceable.has(key)) return <td key={i} className={`${cell} whitespace-nowrap`}><TraceLink column={c.name} value={String(v)}>{text}</TraceLink></td>;
                const shape = typeof v === "number" ? "whitespace-nowrap text-right tabular-nums" : text.length > 70 ? "min-w-[280px] whitespace-normal" : "whitespace-nowrap";
                return <td key={i} className={`${cell} ${shape}`}>{text}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
