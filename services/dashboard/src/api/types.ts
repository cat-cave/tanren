/**
 * Narrow response types for the orchestrator product APIs the shell consumes.
 *
 * These mirror the JSON shapes returned by the orchestrator routes the shell
 * depends on (orgs, projects, forge tools). They are intentionally local and
 * minimal — the shell only reads the fields it renders. Where the orchestrator
 * contract widens, widen these alongside it (they are not auto-derived).
 *
 * The run-detail HTTP response types (`RunSummary`, `TaskTimelineEntry`,
 * `RunEventRow`, `RunCostRecord`, `RunListItem`, `ProjectFeedItem`,
 * `RunSpecSummary`, `RunDetail`) are NO LONGER hand-mirrored: they are
 * GENERATED from the orchestrator's neutral JSON-Schema export
 * (`contracts/json/http/**`) into `./http.gen.ts` and re-exported below, so the
 * BFF↔orchestrator contract cannot silently drift. See move #3 of
 * docs/architecture/future-refactor-and-scale.md. Regenerate via
 * `corepack pnpm run codegen:dashboard-types`; the `dashboard-types-drift` gate
 * fails on divergence.
 */

// Generated-from-JSON-Schema run-detail HTTP types (single source of truth:
// the orchestrator's Zod contracts → contracts/json/http/** → http.gen.ts).
export type {
  RunSummary,
  TaskTimelineEntry,
  RunEventRow,
  RunCostRecord,
  RunListItem,
  ProjectFeedItem,
  RunSpecSummary,
  RunDetail,
} from "./http.gen.js";

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
 * A single palette item surfaced from the Forge tool surface.
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
// additive contracts — project view, spec creation, routing settings.
// These mirror the orchestrator JSON shapes the project/spec/settings screens
// read (specs/projects, runs/feed, milestones/
// behaviors/personas, forge turns, insights
// routing config). Local + minimal: only the fields these screens render.
//
// history & costs — consumes run-list + cost
// records. These mirror the orchestrator's frozen run-detail API contract
// (services/orchestrator/src/routes/runs/contract.ts). They are intentionally
// local + read-only; the shell only reads what it renders.
// ---------------------------------------------------------------------------

/**
 * How a credential is billed — the operator-facing "pricing model" axis from
 * PROJECT_BRIEF §4. `per_token` (token-billed API), `subscription`
 * (server-enforced window), `self_hosted` (flat-fee / local GPU, opportunity
 * cost), `unattributed` (BUDGET-SAFETY C1: an UNRECOGNIZED credential ref —
 * cost could not be priced, flagged so the budget gate fails closed, never a
 * silent $0). Mirrors `RunCostRecord.billingMode`.
 */
export type BillingMode = "per_token" | "subscription" | "self_hosted" | "unattributed";

/**
 * How a dollar figure (if any) was derived. `provider_response` (the provider's
 * OWN authoritative per-call charge — OpenRouter's `usage.cost`, the REAL
 * deduction with no markup; outranks every estimate), `ccusage` (real
 * billed/computed cost from the CLI's own session logs), `credits`
 * (prepaid-credit drawdown), `unknown` (no reliable basis — `costUsd` is null;
 * an HONEST, allowed state, never a fabricated placeholder), `unattributed`
 * (BUDGET-SAFETY C1: an unrecognized credential ref — NULL-dollar but flagged).
 * Mirrors `RunCostRecord.costBasis`.
 */
export type CostBasis = "ccusage" | "provider_response" | "credits" | "unknown" | "unattributed";

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
  /**
   * REAL SPEND (FOCUS BilledCost): fixed-precision dollar string, or null for
   * subscription within-window / self-hosted / unpriced calls. The budget gate
   * sums THIS column.
   */
  costUsd: string | null;
  /**
   * NOTIONAL VALUE (FOCUS ListCost): the tokens' dollar value at provider list
   * rates, computed for EVERY call whose provider has a rate (including
   * subscription/self-hosted, where real spend is null). The comparable,
   * forecastable figure — never summed by the budget gate. Null only when no
   * provider rate is known (unpriced model / unattributed credential).
   */
  notionalCostUsd: string | null;
  billingMode: BillingMode;
  costBasis: CostBasis;
  recordedAt: string;
}

// Run-detail read API — narrow mirrors of the orchestrator contract
// (`services/orchestrator/src/routes/runs/contract.ts`). These are the shapes
// the run-detail + review surfaces read. They mirror the JSON the
// API ships (dates arrive as ISO strings over the wire, so they are typed as
// `string` here — the UI formats them, the API never reshapes for the UI).
// Widen these alongside the orchestrator contract when it widens.
// ---------------------------------------------------------------------------

// RunSummary, TaskTimelineEntry, RunEventRow, RunCostRecord, RunListItem, and
// ProjectFeedItem are generated from contracts/json/http/** and re-exported at
// the top of this file (no longer hand-mirrored here).

/** A spec row (`GET .../specs`). */
export interface SpecSummary {
  specId: string;
  projectId: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  dependsOn: string[];
  status: string;
}

/** A milestone row (`GET .../milestones`). */
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

/** A persona row (`GET .../personas`). */
export interface PersonaSummary {
  id: string;
  name: string;
  description: string;
}

/** A behavior row (`GET .../behaviors?personaId=`). */
export interface BehaviorSummary {
  id: string;
  personaId: string;
  title: string;
  description: string | null;
}

/**
 * A workflow-insight (`GET .../insights`). `payload` carries the
 * kind-specific fields; `actions` carry operator-button tool calls.
 */
export interface InsightSummary {
  id: string;
  kind: "retry_hotspot" | "model_mismatch" | "pace_anomaly" | "stuck" | "review_stall" | "ci_flaky";
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
 * The render payload of a Forge narration turn (`ForgeAnswer`).
 * `body` is the one-sentence project pulse;
 * `prompts` are the suggested follow-up chips.
 */
export interface ForgeAction {
  label: string;
  toolCall: { tool: string; args?: Record<string, unknown> };
}
export interface ForgeAnswer {
  body: string;
  attentionItems: Array<{ priority: string; title: string; sub: string; action?: ForgeAction }>;
  insights?: Array<{ kind: string; title: string; body: string; actions: ForgeAction[] }>;
  prompts: string[];
}

// ---- Routing config — the project config the settings screen edits.

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
  maxRetriesPerTransientFailure: number;
  maxSpecDiscoveryRoundsWithForge: number;
}

// org-config types live in `orgConfigTypes.ts` (split for the line cap).
export type { OrgAuditGateTarget, OrgConfig, OrgDetail } from "./orgConfigTypes.js";

/** A project's full versioned config (`GET .../projects/:projectId` → `config`). */
export interface ProjectConfig {
  version: 1;
  routing: RoutingTable;
  escapeHatches: Partial<EscapeHatches>;
  governancePosture?: string;
  /** The per-repo merge integration mode (mirrors the orchestrator `MergeIntegration` enum). */
  mergeIntegration?: "native_queue" | "direct_merge" | "external_reviewer" | "not_configured";
  // preview-deploy URL pattern ({branch}/{pr})
  previewUrlPattern?: string;
  /** Project-bound credentials; org default fills any omitted kind. `defaultLlm` is
   * the provider-agnostic default routing entry {cli,model,authRef}. */
  credentials?: {
    defaultLlm?: { cli: string; model: string; authRef: string };
    githubCredentialRef?: string;
  };
  [key: string]: unknown;
}

/** A project with its merged config (`GET .../projects/:projectId`). */
export interface ProjectDetail {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  runnerImage: string | null;
  allocator: string | null;
  config: ProjectConfig;
}

// onboarding/credentials/notifications: additive reads off the
// (doctor/credentials/brownfield) + the notifications contracts.

/** A single `/doctor` check (DoctorCheck). */
export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  latencyMs: number | null;
}

/** `/doctor` report (DoctorReport). */
export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  generatedAt: string;
}

/** A credential reference record (CredentialRecord). Never a value. */
export interface CredentialRecord {
  ref: string;
  kind: "codex_chatgpt_auth" | "github_token" | "opaque";
  scope: "org" | "me";
  ownerId: string;
  createdAt: string;
}

/** A detected (read-only, never written) target-repo file. */
export interface BrownfieldDetectedFile {
  path: string;
  present: boolean;
  size?: number;
  preview?: string;
}

/** Result of the brownfield link call. */
export interface BrownfieldLinkResult {
  projectId: string;
  repoUrl: string;
  orgId: string;
  detectedFiles: BrownfieldDetectedFile[];
  writesPerformed: number;
}

/** A created project (project create). */
export interface CreatedProject {
  projectId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string | null;
  runnerImage: string | null;
  allocator: string | null;
}

/** notification channel kinds. */
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

/** severity taxonomy. */
export type Severity = "ok" | "info" | "warn" | "fail";

/** A configured notification destination (NotificationTargetRow). */
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

/** A per-(target × event) opt-in (NotificationRouteRow). */
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

// RunSpecSummary and RunDetail are generated from contracts/json/http/** and
// re-exported at the top of this file. The forge-thread bundle embedded in
// RunDetail (`{ threadId, recentTurns }`) is inlined by the generated type, so
// the previously hand-written `RunForgeBundle` alias is no longer needed.

/** The org+project a run lives in, resolved from the run-list endpoints. */
export interface RunLocation {
  orgId: string;
  projectId: string;
}

// failure-recovery contracts live in `recoveryTypes.ts` (re-exported
// here so existing `from "./types.js"` imports keep working; line-cap split).
export {
  isRecoverableRun,
  RECOVERABLE_OUTCOMES,
  type RecoveryActionResult,
  type RecoveryContext,
} from "./recoveryTypes.js";
