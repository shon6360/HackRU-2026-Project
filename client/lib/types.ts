/* The shapes the server returns from /api/... (server/backend/server.py and server/backend/engine.py). */

export type Cell = string | number | boolean | null;
export type Column = { name: string; type: string; label?: string };

export type Role = { name: string; blurb: string; grants: string[]; manages_accounts?: boolean };

/* A person's account. It holds one role, and the role decides what the account can see. The account's own
   Gemini key never comes back from the server: only whether there is one. */
export type Account = {
  id: number;
  username: string;
  name: string;
  role: string;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  has_gemini_key: boolean;
};
export type Tag = { label: string; description: string };

export type Feed = {
  system: string;
  system_name: string;
  extracted_at: string;
  age_hours: number;
  is_stale: boolean;
  freshness_sla_hours: number;
  owner?: string;
  id_conventions?: string;
};

export type Meta = {
  as_of: string;
  roles: Record<string, Role>;
  tags: Record<string, Tag>;
  feeds: Feed[];
  layers: Record<string, number>;
  model: { available: boolean; id: string };
  questions: { id: string; question: string; systems: string[] }[];
};

export type GraphNode = { id: string; layer: string; label: string; rows?: number; tags?: string[]; system?: string; stale?: boolean };
export type Graph = { nodes: GraphNode[]; edges: [string, string][]; targets?: string[] };

export type Decision = { action: "deny" | "mask"; object: string; column?: string; tags: string[]; reason: string };
export type FailingRule = { rule_id: string; title: string; n_failed: number; severity: string };
export type TrustWarning = { kind: "stale" | "quality"; text: string; rules?: FailingRule[] };

/* One answer: the result of /api/ask or /api/sql. execute() always returns the same dict, with problems in
   `error` and policy outcomes in `decisions` and `denied`; the fields below it come from ask(). */
export type Answer = {
  role?: string;
  sql?: string;
  columns?: Column[];
  rows?: Cell[][];
  row_count?: number;
  truncated?: boolean;
  decisions?: Decision[];
  tables?: string[];
  denied?: boolean;
  error?: string | null;
  masked_columns?: string[];
  traceable?: string[];
  elapsed_ms?: number;
  context?: { graph: Graph; feeds: Feed[]; warnings: TrustWarning[] };

  question?: string | null;
  mode?: "vetted" | "model" | "sql" | "none";
  explanation?: string | null;
  matched_question?: string;
  note?: string;
  model?: string | null;
  model_error?: string | null;
  suggestions?: string[];
};

/* What the policy decides about one query for each role (/api/compare). Nothing is run. */
export type Comparison = { error: string | null; roles: { role: string; denied: boolean; decisions: Decision[] }[] };

export type XwalkId = {
  system: string;
  native_id: string;
  native_label: string | null;
  method: string;
  confidence: number | null;
  status: string;
  runner_up_site_key: string | null;
  runner_up_confidence: number | null;
  evidence: string | null;
};

export type TraceSource = {
  dataset: string;
  description?: string;
  denied?: string;
  total?: number;
  file?: string;
  bronze?: string;
  system?: string;
  columns?: string[];
  rows?: Cell[][];
  masked?: string[];
};

export type Trace = {
  error?: string;
  crosswalk?: { denied?: string; rows?: XwalkId[] } | null;
  sources?: TraceSource[];
};

export type Access = { denied: boolean; denied_tags: string[]; n_masked: number };

export type DatasetSummary = {
  fqn: string;
  schema: string;
  name: string;
  layer: string;
  description: string;
  owner: string;
  steward: string;
  grain: string;
  standard: string | null;
  tags: string[];
  row_count: number;
  upstream_systems: string[];
  stale_systems: string[];
  column_names: string[];
  column_text: string;
  access: Access;
  fair: { passed: number; total: number };
};

export type DatasetColumn = {
  name: string;
  type: string;
  description: string;
  tags: string[];
  null_pct: number;
  n_distinct: number;
  samples: Cell[];
  masked: boolean;
};

export type Rule = {
  rule_id: string;
  title: string;
  dataset: string;
  dimension: string;
  severity: string;
  n_checked: number;
  n_failed: number;
  sql?: string;
};

export type Dataset = Omit<DatasetSummary, "access"> & {
  access: { denied: boolean; denied_tags: string[]; masked: Record<string, string[]>; reason: string | null };
  sql: string | null;
  source_file: string | null;
  columns: DatasetColumn[];
  preview: { columns: string[]; rows: Cell[][] } | null;
  fair_checks: { letter: string; check: string; ok: boolean }[];
  upstream: string[];
  downstream: string[];
  graph: Graph;
  rules: Rule[];
  feeds: Feed[];
};

export type XwalkSite = { site_key: string; site_name: string; city: string; state: string; pi: string; ids: XwalkId[] };

export type Crosswalk = {
  sites: XwalkSite[];
  unresolved: XwalkId[];
  counts: { auto: number; review: number; unresolved: number };
  subjects: { denied: string | null; groups: { system: string; status: string; method: string; n: number; example: string | null }[] };
  feeds: { system: string; system_name: string; id_conventions: string }[];
};

export type Failure = { record_key: string; detail: string; system: string | null; file: string | null; row: number | null; planted: boolean };

export type Quality = {
  rules: (Rule & { hidden: string | null; failures: Failure[] })[];
  dimensions: { dimension: string; rules: number; passing: number; findings: number }[];
  feeds: Feed[];
  answer_key: { n_planted: number; n_caught: number; n_additional: number; additional_by_rule: Record<string, { title: string; n: number; dataset: string }> };
  totals: { rules: number; passing: number; findings: number };
};

export type AccessMatrix = {
  roles: Record<string, Role>;
  tags: Record<string, Tag>;
  datasets: { fqn: string; layer: string; tags: string[]; column_tags: Record<string, string[]>; roles: Record<string, { denied: boolean; masked: string[] }> }[];
};
