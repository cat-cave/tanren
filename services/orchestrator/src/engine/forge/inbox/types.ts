// P3-0022 candidate inbox: typed contracts for the intake → triage flow.
//
// A configurable SOURCE (connector kind + config) ingests CANDIDATES. Each
// external candidate is TRIAGED by Forge (dedupe → match-to-spec/milestone →
// propose DAG placement → verdict). System sources (e.g. scheduled audits)
// carry `autoRoute` and skip manual triage. The triage itself runs over an
// injectable answerer seam (mirrors P3-0010 / P3-0014) so the Forge call is
// mockable and nothing here couples to a provider.

import { z } from "zod";

// The connector kinds — mirror the hi-fi `INBOX_SOURCES` glyph keys. `system`
// and `scheduled_audit` are the auto-routing system sources.
export const SourceKind = z.enum(["issues", "errors", "system", "manual", "scheduled_audit"]);
export type SourceKind = z.infer<typeof SourceKind>;

// A configured source. `config` is connector-specific (repo/labels for issues,
// query for errors, etc.) and validated by each connector, not here.
export const InboxSource = z
  .object({
    id: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    kind: SourceKind,
    name: z.string().min(1).max(120),
    detail: z.string().max(200).default(""),
    config: z.record(z.string(), z.unknown()).default({}),
    enabled: z.boolean().default(true),
    // System sources whose findings skip manual triage (verdict auto-routable).
    autoRoute: z.boolean().default(false),
  })
  .strict();
export type InboxSource = z.infer<typeof InboxSource>;

// The Forge triage read-out (the hi-fi `TriageReadout`): three reasoning rows
// plus a verdict that drives the surface's available actions.
export const TriageVerdict = z.enum(["auto_routable", "needs_call", "dedupe_close"]);
export type TriageVerdict = z.infer<typeof TriageVerdict>;

export const CandidateTriage = z
  .object({
    // dedupe: prose on whether this matches an existing spec/candidate.
    dedupe: z.string().min(1).max(400),
    // match: which behavior / spec / milestone it fits.
    match: z.string().min(1).max(400),
    // placement: the proposed DAG placement (or "auto → … queued").
    placement: z.string().min(1).max(400),
    verdict: TriageVerdict,
    // When dedupe found an existing spec, its id (so close-as-dup links to it).
    duplicateOfSpecId: z.string().min(1).nullable().default(null),
    // The discovery variant the accept→discovery hand-off should open with.
    discoveryVariant: z.enum(["feature", "bug", "strategic"]).default("feature"),
  })
  .strict();
export type CandidateTriage = z.infer<typeof CandidateTriage>;

// One ingested candidate. `externalId` is the connector's own id (issue number,
// audit-finding key, manual nonce) — unique per source so re-polling is idempotent.
export const CandidateStatus = z.enum([
  "new",
  "triaged",
  "auto_routed",
  "accepted",
  "folded",
  "dismissed",
  "closed_duplicate",
]);
export type CandidateStatus = z.infer<typeof CandidateStatus>;

export const Candidate = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    orgId: z.string().min(1),
    projectId: z.string().min(1).nullable(),
    externalId: z.string().min(1),
    title: z.string().min(1).max(300),
    body: z.string().max(8000).default(""),
    severity: z.enum(["info", "warn", "fail"]).default("info"),
    status: CandidateStatus.default("new"),
    triage: CandidateTriage.nullable().default(null),
    resolvedSpecId: z.string().min(1).nullable().default(null),
    // Display label of the source (denormalised for the surface readout).
    sourceName: z.string().max(120).default(""),
    sourceKind: SourceKind.default("manual"),
  })
  .strict();
export type Candidate = z.infer<typeof Candidate>;

// A raw item a connector produces before it is persisted as a candidate. The
// store stamps ids/org/source; the connector only knows the external content.
export interface IngestedItem {
  externalId: string;
  title: string;
  body: string;
  severity: "info" | "warn" | "fail";
  projectId: string | null;
}

// The injectable connector seam: a source kind's read implementation. The
// GitHub Issues connector reads through the App token resolver in prod; tests
// inject a fake. `fetch` returns the raw items; the engine persists them.
export interface SourceConnector {
  readonly kind: SourceKind;
  fetch(source: InboxSource): Promise<IngestedItem[]>;
}

// The triage answerer seam — mirrors P3-0010's `ForgeConversationAnswerer` and
// P3-0014's `DiscoveryAnswerer`. The real impl wraps a provider Answerer; tests
// inject a fake; the engine falls back to a deterministic grounded answerer.
export interface TriageAnswererContext {
  candidate: Pick<Candidate, "title" | "body" | "severity" | "sourceKind" | "projectId">;
  source: InboxSource;
  // Existing specs (id/title/status) to ground dedupe + match + placement.
  existingSpecs: ReadonlyArray<{ specId: string; title: string; status: string }>;
}

export interface TriageAnswerer {
  triage(context: TriageAnswererContext): Promise<CandidateTriage>;
}
