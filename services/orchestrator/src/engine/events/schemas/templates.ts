import { z } from "zod";

// Tanren-native templating (wave 1) — the template REGISTRY lifecycle events.
// Additive observability for the durable template object: a template was
// registered into the registry, and a registered template changed lifecycle tier
// (draft → validated → official, or → degraded). Later waves (validation harness,
// maintenance scheduler, selection) drive the transitions; these events make them
// inspectable in the run/audit feed. Every field is a non-secret descriptor —
// the template id, the owning org, the repo ref, the stack label, the tier — so
// the whole payload is `public` (no credential / secret surface here).

export const TemplateStatus = z.enum(["draft", "validated", "degraded", "official"]);

// `template.registered` — a template was written into the registry: its id, the
// owning org, the conforming-repo ref, the stack label + channel from its
// manifest, and the initial tier (usually `draft` — unvalidated at registration).
export const TemplateRegisteredPayload = z
  .object({
    templateId: z.string(),
    orgId: z.string(),
    repoRef: z.string(),
    /** The manifest's human stack label (descriptive — selection queries capabilities). */
    stack: z.string(),
    channel: z.enum(["lts", "nightly"]),
    status: TemplateStatus,
  })
  .strict();

// `template.status_changed` — a registered template moved lifecycle tier. The
// from→to transition the validation harness (→ validated), the official-review
// (→ official), or the maintenance flow (→ degraded) drove. `reason` is the
// human-readable cause (e.g. "validation proof passed", "proof expired").
export const TemplateStatusChangedPayload = z
  .object({
    templateId: z.string(),
    orgId: z.string(),
    from: TemplateStatus,
    to: TemplateStatus,
    reason: z.string(),
  })
  .strict();

// ── Just-in-time creation events (templating-system.md §3) ───────────────────
//
// The DURABLE, LOUD record of the no-match → just-in-time-creation decision the
// project-init path takes. A no-match must NEVER silently degrade to a project-
// direct from-scratch scaffold: the project's scaffold is GATED on a validated
// template, so the decision (no match → create → published | failed) is a durable
// event at every step, never a vanishing `log.warn`. Carried against the template-
// BUILD project (the meta-DAG `createTemplate` derives), so the whole no-match
// outcome is inspectable in the run/audit feed. Non-secret descriptors only.

// `template.selection.no_match` — the project-init selection found NO eligible
// validated template for the requested stack, so just-in-time creation is being
// triggered (the project scaffold is GATED until it publishes). `stack` is the
// requested stack label; `orgId` the requesting org.
export const TemplateSelectionNoMatchPayload = z
  .object({
    orgId: z.string(),
    /** The requested stack label selection found no validated match for. */
    stack: z.string(),
    /** The capability query that was run (JSON descriptor — non-secret filter terms). */
    query: z.string(),
  })
  .strict();

// `template.creation.started` — the just-in-time creation meta-flow began for a
// no-match stack (research → author → build → validate → publish). The project
// scaffold WAITS on its outcome.
export const TemplateCreationStartedPayload = z
  .object({
    orgId: z.string(),
    stack: z.string(),
  })
  .strict();

// `template.creation.published` — the just-in-time creation VALIDATED (negative
// controls killed) and PUBLISHED a template. The gated project scaffold now seeds
// from it (`templateId`/`repoRef`).
export const TemplateCreationPublishedPayload = z
  .object({
    orgId: z.string(),
    stack: z.string(),
    templateId: z.string(),
    repoRef: z.string(),
  })
  .strict();

// `template.creation.failed` — the just-in-time creation FAILED (ungrounded
// research / non-convergent build / failed validation). The project scaffold is
// NOT proceeded from-scratch — this is the LOUD record paired with a fail-closed
// halt. `reason` is the human-readable cause.
export const TemplateCreationFailedPayload = z
  .object({
    orgId: z.string(),
    stack: z.string(),
    reason: z.string(),
  })
  .strict();

// ── Creation-time upgrade events (environment-management.md §4.5/§7 P1) ───────
//
// A freshly-created template gets a ONCE-AT-BIRTH `just upgrade` node inserted into
// its build DAG so it starts near-LATEST (defeats the model's training-cutoff version
// freeze). These events make that gated bump OBSERVABLE: it ran (a node was inserted),
// or it was skipped LOUDLY (the project declares no upgrade verb, or is pinned — NEVER
// a silent no-op). Non-secret descriptors only.

// `template.creation.upgraded` — the once-at-birth upgrade node was inserted into the
// build DAG, depending on the build specs (so it runs after the template's green gate).
// The build's convergence drive runs it through the full gate (green → born at latest;
// red → self-heals via the writer loop). `specId` is the inserted node; `afterSpecIds`
// the build specs it gates behind (the before signal).
export const TemplateCreationUpgradedPayload = z
  .object({
    orgId: z.string(),
    stack: z.string(),
    /** The inserted gated upgrade DAG node. */
    specId: z.string(),
    /** The build specs the once-at-birth upgrade gates behind (it runs after their green gate). */
    afterSpecIds: z.array(z.string()),
  })
  .strict();

// `template.creation.upgrade_skipped` — the once-at-birth upgrade did NOT run: the
// project declares no `upgrade` verb (`no_upgrade_command`) or is deliberately pinned
// (`policy_pinned`). The LOUD-skip record (the no-silent-fallback guarantee) — never a
// hidden no-op.
export const TemplateCreationUpgradeSkippedPayload = z
  .object({
    orgId: z.string(),
    stack: z.string(),
    /** Why the once-at-birth upgrade was skipped (a semantic refusal, not a failure). */
    reason: z.enum(["no_upgrade_command", "policy_pinned"]),
  })
  .strict();

// ── Self-recovery events (templating-system.md §2 + autonomy thesis) ─────────
//
// A template-build is itself an agent-driven Tanren project, so its specs WILL
// sometimes terminally strand (`needs_attention`/halted/cancelled) or fail to
// converge. The build project is bound to a DETERMINISTIC slug, so the NEXT derive
// for the same stack RESUMES the SAME failed project — and re-strands forever. The
// only "recovery" used to be a human deleting the project's DB rows. Tanren now
// recovers ON ITS OWN: on the resume path, before driving the build, a bound
// build that has NOT published a validated template AND has terminally-blocked
// spec(s) is AUTO-REQUEUED (the stranded specs reset to `open` so the DagWalker
// re-drives them from scratch with the CURRENT code). These events make that
// self-recovery OBSERVABLE — recovered (not silently retried), and exhausted
// (bounded — a genuine "this stack cannot be built autonomously" signal after K
// attempts, never an infinite loop). Non-secret descriptors only.

// `template.build.recovered` — Tanren detected a bound, not-yet-validated
// template-build with terminally-stranded spec(s) and AUTO-REQUEUED them (reset to
// `open`) so a fresh attempt runs with the current code, instead of resuming-and-
// re-stranding or needing a human DB clear. Records which specs were requeued + the
// recovery attempt number (1-based) so the bound is visible in the timeline.
export const TemplateBuildRecoveredPayload = z
  .object({
    orgId: z.string(),
    stack: z.string(),
    /** The terminally-blocked specs reset to `open` (re-drivable) by this recovery. */
    requeuedSpecIds: z.array(z.string()),
    /**
     * This recovery's 1-based position in the durable recovery history (an OBSERVABLE attempt
     * counter, NOT a bound — the recovery is UNBOUNDED while converging; the intelligent
     * non-convergence detector, not a count, decides exhaustion).
     */
    attempt: z.number().int().positive(),
    /**
     * PROGRESS SIGNAL — count of MERGED (`done`) specs at this recovery. With
     * `strandedSpecIds` it makes the converged-vs-stuck judgement reconstructible
     * from the durable event log across restarts (the shared `convergenceDetector` input).
     */
    mergedCount: z.number().int().nonnegative(),
    /** PROGRESS SIGNAL — the terminally-stranded spec ids at this recovery (sorted, deduped). */
    strandedSpecIds: z.array(z.string()),
  })
  .strict();

// `template.build.recovery_exhausted` — the auto-recovery reached a FIXED POINT (the same
// specs strand with no new progress — the shared `convergenceDetector`), so Tanren STOPS
// recovering and surfaces a LOUD, durable terminal failure (a genuine "this stack's template
// cannot be built autonomously" signal). NOT papering over a permanently-broken stack: the
// loud halt is the point. `requeuedSpecIds` are the specs still stranded at exhaustion.
export const TemplateBuildRecoveryExhaustedPayload = z
  .object({
    orgId: z.string(),
    stack: z.string(),
    /** The specs still terminally blocked at the fixed point. */
    requeuedSpecIds: z.array(z.string()),
    /** PROGRESS SIGNAL — count of MERGED (`done`) specs at the fixed point. */
    mergedCount: z.number().int().nonnegative(),
    /** PROGRESS SIGNAL — the terminally-stranded spec ids at the fixed point (sorted, deduped). */
    strandedSpecIds: z.array(z.string()),
  })
  .strict();

// The template REGISTRY lifecycle sub-registry, spread into the main EventRegistry
// (mirroring `loopEventRegistry`) so the registry.ts file stays under the 500-line
// cap. Non-secret descriptors only (id / org / repo ref / stack / tier).
export const templateEventRegistry = {
  "template.registered": TemplateRegisteredPayload,
  "template.status_changed": TemplateStatusChangedPayload,
  "template.selection.no_match": TemplateSelectionNoMatchPayload,
  "template.creation.started": TemplateCreationStartedPayload,
  "template.creation.published": TemplateCreationPublishedPayload,
  "template.creation.failed": TemplateCreationFailedPayload,
  "template.creation.upgraded": TemplateCreationUpgradedPayload,
  "template.creation.upgrade_skipped": TemplateCreationUpgradeSkippedPayload,
  "template.build.recovered": TemplateBuildRecoveredPayload,
  "template.build.recovery_exhausted": TemplateBuildRecoveryExhaustedPayload,
} as const;
