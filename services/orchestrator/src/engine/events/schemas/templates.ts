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
} as const;
