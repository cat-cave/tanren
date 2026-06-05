import { z } from "zod";

// Shared building blocks for org- and project-level config. Zod is the
// single source of truth; persistence and JSON Schema artifacts are derived
// from these definitions.

// ---- Routing chain (the 6-role fallback chain shape) ----------------------

export const RoleId = z.enum(["plan", "write", "check", "audit", "demo", "forge"]);
export type RoleId = z.infer<typeof RoleId>;

export const HealthHint = z.enum(["ok", "warn", "rate_limited", "fail"]);
export type HealthHint = z.infer<typeof HealthHint>;

// A single fallback step. v0 only emits Codex entries; the schema is stable
// when Claude, opencode, and other CLIs arrive in Phase 3 so no shape change
// is required to populate them.
export const RoutingChainEntry = z
  .object({
    cli: z.string().min(1),
    model: z.string().min(1),
    authRef: z.string().min(1),
    healthHint: HealthHint.optional(),
  })
  .strict();
export type RoutingChainEntry = z.infer<typeof RoutingChainEntry>;

export const RoutingChain = z
  .object({
    chain: z.array(RoutingChainEntry).default([]),
  })
  .strict();
export type RoutingChain = z.infer<typeof RoutingChain>;

// The routing table covers every role. Even when a role's chain is empty
// (Codex-only v0), every role is representable so the operator UI never sees
// an undefined column. `partial()` lets project-level overrides specify only
// the roles they want to redirect.
export const RoutingTable = z
  .object({
    plan: RoutingChain.default({ chain: [] }),
    write: RoutingChain.default({ chain: [] }),
    check: RoutingChain.default({ chain: [] }),
    audit: RoutingChain.default({ chain: [] }),
    demo: RoutingChain.default({ chain: [] }),
    forge: RoutingChain.default({ chain: [] }),
  })
  .strict();
export type RoutingTable = z.infer<typeof RoutingTable>;

// Returns the routing table with every role present and defaulted to an
// empty chain. Used as the org-level default and as the projection target
// when reading project rows that omit roles entirely.
export function emptyRoutingTable(): RoutingTable {
  return RoutingTable.parse({});
}

// ---- Retry budgets / escape hatches --------------------------------------

export const EscapeHatches = z
  .object({
    maxWriterIterPerSubtask: z.number().int().min(1).default(5),
    maxPlannerRerunsPerSpec: z.number().int().min(1).default(3),
    maxRetriesPerTransientFailure: z.number().int().min(0).default(3),
    maxSpecDiscoveryRoundsWithForge: z.number().int().min(1).default(20),
  })
  .strict();
export type EscapeHatches = z.infer<typeof EscapeHatches>;

// Project-level overrides may specify only a subset of escape hatches; the
// org defaults fill the rest at merge time (merge logic lives in the engine
// loaders that read both layers). Defined as a separate object — rather than
// `EscapeHatches.partial()` — so that unspecified inner fields stay
// undefined instead of being filled by their EscapeHatches defaults at parse
// time. The engine loader merges this partial onto the org-resolved values.
export const PartialEscapeHatches = z
  .object({
    maxWriterIterPerSubtask: z.number().int().min(1).optional(),
    maxPlannerRerunsPerSpec: z.number().int().min(1).optional(),
    maxRetriesPerTransientFailure: z.number().int().min(0).optional(),
    maxSpecDiscoveryRoundsWithForge: z.number().int().min(1).optional(),
  })
  .strict();
export type PartialEscapeHatches = z.infer<typeof PartialEscapeHatches>;

// ---- Allocator settings --------------------------------------------------

export const AllocatorKind = z.enum(["local-docker"]);
export type AllocatorKind = z.infer<typeof AllocatorKind>;

export const AllocatorConfig = z
  .object({
    kind: AllocatorKind.default("local-docker"),
    concurrency: z.number().int().min(1).default(3),
    memoryMb: z.number().int().min(256).default(4096),
    cpus: z.number().int().min(1).default(2),
    runnerImage: z.string().min(1).default("ghcr.io/cat-cave/tanren-runner:v0"),
  })
  .strict();
export type AllocatorConfig = z.infer<typeof AllocatorConfig>;

/**
 * The worker's max in-flight run-slot ceiling, resolved from the config surface
 * (`AllocatorConfig.concurrency`) — NOT from an env var (autonomy-engine.md
 * §1.4: "concurrency is a governed config knob, never an env var").
 *
 * This is the process-global default ceiling the run-executor worker boots with.
 * It is derived by parsing an `AllocatorConfig` (so the single schema default —
 * and any future config source feeding that schema — is the one source of
 * truth), never read from `process.env`. The future DagWalker reads the same
 * per-project/org `AllocatorConfig.concurrency` and throttles BELOW this ceiling
 * in response to live rate-limit/budget signals.
 */
export function resolveWorkerConcurrency(): number {
  return AllocatorConfig.parse({}).concurrency;
}

// See PartialEscapeHatches for why this is not `AllocatorConfig.partial()`.
export const PartialAllocatorConfig = z
  .object({
    kind: AllocatorKind.optional(),
    concurrency: z.number().int().min(1).optional(),
    memoryMb: z.number().int().min(256).optional(),
    cpus: z.number().int().min(1).optional(),
    runnerImage: z.string().min(1).optional(),
  })
  .strict();
export type PartialAllocatorConfig = z.infer<typeof PartialAllocatorConfig>;

// ---- Dollar budget ceiling (autonomy-engine.md §3 proof 6) ---------------

// The PERIOD a budget ceiling sums spend over:
//   - `monthly`   — the CURRENT CALENDAR MONTH (UTC): spend recorded since the
//                   first of this month (`date_trunc('month', now())`). A fresh
//                   window opens automatically each month boundary — the rolling
//                   operating budget for a continuously-running project.
//   - `quarterly` — the CURRENT CALENDAR QUARTER (UTC): spend recorded since
//                   `date_trunc('quarter', now())`. A coarser rolling window.
//   - `annual`    — the CURRENT CALENDAR YEAR (UTC): spend recorded since
//                   `date_trunc('year', now())`. The coarsest rolling window.
//   - `total`     — the project's LIFETIME: every cost record ever attributed to
//                   the project. A hard lifetime cap (e.g. a fixed `apex` budget).
//
// All non-`total` values are CALENDAR-anchored rolling windows (additive: legacy
// `monthly`/`total` rows are unchanged; the new values need no migration since
// the column is config jsonb).
export const BudgetPeriod = z.enum(["monthly", "quarterly", "annual", "total"]);
export type BudgetPeriod = z.infer<typeof BudgetPeriod>;

export const DEFAULT_BUDGET_PERIOD: BudgetPeriod = "monthly";

// The FIGURE a budget ceiling gates. Vocabulary discipline (FOCUS-aligned):
//   - `real_spend`  — REAL money out the door (FOCUS BilledCost; `cost_usd`). The
//                     ONLY figure the DagWalker's gate sums today, and the default.
//   - `notional`    — the API-equivalent / list-priced ESTIMATE (FOCUS ListCost;
//                     `notional_cost_usd`). NOT real money — never called "spend".
//                     Reserved for a future gate mode; the label is surfaced now so
//                     a read never has to guess which figure the ceiling caps.
// Additive + defaulted: an absent value resolves to `real_spend` (today's behavior,
// byte-identical). The gate implementation still sums REAL spend regardless — this
// names the gated figure honestly; it does not silently change the gate.
export const BudgetGatedFigure = z.enum(["real_spend", "notional"]);
export type BudgetGatedFigure = z.infer<typeof BudgetGatedFigure>;

export const DEFAULT_BUDGET_GATED_FIGURE: BudgetGatedFigure = "real_spend";

// The per-project/org DOLLAR BUDGET CEILING — a governed SETTING (lives in
// project/org config JSON), never an env var. When the project's cumulative
// spend over `period` reaches `ceilingUsd`, the DagWalker STOPS enqueuing new
// spec runs (the genuine `budget_paused` outcome → `dag.budget.paused`);
// in-flight runs are NOT killed (they are bounded by the escape hatches). The
// SAME ceiling feeds the Forge narration budget-warning card, so the warning
// and the gate read one config — there is no second parallel budget concept.
//
// Optional + additive everywhere it is referenced: an absent budget means NO
// ceiling (unlimited — today's behavior, byte-identical). `ceilingUsd` is a
// non-negative dollar amount; `period` defaults to `monthly`; `gatedFigure`
// names which figure the ceiling caps and defaults to `real_spend` (the figure
// the gate actually sums).
export const ProjectBudget = z
  .object({
    ceilingUsd: z.number().nonnegative(),
    period: BudgetPeriod.default(DEFAULT_BUDGET_PERIOD),
    gatedFigure: BudgetGatedFigure.default(DEFAULT_BUDGET_GATED_FIGURE),
  })
  .strict();
export type ProjectBudget = z.infer<typeof ProjectBudget>;

// ---- Per-credential credit/overage USD rate ------------------------------

// The DOLLAR VALUE OF ONE prepaid credit, keyed by the credential's SAFE
// PROVIDER-SLUG label (the `credential/<slug>` prefix, secret name + scope
// stripped — see `credentialSlugOf` in costs/sources.ts; e.g.
// `credential/codex/org/o1/default` keys under `credential/codex`). This is the
// REAL drawdown rate the run-end reconcile multiplies a positive credit-drawdown
// delta by to land subscription-OVERAGE spend (`cost_basis='credits'`).
//
// It is per-CREDENTIAL CONFIG, NOT a magic constant: a subscription's
// credit→USD rate is account/plan-specific (e.g. Codex Pro observed at $0.04
// /credit) and MUST be configured per credential kind, never hardcoded. A
// credential that DID draw down credits but has NO configured rate is a LOUD
// unknown — the run-end reconcile records NULL real spend + emits
// `cost.credit_rate_unknown`, NEVER a silent guess (REAL SPEND IS A FACT).
//
// Keyed by provider-SLUG so one rate covers every credential of that provider
// (`credential/codex` → 0.04). Resolution is project-config over org-config
// (the org `defaultCreditRates` is the fallback layer). Optional + additive:
// legacy rows carry no key and parse to an EMPTY map (no migration) — the rate
// is then UNKNOWN for every credential, so a drawdown lands NULL-and-loud
// rather than silently priced at a removed default. `.strict()` round-trips it
// on save. `usdPerCredit` is a positive dollar amount.
export const CreditRates = z.record(z.string().min(1), z.number().positive());
export type CreditRates = z.infer<typeof CreditRates>;

// ---- Notification target ref ---------------------------------------------

// References a row in the (future) `notification_targets` table delivered by
// P2A-0017. Stored as a uuid so the contract is stable before the table
// lands; the parser does not look the value up.
export const NotificationTargetRef = z.string().uuid();
export type NotificationTargetRef = z.infer<typeof NotificationTargetRef>;

// ---- Forge persona ------------------------------------------------------

export const ForgePersona = z
  .object({
    systemPromptOverride: z.string().nullable().default(null),
    enableTools: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ForgePersona = z.infer<typeof ForgePersona>;

// See PartialEscapeHatches for why this is not `ForgePersona.partial()`.
export const PartialForgePersona = z
  .object({
    systemPromptOverride: z.string().nullable().optional(),
    enableTools: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type PartialForgePersona = z.infer<typeof PartialForgePersona>;

// ---- Governance posture / merge integration ------------------------------

// Governance posture. `strict`/`open`/`audit_only` govern how Tanren coexists
// with EXTERNAL (non-Tanren) contributors at the merge point (see
// workflow/reviewMerge/governancePosture.ts). `lenient` additionally relaxes the
// in-loop GATE: under it, `lint`/`typecheck` failures are ADVISORY (warn,
// non-blocking) while `build`/`test` stay BLOCKING — the functional-but-weak apex
// doctrine, so an autonomous greenfield build lands imperfect code and improves it
// via the issue loop rather than stalling on first-pass quality. For the
// external-contributor decision, `lenient` behaves like `strict` (Tanren-only PRs
// proceed; external commits block). Additive + backward-compatible: legacy rows
// carry no key and parse to the `strict` default (no migration).
export const GovernancePosture = z.enum(["strict", "open", "audit_only", "lenient"]);
export type GovernancePosture = z.infer<typeof GovernancePosture>;

// The per-repo merge integration mode (autonomy-engine.md §2d):
//   - `direct_merge`      — Tanren merges the PR immediately when it is ready
//                           (audited + reviewed + CI-green), via the GitHub merge
//                           API. No queue: each ready run merges as it finishes.
//   - `native_queue`      — Tanren's OWN intelligent merge queue (P2d). A ready run
//                           ENTERS the queue instead of merging immediately; the
//                           native MergeCoordinator then orders ready runs in DAG
//                           order (ancestor before dependent, priority within a
//                           layer) and SERIALIZES their merges (one at a time),
//                           driving the SAME per-run merge path (P2a up-to-date +
//                           P2b conflict-resolution + P2c-1 retarget). This is the
//                           queue — native, provider-agnostic, intent-preserving.
//   - `external_reviewer` — stop at ready-for-review; a human merges (no auto-merge).
//   - `not_configured`    — treated as `external_reviewer` (never auto-merge a repo
//                           that has not opted in).
export const MergeIntegration = z.enum(["native_queue", "direct_merge", "external_reviewer", "not_configured"]);
export type MergeIntegration = z.infer<typeof MergeIntegration>;

// ---- Review policy -------------------------------------------------------

// Per-project gate on whether the review stage requires a real human verdict
// before merge. `human` (the default) preserves today's behavior: the review
// stage polls GitHub for an approval/changes-requested verdict and hands off to
// an operator if none arrives. `auto` is the no-review tier (easy/medium): the
// review stage short-circuits to an approved verdict immediately so the merge
// dispatch proceeds. `simulated` is the HARD tier's in-the-loop reviewer
// exercised WITHOUT a human: an orchestrator-managed reviewer Answerer reads the
// PR diff + acceptance criteria, decides approve/request_changes, and posts that
// as a REAL GitHub review — so the same human-verdict path then proceeds
// (approve→merge) or loops back (changes_requested→rework). The default MUST be
// `human` — never auto-merge without a review unless a project explicitly opts in.
export const ReviewPolicy = z.enum(["human", "auto", "simulated"]);
export type ReviewPolicy = z.infer<typeof ReviewPolicy>;

// ---- Speculative execution (autonomy-engine.md §2c) ----------------------

// The SPECULATION THRESHOLD: how far along an ancestor must be before a dependent
// may START BUILDING speculatively (against the ancestor's prospective merged
// world) rather than waiting for the ancestor to genuinely merge. Per-project;
// the default is `moderate` (the §2c/§6 resolved default — routes around the
// human-review bottleneck while staying off genuinely-unstable ancestors):
//
//   - `conservative` — a dependent may start only once its ancestor is MERGED.
//                      Zero speculative rework; human review serializes the DAG.
//   - `moderate`     — a dependent may start once its ancestor is CI-GREEN +
//                      AUDITED with NO open P0/P1 finding (P2/P3 are OK), EVEN IF
//                      human/simulated review is still pending. An ancestor that
//                      is "technically complete but pending automated audits" is
//                      NOT ready (audits gate); only-P2/P3 findings ARE ready.
//   - `aggressive`   — a dependent may start as soon as the ancestor's PR is OPEN
//                      (pre-CI). Maximum parallelism, highest invalidation risk.
//
// The dependent's MERGE always still waits for the ancestor to genuinely merge
// (no unreviewed code reaches `main` early) — the threshold gates WORK, not MERGE.
export const SpeculationThreshold = z.enum(["conservative", "moderate", "aggressive"]);
export type SpeculationThreshold = z.infer<typeof SpeculationThreshold>;

export const DEFAULT_SPECULATION_THRESHOLD: SpeculationThreshold = "moderate";

// The MAX SPECULATIVE-INTEGRATION DEPTH (§2c open decision §6): how many UNMERGED
// ancestors deep a speculative integration branch may stack before the rework
// risk outweighs the velocity. When a ready dependent's unmerged-ancestor depth
// would EXCEED this cap, the spec is HELD (not silently truncated — the walker
// emits a `dag.spec.speculation_held` event and treats it as not-yet-ready) until
// enough ancestors merge. Default 2 (the §6 resolved default); a positive int.
export const DEFAULT_SPECULATIVE_INTEGRATION_DEPTH = 2;

// The MAX BATCH SIZE (§2d — speculative batch-check + bisect): how many
// mutually-eligible queued entries the native MergeCoordinator speculatively
// integrates + CI-checks as a combined unit before merging. A larger batch amortizes
// the (expensive) integration-CI run; a smaller one shrinks the bisect cost of a bad
// interaction. Default 5 (the §2d resolved default). When more entries are eligible
// the batch is CAPPED to the DAG-ordered prefix + the cap is LOGGED (never a silent
// truncation); the dropped entries keep their queue position for the next pass.
export const DEFAULT_MAX_BATCH_SIZE = 5;

// ---- Errors --------------------------------------------------------------

// Thrown by the migration helpers when the persisted `version` discriminator
// is a value this build does not know how to read. Distinct from a plain
// parse failure so the caller can decide whether to refuse-start, warn, or
// hand the raw blob to an out-of-process migrator.
export class UnknownConfigVersionError extends Error {
  readonly observedVersion: unknown;
  readonly supportedVersions: ReadonlyArray<number>;
  constructor(observedVersion: unknown, supportedVersions: ReadonlyArray<number>) {
    super(`unknown config version: observed=${String(observedVersion)} supported=[${supportedVersions.join(",")}]`);
    this.observedVersion = observedVersion;
    this.supportedVersions = supportedVersions;
  }
}

// Helper used by both migration helpers: returns the observed version if
// present as a number, or undefined if the input is a legacy versionless
// object that should be migrated into V1 defaults.
export function readObservedVersion(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const candidate = (raw as { version?: unknown }).version;
  if (candidate === undefined) {
    return undefined;
  }
  if (typeof candidate !== "number" || !Number.isInteger(candidate)) {
    return Number.NaN;
  }
  return candidate;
}
