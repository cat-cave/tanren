/**
 * Narrow response types for the orchestrator product APIs the shell consumes.
 *
 * These mirror the JSON shapes returned by the orchestrator routes the shell
 * depends on (orgs, projects, forge tools). They are intentionally local and
 * minimal — the shell only reads the fields it renders. Where the orchestrator
 * contract widens, widen these alongside it (they are not auto-derived).
 */

/** An organization the operator is a member of (`GET /orgs`). */
export interface OrgSummary {
  id: string;
  kind: string;
  login: string;
  displayName: string | null;
  role: string;
}

/** A project within an org (`GET /orgs/:orgId/projects`). */
export interface ProjectSummary {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  runnerImage: string | null;
  allocator: string | null;
}

/**
 * A single palette item surfaced from the Forge tool surface (P2A-0019).
 * `kind` distinguishes read actions (route in the shell) from write actions
 * (call the operator-button endpoint) and ask-forge prompts (open a thread).
 */
export interface PaletteItem {
  glyph: string;
  kanji?: boolean;
  title: string;
  desc: string;
  /** Read actions carry an in-shell route to navigate to. */
  route?: string;
  /** Write actions carry a Forge tool id invoked via `POST .../forge/tools`. */
  tool?: string;
  /** Optional pre-filled args for a write tool. */
  args?: Record<string, unknown>;
}

/** A named group of palette items (`quick actions`, `forge this`, `ask forge`). */
export interface PaletteGroup {
  group: string;
  items: PaletteItem[];
}

// ---------------------------------------------------------------------------
// P2B-0005: history & costs — consumes P2A-0014 run-list + P2A-0011 cost
// records. These mirror the orchestrator's frozen run-detail API contract
// (services/orchestrator/src/routes/runs/contract.ts). They are intentionally
// local + read-only; the shell only reads what it renders.
// ---------------------------------------------------------------------------

/**
 * How a credential is billed — the operator-facing "pricing model" axis from
 * PROJECT_BRIEF §4. `per_token` (token-billed API), `subscription`
 * (server-enforced window), `self_hosted` (flat-fee / local GPU, opportunity
 * cost). Mirrors `RunCostRecord.billingMode`.
 */
export type BillingMode = "per_token" | "subscription" | "self_hosted";

/**
 * How a dollar figure (if any) was derived. `ccusage` (real billed/computed
 * cost from the CLI's own session logs), `provider_pricing` (computed from a
 * known per-token price table), `unknown` (no reliable basis — `costUsd` is
 * null; an HONEST, allowed state, never a fabricated placeholder). Mirrors the
 * frozen `RunCostRecord.costBasis` enum shipped in P2A-0011.
 */
export type CostBasis = "ccusage" | "provider_pricing" | "unknown";

/**
 * A single cost record (`GET .../runs/:runId/costs` items). Token accounting is
 * first-class and always present; `costUsd` is best-effort and null for
 * subscription / self-hosted / unpriced calls.
 */
export interface CostRecord {
  id: number | string;
  runId: string;
  taskId: string;
  projectId: string;
  cli: string;
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Fixed-precision dollar string, or null when the basis is `unknown`. */
  costUsd: string | null;
  billingMode: BillingMode;
  costBasis: CostBasis;
  recordedAt: string;
}

/**
 * A run summary row for the history list (`GET .../runs` items). Extends the
 * base run summary with the spec title, an aggregated run-level cost total, the
 * last event timestamp, and the review-needed flag.
 */
export interface RunListItem {
  runId: string;
  specId: string;
  projectId: string;
  branch: string;
  trigger: string;
  status: string;
  outcome: string | null;
  startedAt: string;
  endedAt: string | null;
  prUrl: string | null;
  specTitle: string;
  /** Run-level SUM(cost_usd) as a dollar string ("0" when nothing priced). */
  costTotalUsd: string;
  lastEventAt: string | null;
  needsReview: boolean;
}

/** A cursor-paginated page wrapper, matching the orchestrator `CursorPage<T>`. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}
