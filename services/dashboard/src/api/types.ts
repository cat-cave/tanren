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
// P2B-0003 additive contracts — project view, spec creation, routing settings.
// These mirror the orchestrator JSON shapes the project/spec/settings screens
// read (P2A-0013 specs/projects, P2A-0014 runs/feed, P2A-0018 milestones/
// behaviors/personas, P2A-0019 forge turns, P2A-0020 insights, P2A-0006
// routing config). Local + minimal: only the fields these screens render.
//
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
  /** True when the run is in a review state with an open PR. */
  needsReview: boolean;
}

/** A project activity-feed event (`GET .../feed`, P2A-0014). */
export interface ProjectFeedItem {
  id: number | string;
  ts: string;
  runId: string;
  taskId: string | null;
  specId: string | null;
  projectId: string | null;
  eventType: string;
  redactedPaths: string[];
}

/** A spec row (`GET .../specs`, P2A-0013). */
export interface SpecSummary {
  specId: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: string;
}

/** A milestone row (`GET .../milestones`, P2A-0018). */
export interface MilestoneSummary {
  id: string;
  projectId: string;
  label: string;
  name: string;
  description: string | null;
  orderIndex: number;
  eta: string | null;
  status: string;
}

/** A persona row (`GET .../personas`, P2A-0018). */
export interface PersonaSummary {
  id: string;
  name: string;
  description: string;
}

/** A behavior row (`GET .../behaviors?personaId=`, P2A-0018). */
export interface BehaviorSummary {
  id: string;
  personaId: string;
  title: string;
  description: string | null;
}

/**
 * A workflow-insight (`GET .../insights`, P2A-0020). Only `retry_hotspot`,
 * `model_mismatch`, `pace_anomaly` are surfaced in v0. `payload` carries the
 * kind-specific fields; `actions` carry operator-button tool calls.
 */
export interface InsightSummary {
  id: string;
  kind: "retry_hotspot" | "model_mismatch" | "pace_anomaly";
  projectId: string;
  severity: "info" | "warn" | "fail";
  title: string;
  body: string;
  payload: Record<string, unknown> & { kind: string };
  actions: InsightActionSummary[];
  computedAt: string;
  acknowledgedAt: string | null;
}

/** An operator-button action on an insight — carries a Forge tool call. */
export interface InsightActionSummary {
  label: string;
  /** ForgeToolCall shape `{ tool, args }`. */
  toolCall: { tool: string; args?: Record<string, unknown> };
}

/**
 * The render payload of a Forge narration turn (P2A-0008 `ForgeAnswer`,
 * generated by P2A-0019). `body` is the one-sentence project pulse;
 * `prompts` are the suggested follow-up chips.
 */
export interface ForgeAnswer {
  body: string;
  attentionItems: Array<{
    priority: string;
    title: string;
    sub: string;
    action?: { label: string; toolCall: { tool: string; args?: Record<string, unknown> } };
  }>;
  prompts: string[];
}

// ---- Routing config (P2A-0006) — the project config the settings screen edits.

export type RoleId = "plan" | "write" | "check" | "audit" | "demo" | "forge";
export const ROLE_IDS: RoleId[] = ["plan", "write", "check", "audit", "demo", "forge"];
export type HealthHint = "ok" | "warn" | "rate_limited" | "fail";

/** One fallback step in a role's routing chain. */
export interface RoutingChainEntry {
  cli: string;
  model: string;
  authRef: string;
  healthHint?: HealthHint;
}

export interface RoutingChain {
  chain: RoutingChainEntry[];
}

export type RoutingTable = Record<RoleId, RoutingChain>;

export interface EscapeHatches {
  maxWriterIterPerSubtask: number;
  maxPlannerRerunsPerSpec: number;
  maxRetriesPerTransientFailure: number;
  maxSpecDiscoveryRoundsWithForge: number;
}

/** A project's full versioned config (`GET .../projects/:projectId` → `config`). */
export interface ProjectConfig {
  version: 1;
  routing: RoutingTable;
  escapeHatches: Partial<EscapeHatches>;
  governancePosture?: string;
  mergeIntegration?: string;
  /** Project-bound credential refs (P3-0002); org default fills any omitted kind. */
  credentials?: { codexCredentialRef?: string; githubCredentialRef?: string };
  [key: string]: unknown;
}

/** A project with its merged config (`GET .../projects/:projectId`, P2A-0013). */
export interface ProjectDetail {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  runnerImage: string | null;
  allocator: string | null;
  config: ProjectConfig;
}

// ── P2B-0002 onboarding / credentials / notifications additions ──────────
// All additive: read the fields the onboarding/credentials/notifications
// screens render off the P2A-0013 (doctor/credentials/brownfield) and
// P2A-0017 (notifications) contracts. Local + minimal, like the rest.

/** A single `/doctor` check (P2A-0013 DoctorCheck). */
export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  latencyMs: number | null;
}

/** `/doctor` report (P2A-0013 DoctorReport). */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  generatedAt: string;
}

/** A credential reference record (P2A-0013 CredentialRecord). Never a value. */
export interface CredentialRecord {
  ref: string;
  kind: "codex_chatgpt_auth" | "github_token" | "opaque";
  scope: "org" | "me";
  ownerId: string;
  createdAt: string;
}

/** A detected (read-only, never written) target-repo file (P2A-0013). */
export interface BrownfieldDetectedFile {
  path: string;
  present: boolean;
  size?: number;
  preview?: string;
}

/** Result of the brownfield link call (P2A-0013). */
export interface BrownfieldLinkResult {
  projectId: string;
  repoUrl: string;
  orgId: string;
  detectedFiles: BrownfieldDetectedFile[];
  writesPerformed: number;
}

/** A created project (P2A-0013 project create). */
export interface CreatedProject {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  runnerImage: string | null;
  allocator: string | null;
}

/** P2A-0017 notification channel kinds. */
export type ChannelKind =
  | "ntfy"
  | "slack"
  | "github_checks"
  | "teams"
  | "discord"
  | "email"
  | "twilio"
  | "pagerduty"
  | "webhook";

/** P2A-0017 severity taxonomy. */
export type Severity = "ok" | "info" | "warn" | "fail";

/** A configured notification destination (P2A-0017 NotificationTargetRow). */
export interface NotificationTarget {
  id: string;
  orgId: string;
  scope: "org" | "user";
  userId: string | null;
  channelKind: ChannelKind;
  destination: string;
  label: string;
  enabled: boolean;
  weekendMute: boolean;
}

/** A per-(target × event) opt-in (P2A-0017 NotificationRouteRow). */
export interface NotificationRoute {
  id: string;
  targetId: string;
  eventName: string;
  enabled: boolean;
  minSeverity: Severity;
}

/** An event-registry row + its default severity, for the matrix rows. */
export interface NotificationEvent {
  eventName: string;
  defaultSeverity: Severity;
}

/** The full notifications-matrix payload the screen renders against. */
export interface NotificationMatrix {
  targets: NotificationTarget[];
  routes: NotificationRoute[];
  events: NotificationEvent[];
}

/** A cursor-paginated page wrapper, matching the orchestrator `CursorPage<T>`. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
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

/** The org+project a run lives in, resolved from the run-list endpoints. */
export interface RunLocation {
  orgId: string;
  projectId: string;
}

// P2B-0008 failure-recovery contracts live in `recoveryTypes.ts` (re-exported
// here so existing `from "./types.js"` imports keep working) to keep this file
// under the 500-line architecture cap.
export {
  isRecoverableRun,
  RECOVERABLE_OUTCOMES,
  type RecoveryActionResult,
  type RecoveryContext
} from "./recoveryTypes.js";
