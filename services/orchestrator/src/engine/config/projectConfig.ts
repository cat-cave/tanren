import { z } from "zod";
import { ProviderMode } from "./managedProvider.js";
import {
  AuditPostureConfig,
  ConvergencePolicyConfig,
  DEFAULT_AUDIT_POSTURE,
  DEFAULT_CONVERGENCE_POLICY,
  DEFAULT_MAX_BATCH_SIZE,
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
import { DefaultLlmEntry } from "../credentials/defaultLlmEntry.js";

// Top-level versioned Zod schema for project-level config. Persisted as a
// JSONB column on `projects.config`. Most fields are partial overrides on
// top of the org-level defaults; the routing table is a full table at the
// project layer because the operator UI renders the merged view per role.

// a project's bound credentials. Both fields are optional; a project may bind
// only one kind and inherit the other from the org default. `defaultLlm` is a
// provider-agnostic routing entry {cli, model, authRef} (same shape + rules as
// the org default — see OrgDefaultCredentials), overriding the org's default LLM
// for this project; `githubCredentialRef` is the repo identity.
export const ProjectCredentialRefs = z
  .object({
    defaultLlm: DefaultLlmEntry.optional(),
    githubCredentialRef: z.string().min(1).optional(),
  })
  .strict();
export type ProjectCredentialRefs = z.infer<typeof ProjectCredentialRefs>;

// The captured product identity / design-DNA from the greenfield vision
// interview. The interview capture (`forge/interview/types.ts`) is otherwise
// transient — personas/behaviors/specs are derived into their own rows, but the
// product's IDENTITY (`pitch`) and DESIGN-DNA were dropped at derive time. This
// is where they are PERSISTED (on the existing `projects.config` jsonb blob), so a
// downstream consumer (the intent-preserving conflict resolver) can frame a
// resolution against the product vision and judge whether two specs' intents
// genuinely clash. Both fields are short free-form notes (the interview caps
// `designDna` at 80, the identity `pitch` at 400). Both optional: a project
// created without an interview (brownfield/HTTP) simply has no `productVision` —
// a real empty state, not a stub.
export const ProjectProductVision = z
  .object({
    pitch: z.string().min(1).max(400).optional(),
    designDna: z.string().min(1).max(200).optional(),
  })
  .strict();
export type ProjectProductVision = z.infer<typeof ProjectProductVision>;

// Tanren-native templating (wave 3) — the SEED REFERENCE recorded on a project
// whose greenfield scaffold SEEDED from a validated template (templating-system.md
// §3). Persisted here (not a new table), so the decision is OBSERVABLE on the
// project config and the run path can clone the template repo's conforming files as
// the scaffold base. Present ONLY when a template was selected (strong/partial
// match); ABSENT on the from-scratch path (no match / blocked — the apex default).
// `validatedAt`/`validatedSha` capture the proof the template was selected on
// (durable evidence the seed came from a PROVEN template, not a hand-waved one).
export const ProjectTemplateRef = z
  .object({
    // The selected template's registry id (the `templates.id`).
    templateRef: z.string().min(1),
    // The template repo the seed cloned its conforming files from.
    repoRef: z.string().min(1),
    // When the template's validationProof was last produced (ISO-8601) — the proof
    // the seed was selected on.
    validatedAt: z.string().min(1),
    // The exact template-repo commit the proof was produced against.
    validatedSha: z.string().min(1),
  })
  .strict();
export type ProjectTemplateRef = z.infer<typeof ProjectTemplateRef>;

// The project's CONCRETE LIFECYCLE — the captured stack commands behind the six
// conventional justfile targets (stack-flexible contract,
// docs/operator-guide/ci-config.md). Persisted here so the RUN path can
// MATERIALIZE the contract files (`justfile` + `.tanren/ci.yml`) DETERMINISTICALLY
// — no LLM authors them, which is the v27 fix: the LLM writer reliably mangled the
// ci.yml YAML shape ("bootstrap expected object received string; tiers.* expected
// array received object; when expected record received undefined"). This mirrors
// the interview's `CaptureLifecycle` (the derive path projects that transient
// capture onto this persisted config field) so a later run — not just the interview
// request — can re-materialize the contract from the project's own declaration.
// Each command holds the ACTUAL stack command(s) for the project's stack
// (newline-joined for multi-line); `stack` is a descriptive label Tanren never
// branches on. STRICT: either the full lifecycle is present or it is absent (a
// project that never captured one) — never a partial placeholder.
// The project's TOOLCHAIN (environment-management.md §3) — a STACK-AGNOSTIC map of
// mise tool-name → version-spec the project chose (mirrors the interview's
// `CaptureToolchain`). Persisted here so the RUN path materializes a deterministic
// `mise.toml` `[tools]` table from the project's OWN declaration and `mise install`s
// it at workspace-prep in user space — making `node`/`pnpm`/etc resolve to the
// declared versions for the project's gate/bootstrap commands, WITHOUT touching
// Tanren's harness (codex keeps the runner's isolated node). Keys are validated as
// mise-safe tool names; values are bounded version specs. EMPTY = the project
// declared no toolchain (no `mise.toml`; Tanren invents no versions).
const MISE_TOOL_NAME = /^[a-z0-9][a-z0-9._-]*$/u;
export const ProjectToolchain = z.record(
  z.string().min(1).max(80).regex(MISE_TOOL_NAME, "mise tool name must be lowercase alphanumeric + . _ -"),
  z.string().min(1).max(80),
);
export type ProjectToolchain = z.infer<typeof ProjectToolchain>;

export const ProjectLifecycle = z
  .object({
    stack: z.string().min(1).max(120),
    bootstrap: z.string().min(1).max(400),
    tier1: z.string().min(1).max(400),
    tier2: z.string().min(1).max(400),
    tier3: z.string().min(1).max(400),
    build: z.string().min(1).max(400),
    deploy: z.string().min(1).max(400),
    // The `upgrade` verb (environment-management.md §4.5/§7 P1) — the stack command
    // that bumps deps to latest + regenerates the lockfile, filling the `upgrade`
    // justfile target. Mirrors `CaptureLifecycle.upgrade`; the derive projects the
    // capture onto this field. Optional — absent OR "" ⇒ the `upgrade` target STUBs and
    // the upgrade-spec generator refuses to emit a no-op upgrade node. Allows "" (a
    // project may explicitly declare no upgrade command), defaulting to "" when omitted.
    upgrade: z.string().max(400).default(""),
    // The project's TOOLCHAIN (mise tool-name → version-spec; see `ProjectToolchain`).
    // Optional — defaults to `{}` (no toolchain declared ⇒ no `mise.toml`). Mirrors
    // `CaptureLifecycle.toolchain`; the derive projects that capture onto this field.
    toolchain: ProjectToolchain.default({}),
  })
  .strict();
export type ProjectLifecycle = z.infer<typeof ProjectLifecycle>;

// The UPGRADE POLICY (environment-management.md §4.5/§7 P1) — Tanren owns the POLICY,
// the project owns the COMMAND (`.tanren/ci.yml` `upgrade.run`). Language-agnostic
// (Renovate-style): Tanren names no ecosystem here, only the generic knobs that shape
// WHEN/HOW a version-change DAG node is generated. The generated change still runs
// through the never-break-main gate (§4.5) — this policy never bypasses it.
export const ProjectUpgradePolicy = z
  .object({
    // `keep-current` posture: whether Tanren may GENERATE forced-upgrade work for this
    // project (the operator endpoint + the future scheduled freshness/CVE sources). When
    // `false`, the project pins its declared versions and Tanren generates no upgrade
    // node (legacy/pinned projects are first-class — Tanren is un-opinionated on version
    // CHOICE; §4.5 motivation 1/4). Defaults to `true` (stay current, anti-stale-version).
    keepCurrent: z.boolean().default(true),
    // The supply-chain COOLDOWN: a just-published version younger than this many days is
    // NOT adopted (dodges a freshly-compromised release). A LANGUAGE-AGNOSTIC policy knob
    // — Tanren passes it to the generated upgrade node's intent (the project's `upgrade`
    // command honors it via its own tooling, e.g. Renovate's `minimumReleaseAge`); Tanren
    // never parses package metadata itself. Defaults to 3 days. Integer ≥ 0 (0 = no cooldown).
    minimumReleaseAgeDays: z.number().int().min(0).max(365).default(3),
  })
  .strict();
export type ProjectUpgradePolicy = z.infer<typeof ProjectUpgradePolicy>;

export const DEFAULT_UPGRADE_POLICY: ProjectUpgradePolicy = Object.freeze(ProjectUpgradePolicy.parse({}));

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
    // WAVE-2 / SLICE P-A — the AUDIT POSTURE (tanren-owns-the-engine.md §4), the
    // REAL DORA knob. The auditor emits findings; this posture turns them into the
    // gate verdict ({ blockReviewAt, p2p3Handling }). Defaults to BALANCED (P0/P1
    // block, residual P2/P3 fixed in place when idle — `DEFAULT_AUDIT_POSTURE`); a
    // zero-defect shop blocks on even P3, a velocity shop routes everything into the
    // DAG. A governed SETTING (like `governancePosture`/`reviewPolicy`), never an env var.
    auditPosture: AuditPostureConfig.default(DEFAULT_AUDIT_POSTURE),
    // SPEC-LOOP REDESIGN (docs/roadmap/spec-loop-redesign.md): the CONVERGENCE policy
    // — the SOLE loop bound (no retry cap / timeout). `maxConsecutiveStalls` halts the
    // spec loop only after N consecutive convergence-answerer stalls; `demoRunEnabled`
    // toggles the optional demo-run gate. Defaults to `DEFAULT_CONVERGENCE_POLICY`
    // (3 stalls, demo off).
    convergencePolicy: ConvergencePolicyConfig.default(DEFAULT_CONVERGENCE_POLICY),
    // MERGE-SAFETY (self-identity): OPTIONAL extra GitHub logins to treat as Tanren's
    // own pushes in the external-change gate, ADDITIVE to the default bot login + the
    // login resolved live from the active credential (`resolveActorIdentity`). The
    // apex path needs ZERO config — this is only for orgs that push via MULTIPLE
    // identities (e.g. several admin PATs). Optional: absent ⇒ only the default set
    // (bot login + live-resolved credential login) applies.
    governanceTanrenLogins: z.array(z.string().min(1)).optional(),
    // MERGE-HARDENING (GAP #3): the configurable PLATFORM / KNOWN-AUTOMATION committer
    // login set, ADDITIVE to the built-in `web-flow` (GitHub's merge-commit author). On
    // an AUTONOMOUS tier (reviewPolicy `auto`/`simulated` + `native_queue`) a posture
    // BLOCK whose only external committers are ALL in this set is AUTO-APPROVED (a
    // mechanical co-author trailer / a second bot must not strand a done-run spec into a
    // 3×-churn→park). These are NOT treated as Tanren's own identity (that is
    // `governanceTanrenLogins`) and on the `human` tier they STILL block — the
    // auto-approve is scoped to the autonomous tiers only. Optional: absent ⇒ only
    // the built-in `web-flow` is recognized.
    governancePlatformLogins: z.array(z.string().min(1)).optional(),
    mergeIntegration: MergeIntegration.default("not_configured"),
    // Whether the review stage requires a real human verdict before merge.
    // Defaults to `"human"` (safe: never auto-merge without a review). When a
    // project opts into `"auto"` (the no-review tier), the review stage
    // short-circuits to an approved verdict so the merge dispatch proceeds.
    reviewPolicy: ReviewPolicy.default("human"),
    // autonomy-engine.md §2c: how far along an ancestor must be before a
    // dependent may start building SPECULATIVELY (against the ancestor's
    // prospective merged world) rather than waiting for it to genuinely merge.
    // Defaults to `moderate` (the §6 resolved default: CI-green + audited with no
    // open P0/P1 unblocks a dependent even with review pending). The dependent's
    // MERGE still waits for the real ancestor merge — the threshold gates WORK,
    // not MERGE.
    speculationThreshold: SpeculationThreshold.default(DEFAULT_SPECULATION_THRESHOLD),
    // §2c open decision §6: the max number of UNMERGED ancestors deep a
    // speculative integration branch may stack. A ready dependent whose
    // unmerged-ancestor depth EXCEEDS this is HELD (logged via
    // dag.spec.speculation_held, never silently truncated) until ancestors merge.
    // Default 2.
    speculativeIntegrationDepth: z.number().int().min(1).default(DEFAULT_SPECULATIVE_INTEGRATION_DEPTH),
    // §2d: the MAX BATCH SIZE for speculative batch-check + bisect — how many
    // mutually-eligible queued entries the native MergeCoordinator speculatively
    // integrates + CI-checks as a combined unit before merging. A larger batch
    // amortizes the integration-CI run; a smaller one shrinks bisect cost. Default 5.
    // When more entries are eligible the batch is CAPPED to the DAG-ordered prefix +
    // the cap is logged (never a silent truncation). Only consulted under `native_queue`.
    maxBatchSize: z.number().int().min(1).default(DEFAULT_MAX_BATCH_SIZE),
    // optional per-project preview-deploy URL pattern. Drives the live
    // preview iframe in the Review surface. Supports `{branch}` and `{pr}`
    // placeholders (e.g. `https://pr-{pr}.preview.fly.dev`). Optional. The dashboard
    // never writes a preview URL onto runs — it derives one from this pattern at
    // render time.
    previewUrlPattern: z.string().min(1).optional(),
    // The deploy target a project carries once the `deploy` capability is
    // provisioned. A project either HAS a deploy target (these keys present) or does
    // not (absent) — that absence is semantic, not a compat shim. The deploy-on-merge
    // watcher reads `deployProvider` + `deployAppId` to trigger a release;
    // `deployAppName` is the human app name; `envAttachmentRef` is written by
    // `attachRuntimeAppEnv` once the runtime env is attached. Strict: the writer
    // never persists a null placeholder, so the reader never accepts one.
    deployProvider: z.string().min(1).optional(),
    deployAppId: z.string().min(1).optional(),
    deployAppName: z.string().min(1).optional(),
    envAttachmentRef: z.string().min(1).optional(),
    // optional credential refs the run executor resolves before a run.
    // Absent ⇒ the resolver falls back to the org defaults. Refs are the spec-creation
    // managed namespace (`credential/<kind>/<scope>/...`), not vault:// URIs.
    credentials: ProjectCredentialRefs.optional(),
    // SaaS Tier-B #5: optional per-project override of the org's BYOK-vs-managed
    // toggle. Absent ⇒ inherit the org `providerMode`. When set, it wins over the
    // org for this project. The platform credential ref/endpoint under `managed`
    // are DEPLOY config (not per-project) — a project picks the MODE, not the creds.
    providerMode: ProviderMode.optional(),
    // The per-project DOLLAR BUDGET CEILING (autonomy-engine.md §3 proof 6): a
    // governed SETTING, exactly like `governancePosture`/`reviewPolicy`/
    // `allocator` above — NOT an env var. When the project's cumulative spend over
    // the configured `period` reaches `ceilingUsd`, the autonomous DagWalker STOPS
    // enqueuing new spec runs (genuine `budget_paused` → `dag.budget.paused`);
    // in-flight runs are not killed. Whole-object override: a project that sets a
    // budget overrides the org's `defaultBudget`; a project that omits it inherits
    // the org default (the walker resolves project-over-org). Optional: absent ⇒
    // NO ceiling = unlimited.
    budget: ProjectBudget.optional(),
    // PER-CREDENTIAL CREDIT/OVERAGE USD RATE (cost PR-C): the dollar value of one
    // prepaid credit, keyed by credential ref-KIND (see `CreditRates`). The
    // run-end reconcile multiplies a positive credit-drawdown delta by THIS rate
    // to land subscription-overage real spend (`cost_basis='credits'`) — it is
    // per-credential CONFIG, never the old hardcoded $0.04 constant. Resolution is
    // project-over-org (this map wins over the org `defaultCreditRates`). A
    // credential that drew down credits with NO configured rate is a LOUD unknown
    // (NULL real spend + `cost.credit_rate_unknown`), never a silent guess.
    // Defaults to an EMPTY map (no rates configured).
    creditRates: CreditRates.default({}),
    // GREENFIELD MARKER: whether this project was created greenfield — Tanren
    // authors the repo's stack + toolchain LIVE across writer iterations (no
    // pre-existing committed deps). STACK-AGNOSTIC: this no longer drives a
    // frozen-vs-non-frozen install mode in Tanren — the bootstrap command is the
    // project's `.tanren/ci.yml` `bootstrap.run` (conventionally `just bootstrap`),
    // and the greenfield-vs-frozen concern lives INSIDE that recipe, not here. The
    // flag is retained as a provenance marker (set by the greenfield creation paths:
    // `/projects/greenfield` + the interview `deriveProductGraph`); absent ⇒ `false`
    // = brownfield.
    greenfield: z.boolean().default(false),
    // The captured product identity + design-DNA from the greenfield vision
    // interview (see `ProjectProductVision`). Persisted here (not a new table) so
    // the conflict resolver can frame a resolution against the product vision.
    // Optional: absent ⇒ no captured vision (a real empty state).
    productVision: ProjectProductVision.optional(),
    // The captured project LIFECYCLE (see `ProjectLifecycle`). Persisted here (not
    // a new table) so the RUN path materializes the contract files (`justfile` +
    // `.tanren/ci.yml`) DETERMINISTICALLY from the project's own declaration — the
    // v27 fix that takes contract-file authoring OUT of the LLM writer's hands.
    // Optional: absent ⇒ no captured lifecycle (a brownfield/HTTP project that
    // already ships its own contract files — no materialization).
    lifecycle: ProjectLifecycle.optional(),
    // The UPGRADE POLICY (environment-management.md §4.5/§7 P1) — Tanren owns the
    // POLICY (keep-current posture + supply-chain cooldown), the project owns the
    // COMMAND (the `.tanren/ci.yml` `upgrade` verb). A governed SETTING, like
    // `governancePosture`/`auditPosture`. Defaults to `DEFAULT_UPGRADE_POLICY`
    // (keep-current on, 3-day cooldown). The generated upgrade node always runs the
    // full gate (§4.5) — this policy shapes WHEN work is generated, never bypasses it.
    upgradePolicy: ProjectUpgradePolicy.default(DEFAULT_UPGRADE_POLICY),
    // TEMPLATING WAVE 3: the seed reference when the greenfield scaffold SEEDED from
    // a validated template (see `ProjectTemplateRef`, templating-system.md §3).
    // Persisted so the decision is observable + the run path can clone the
    // template's conforming files as the scaffold base. Optional: absent ⇒ the
    // from-scratch path (no template matched — the apex default).
    templateRef: ProjectTemplateRef.optional(),
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

/**
 * Distinguish an ABSENT project config (null / `{}` / any blob with no `version`
 * key — the DB column's `'{}'::jsonb` default a fresh project carries) from a
 * PRESENT-but-CORRUPT one (a `version` that is wrong/unsupported/NaN, or a
 * `version: 1` body that fails the V1 schema).
 *
 * The no-silent-fallback boundary uses this to decide propagate-vs-fall-through:
 * an absent config is NOT corruption — there simply is no project-level value, so
 * a caller may legitimately fall through to the org default. A present-but-corrupt
 * config IS corruption — it must NEVER be masked by a silent default (e.g. signing
 * as a different github identity, or capping a batch at the wrong size). `raw` here
 * is the parse INPUT (`projects.config`), never a thrown error.
 */
export function isAbsentProjectConfig(raw: unknown): boolean {
  return readObservedVersion(raw) === undefined;
}

export function projectConfigJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ProjectConfigV1) as Record<string, unknown>;
}
