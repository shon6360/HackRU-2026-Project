import type { Cell, Column } from "./types";

/* LAYERS and SYSTEMS repeat what the server knows. A new layer or source system must be added here too,
   with a --layer-* colour in app/globals.css and an entry in LAYER_TONE in components/ui.tsx. */
export const LAYERS = ["source", "bronze", "silver", "master", "gold"];
export const SYSTEMS = ["ctms", "edc", "irt", "safety", "finance"];

export const fmtInt = (n: number) => Number(n).toLocaleString("en-US");
export const plural = (n: number, word: string) => `${word}${n === 1 ? "" : "s"}`;

/* "2014-01-31T06:00:00" -> "2014-01-31 06:00" */
export const fmtStamp = (iso: string) => iso.slice(0, 16).replace("T", " ");

/* A real moment, such as a sign-in, in the reader's own time zone. Study data never goes through this: it is
   dated by the snapshot, and fmtStamp shows it as the source wrote it. */
export const fmtWhen = (iso: string | null) => iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "never";

/* Formatting is driven by the column's name and type, so naming a new gold column to fit gets it formatted for free. */
export function fmtCell(value: Cell | undefined, col: Column): string {
  if (value === null || value === undefined) return "—";
  const name = col.name.toLowerCase(), type = col.type.toUpperCase();
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (name.endsWith("_usd") || name.startsWith("usd_")) return "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (type.includes("INT")) return name.endsWith("_row") || name.includes("number") ? String(value) : fmtInt(value);
    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return String(value);
}

/* A column name as a study team would say it: open_safety_cases is "Open safety cases", n_active is
   "Active (count)". The same rule the server uses for the filter form (`_label` in server/backend/filters.py),
   so a field reads the same in the form and at the top of its column. */
const SPOKEN: Record<string, string> = {
  ae: "AE", sae: "SAE", edc: "EDC", usd: "USD", id: "ID", cra: "CRA", usubjid: "USUBJID",
  no: "number", num: "number", seq: "sequence", pt: "term", doc: "document", rand: "randomization",
  recon: "reconciliation", diff: "difference", followup: "follow-up", followups: "follow-ups", "8w": "for 8 weeks",
};
export function fmtHeader(name: string): string {
  const words = name.replace(/^is_/, "").split("_").filter(Boolean);
  if (!words.length) return name;
  const counted = words[0] === "n" && words.length > 1;
  const text = (counted ? words.slice(1) : words).map((w) => SPOKEN[w.toLowerCase()] ?? w).join(" ");
  return text[0].toUpperCase() + text.slice(1) + (counted ? " (count)" : "");
}

export const tableHref = (fqn: string) => `/catalog?table=${encodeURIComponent(fqn)}`;
