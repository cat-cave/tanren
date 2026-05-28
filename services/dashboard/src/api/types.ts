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
// Run-detail read API (P2A-0014) — narrow mirrors of the orchestrator contract
// (`services/orchestrator/src/routes/runs/contract.ts`). These are the shapes
// the run-detail + review surfaces (P2B-0004) read. They mirror the JSON the
// API ships (dates arrive as ISO strings over the wire, so they are typed as
// `string` here — the UI formats them, the API never reshapes for the UI).
// Widen these alongside the orchestrator contract when it widens.
// ---------------------------------------------------------------------------

/** `GET .../runs/:runId` → `run`. */
export interface RunSummary {
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
}

/** A planner/write/check/audit/ci task in the run timeline. */
export interface TaskTimelineEntry {
  taskId: string;
  runId: string;
  kind: string;
  parentTaskId: string | null;
  title: string;
  status: string;
  outcome: string | null;
  failureKind: string | null;
  attempt: number;
  cli: string;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
}

/** A redacted-by-default event row. `payload` is opaque; `redactedPaths` lists dropped fields. */
export interface RunEventRow {
  id: number | string;
  ts: string;
  runId: string | null;
  taskId: string | null;
  specId: string | null;
  projectId: string | null;
  eventType: string;
  payload: unknown;
  redactedPaths: string[];
}

/** A typed cost record (P2A-0011) attributed to a source + model. */
export interface RunCostRecord {
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
  costUsd: string | null;
  billingMode: "per_token" | "subscription" | "self_hosted";
  costBasis: "ccusage" | "provider_pricing" | "unknown";
  recordedAt: string;
}

/** The spec embedded in a run detail. */
export interface RunSpecSummary {
  specId: string;
  title: string;
  description: string;
  behaviorIds: string[];
  milestoneId: string | null;
}

/** Forge thread bound to the run, with recent turns (rendered opaque). */
export interface RunForgeBundle {
  threadId: string;
  recentTurns: unknown[];
}

/** Full `GET .../runs/:runId` response. */
export interface RunDetail {
  run: RunSummary;
  spec: RunSpecSummary;
  tasks: TaskTimelineEntry[];
  recentEvents: RunEventRow[];
  costs: RunCostRecord[];
  insights: unknown[];
  forgeThread: RunForgeBundle | null;
}

/** A run-list item (`GET .../runs`) — used to resolve a runId to its project. */
export interface RunListItem extends RunSummary {
  specTitle: string;
  costTotalUsd: string;
  lastEventAt: string | null;
  needsReview: boolean;
}

/** The org+project a run lives in, resolved from the run-list endpoints. */
export interface RunLocation {
  orgId: string;
  projectId: string;
}
