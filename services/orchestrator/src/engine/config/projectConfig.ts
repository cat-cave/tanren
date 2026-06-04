import { z } from "zod";
import { ManagedProviderConfig, ProviderMode } from "./managedProvider.js";
import {
  DEFAULT_MAX_BATCH_SIZE,
  DEFAULT_NO_CHECKS_SETTLE_MS,
  DEFAULT_SPECULATION_THRESHOLD,
  DEFAULT_SPECULATIVE_INTEGRATION_DEPTH,
  GovernancePosture,
  MergeIntegration,
  NotificationTargetRef,
  PartialAllocatorConfig,
  PartialEscapeHatches,
  PartialForgePersona,
  CreditRates,
  ProjectBudget,
  ReviewPolicy,
  RoutingTable,
  SpeculationThreshold,
  UnknownConfigVersionError,
  emptyRoutingTable,
  readObservedVersion,
} from "./shared.js";

// Top-level versioned Zod schema for project-level config. Persisted as a
// JSONB column on `projects.config`. Most fields are partial overrides on
// top of the org-level defaults; the routing table is a full table at the
// project layer because the operator UI renders the merged view per role.

// P3-0002: a project's bound credential references. Both fields are optional;
// a project may bind only one kind and inherit the other from the org default.
export const ProjectCredentialRefs = z
  .object({
    codexCredentialRef: z.string().min(1).optional(),
    githubCredentialRef: z.string().min(1).optional(),
  })
  .strict();
export type ProjectCredentialRefs = z.infer<typeof ProjectCredentialRefs>;

// The captured product identity / design-DNA from the greenfield vision
// interview. The interview capture (`forge/interview/types.ts`) is otherwise
// transient — personas/behaviors/specs are derived into their own rows, but the
// product's IDENTITY (`pitch`) and DESIGN-DNA were dropped at derive time. This
// is where they are PERSISTED (no new table / migration — the existing
// `projects.config` jsonb blob), so a downstream consumer (the intent-preserving
// conflict resolver) can frame a resolution against the product vision and judge
// whether two specs' intents genuinely clash. Both fields are short free-form
// notes (the interview caps `designDna` at 80, the identity `pitch` at 400).
// Optional + additive: legacy rows carry no key and parse to an absent field (no
// migration), and `.strict()` round-trips it untouched on save. A project created
// without an interview (brownfield/HTTP) simply has no `productVision` — a real
// empty state, not a stub.
export const ProjectProductVision = z
  .object({
    pitch: z.string().min(1).max(400).optional(),
    designDna: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ProjectProductVision = z.infer<typeof ProjectProductVision>;

export const ProjectConfigV1 = z
  .object({
    version: z.literal(1),
    // Project-level overrides for the org-level chain. Every role is present
    // with `{ chain: [] }` by default; entries override the org defaults.
    routing: RoutingTable.default(emptyRoutingTable()),
    // Partial because the project layer should only express the budgets it
    // actually wants to deviate on; the org defaults fill the rest.
    escapeHatches: PartialEscapeHatches.default({}),
    allocator: PartialAllocatorConfig.default({}),
    notificationTargets: z.array(NotificationTargetRef).default([]),
    forgePersona: PartialForgePersona.default({}),
    governancePosture: GovernancePosture.default("strict"),
    // MERGE-SAFETY (self-identity): OPTIONAL extra GitHub logins to treat as Tanren's
    // own pushes in the external-change gate, ADDITIVE to the default bot login + the
    // login resolved live from the active credential (`resolveActorIdentity`). The
    // apex path needs ZERO config — this is only for orgs that push via MULTIPLE
    // identities (e.g. several admin PATs). Optional + backward-compatible: legacy
    // rows carry no key and parse to an absent field (the default set applies), and
    // `.strict()` round-trips it on save.
    governanceTanrenLogins: z.array(z.string().min(1)).optional(),
    // MERGE-HARDENING (GAP #3): the configurable PLATFORM / KNOWN-AUTOMATION committer
    // login set, ADDITIVE to the built-in `web-flow` (GitHub's merge-commit author). On
    // an AUTONOMOUS tier (reviewPolicy `auto`/`simulated` + `native_queue`) a posture
    // BLOCK whose only external committers are ALL in this set is AUTO-APPROVED (a
    // mechanical co-author trailer / a second bot must not strand a done-run spec into a
    // 3×-churn→park). These are NOT treated as Tanren's own identity (that is
    // `governanceTanrenLogins`) and on the `human` tier they STILL block — the
    // auto-approve is scoped to the autonomous tiers only. Optional + backward-compatible:
    // legacy rows carry no key (only `web-flow` is recognized), and `.strict()` round-trips
    // it on save.
    governancePlatformLogins: z.array(z.string().min(1)).optional(),
    mergeIntegration: MergeIntegration.default("not_configured"),
    // Whether the review stage requires a real human verdict before merge.
    // Defaults to `"human"` (safe: never auto-merge without a review). When a
    // project opts into `"auto"` (the no-review tier), the review stage
    // short-circuits to an approved verdict so the merge dispatch proceeds.
    // Additive + backward-compatible: legacy rows carry no key and parse to the
    // `"human"` default (no migration), and `.strict()` round-trips it on save.
    reviewPolicy: ReviewPolicy.default("human"),
    // P2c-1 (autonomy-engine.md §2c): how far along an ancestor must be before a
    // dependent may start building SPECULATIVELY (against the ancestor's
    // prospective merged world) rather than waiting for it to genuinely merge.
    // Defaults to `moderate` (the §6 resolved default: CI-green + audited with no
    // open P0/P1 unblocks a dependent even with review pending). Additive +
    // backward-compatible: legacy rows carry no key and parse to the default (no
    // migration), and `.strict()` round-trips it on save. The dependent's MERGE
    // still waits for the real ancestor merge — the threshold gates WORK, not MERGE.
    speculationThreshold: SpeculationThreshold.default(DEFAULT_SPECULATION_THRESHOLD),
    // P2c-1 (§2c open decision §6): the max number of UNMERGED ancestors deep a
    // speculative integration branch may stack. A ready dependent whose
    // unmerged-ancestor depth EXCEEDS this is HELD (logged via
    // dag.spec.speculation_held, never silently truncated) until ancestors merge.
    // Default 2. Additive; legacy rows parse to the default.
    speculativeIntegrationDepth: z.number().int().min(1).default(DEFAULT_SPECULATIVE_INTEGRATION_DEPTH),
    // P2d-2 (§2d): the MAX BATCH SIZE for speculative batch-check + bisect — how many
    // mutually-eligible queued entries the native MergeCoordinator speculatively
    // integrates + CI-checks as a combined unit before merging. A larger batch
    // amortizes the integration-CI run; a smaller one shrinks bisect cost. Default 5.
    // When more entries are eligible the batch is CAPPED to the DAG-ordered prefix +
    // the cap is logged (never a silent truncation). Additive; legacy rows parse to
    // the default. Only consulted under `native_queue`.
    maxBatchSize: z.number().int().min(1).default(DEFAULT_MAX_BATCH_SIZE),
    // The NO-CHECKS SETTLE GRACE (ms): how long a GENUINELY-ZERO-CHECKS observation
    // (no check-runs + no statuses, NOT gated by required contexts) is held PENDING
    // before the merge queue / run-loop CI gate treats it as green — the fix for a
    // no-CI greenfield repo hanging forever. ONLY `no_checks` settles; `checks_pending`
    // (real CI registered, not done) and `failed` are UNAFFECTED (see
    // DEFAULT_NO_CHECKS_SETTLE_MS). Default 45_000. Additive + backward-compatible:
    // legacy rows carry no key and parse to the default (no migration), and `.strict()`
    // round-trips it on save. A repo with real CI flips to `checks_pending` within
    // seconds and is never short-circuited.
    noChecksSettleMs: z.number().int().min(0).default(DEFAULT_NO_CHECKS_SETTLE_MS),
    // P3-0025: optional per-project preview-deploy URL pattern. Drives the live
    // preview iframe in the Review surface. Supports `{branch}` and `{pr}`
    // placeholders (e.g. `https://pr-{pr}.preview.fly.dev`). Optional + additive:
    // legacy rows carry no key and parse to an absent field (no migration), and
    // `.strict()` round-trips it untouched on save. The dashboard never writes a
    // preview URL onto runs — it derives one from this pattern at render time.
    previewUrlPattern: z.string().min(1).optional(),
    // P3-0002: optional credential refs the run executor resolves before a run.
    // Backward-compatible — legacy rows carry no `credentials` key and parse to
    // an absent field (the resolver then falls back to the org defaults).
    // Refs are the P2A-0013 managed namespace (`credential/<kind>/<scope>/...`),
    // not vault:// URIs.
    credentials: ProjectCredentialRefs.optional(),
    // SaaS Tier-B #5: optional per-project override of the org's BYOK-vs-managed
    // toggle. Absent ⇒ inherit the org `providerMode` (so legacy rows parse to
    // an absent field and the org default applies — no migration). When set, it
    // wins over the org for this project. `managedProvider` likewise overrides
    // the org's platform credential ref + endpoint for this project only.
    providerMode: ProviderMode.optional(),
    managedProvider: ManagedProviderConfig.optional(),
    // The per-project DOLLAR BUDGET CEILING (autonomy-engine.md §3 proof 6): a
    // governed SETTING, exactly like `governancePosture`/`reviewPolicy`/
    // `allocator` above — NOT an env var. When the project's cumulative spend over
    // the configured `period` reaches `ceilingUsd`, the autonomous DagWalker STOPS
    // enqueuing new spec runs (genuine `budget_paused` → `dag.budget.paused`);
    // in-flight runs are not killed. Whole-object override: a project that sets a
    // budget overrides the org's `defaultBudget`; a project that omits it inherits
    // the org default (the walker resolves project-over-org). Optional + additive:
    // legacy rows carry no key and parse to an ABSENT field = NO ceiling = unlimited
    // (today's behavior, byte-identical), and `.strict()` round-trips it on save.
    budget: ProjectBudget.optional(),
    // PER-CREDENTIAL CREDIT/OVERAGE USD RATE (cost PR-C): the dollar value of one
    // prepaid credit, keyed by credential ref-KIND (see `CreditRates`). The
    // run-end reconcile multiplies a positive credit-drawdown delta by THIS rate
    // to land subscription-overage real spend (`cost_basis='credits'`) — it is
    // per-credential CONFIG, never the old hardcoded $0.04 constant. Resolution is
    // project-over-org (this map wins over the org `defaultCreditRates`). A
    // credential that drew down credits with NO configured rate is a LOUD unknown
    // (NULL real spend + `cost.credit_rate_unknown`), never a silent guess.
    // Optional + additive: legacy rows carry no key and parse to an EMPTY map (no
    // migration), and `.strict()` round-trips it on save.
    creditRates: CreditRates.default({}),
    // GREENFIELD MARKER: whether this project was created greenfield — Tanren
    // authors the repo's toolchain LIVE across writer iterations (no pre-existing
    // committed lockfile / installed deps). It drives the in-loop deps-ensure
    // install MODE: a greenfield run uses a NON-FROZEN install (so a writer-added
    // devDep without a perfectly-regenerated lockfile still installs before the
    // gate), while a brownfield run keeps the FROZEN, lockfile-safe default
    // (`pnpm install --frozen-lockfile` / `npm ci`) so an existing committed
    // lockfile is never silently mutated / upgraded. Set by the greenfield
    // creation paths (`/projects/greenfield` + the interview `deriveProductGraph`);
    // absent ⇒ `false` = brownfield (the safe default). Additive + backward-
    // compatible: legacy rows carry no key and parse to `false` (no migration), and
    // `.strict()` round-trips it on save. An explicit `tanren-ci.yml` `bootstrap.run`
    // still wins over this default in BOTH cases.
    greenfield: z.boolean().default(false),
    // The captured product identity + design-DNA from the greenfield vision
    // interview (see `ProjectProductVision`). Persisted here (not a new table) so
    // the conflict resolver can frame a resolution against the product vision.
    // Optional + additive: absent ⇒ no captured vision (a real empty state), and
    // `.strict()` round-trips it untouched on save.
    productVision: ProjectProductVision.optional(),
  })
  .strict();
export type ProjectConfigV1 = z.infer<typeof ProjectConfigV1>;

export const ProjectConfigVersioned = z.discriminatedUnion("version", [ProjectConfigV1]);
export type ProjectConfigVersioned = z.infer<typeof ProjectConfigVersioned>;

export const SUPPORTED_PROJECT_CONFIG_VERSIONS: ReadonlyArray<number> = [1];

// Parses a stored project config row into the typed V1 shape. Fail-hard, no
// shim — same rules as `migrateOrgConfig`: a row missing `version` is a hard
// error (UnknownConfigVersionError), NOT a silent upgrade to V1 defaults. Every
// persisted project config carries an explicit `version`. The name is retained
// as the parse surface; the old "default the `{}` blob" shim is deleted.
export function migrateProjectConfig(raw: unknown): ProjectConfigV1 {
  const observed = readObservedVersion(raw);
  if (observed === 1) {
    return ProjectConfigV1.parse(raw);
  }
  throw new UnknownConfigVersionError(observed, SUPPORTED_PROJECT_CONFIG_VERSIONS);
}

export function defaultProjectConfigV1(): ProjectConfigV1 {
  return ProjectConfigV1.parse({ version: 1 });
}

export function projectConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ProjectConfigV1) as Record<string, unknown>;
}
