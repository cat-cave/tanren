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

// The template REGISTRY lifecycle sub-registry, spread into the main EventRegistry
// (mirroring `loopEventRegistry`) so the registry.ts file stays under the 500-line
// cap. Non-secret descriptors only (id / org / repo ref / stack / tier).
export const templateEventRegistry = {
  "template.registered": TemplateRegisteredPayload,
  "template.status_changed": TemplateStatusChangedPayload,
} as const;
