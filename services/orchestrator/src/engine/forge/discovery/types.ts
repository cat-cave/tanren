// spec discovery: typed contracts for the discovery flow.
//
// Discovery classifies an INSIGHT (a sales note, GitHub issue, or exec memo)
// into PROPOSED SPECS, each with a small set of DAG-PLACEMENT OPTIONS (where in
// the dependency graph the spec lands) plus an IMPACT-DELTA summary (which
// personas/behaviors/specs change). The classification itself is a Forge
// conversation: it runs over the SAME conversation answerer seam, so
// the LLM call is injectable and mockable (see `DiscoveryAnswerer`).
//
// Provenance — which insight produced which spec, the chosen placement, the
// variant — is persisted on the spec record's `metadata` JSONB (discovery
// migration 0023), NOT in a bespoke table; see `provenance.ts`.

import { z } from "zod";
import { SpecPriority } from "../../state/spec.js";

// The three discovery variants the surface supports. They drive the default
// answerer's framing (feature = additive, bug = root-cause/hardening,
// strategic = large cluster) and the recommended placement.
export const DiscoveryVariant = z.enum(["feature", "bug", "strategic"]);
export type DiscoveryVariant = z.infer<typeof DiscoveryVariant>;

// The raw insight an operator drops in. `source`/`who`/`when` render as the
// provenance card; `glyph` is a single display char per variant.
export const DiscoveryInsight = z
  .object({
    variant: DiscoveryVariant,
    source: z.string().min(1).max(200),
    sourceLabel: z.string().min(1).max(80),
    who: z.string().min(1).max(120),
    when: z.string().min(1).max(120),
    glyph: z.string().min(1).max(4),
    body: z.string().min(1).max(8000),
  })
  .strict();
export type DiscoveryInsight = z.infer<typeof DiscoveryInsight>;

// One spec Forge proposes from the insight. `dependsOn` carries existing
// spec-ids the proposed spec builds on (mirrors `specs.depends_on`).
export const ProposedSpec = z
  .object({
    // A stable client-side id for this proposal within the result so the accept
    // call can name which proposals to commit (proposals are not persisted).
    proposalId: z.string().min(1),
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    dependsOn: z.array(z.string().min(1)).default([]),
    priority: SpecPriority.default("tbd"),
    estLabel: z.string().max(80).default(""),
  })
  .strict();
export type ProposedSpec = z.infer<typeof ProposedSpec>;

// One DAG-placement option. The three canonical kinds (slot-after,
// jump-backlog, interrupt) carry an ETA, side-effects, a priority, and whether
// it is the recommended pick or carries risk (interrupt-a-P0).
export const PlacementKind = z.enum(["slot_after", "jump_backlog", "interrupt"]);
export type PlacementKind = z.infer<typeof PlacementKind>;

export const PlacementOption = z
  .object({
    kind: PlacementKind,
    label: z.string().min(1).max(120),
    eta: z.string().min(1).max(80),
    sideEffects: z.string().min(1).max(200),
    priority: z.string().min(1).max(40),
    recommended: z.boolean().default(false),
    risk: z.boolean().default(false),
  })
  .strict();
export type PlacementOption = z.infer<typeof PlacementOption>;

// The "what's changing" panel: personas/behaviors/specs added or impacted.
export const ImpactDelta = z
  .object({
    title: z.string().min(1).max(40),
    kind: z.enum(["add", "mod", "impact"]),
    count: z.string().min(1).max(60),
    deltas: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type ImpactDelta = z.infer<typeof ImpactDelta>;

// The full classification a discovery exchange returns.
export const DiscoveryResult = z
  .object({
    variant: DiscoveryVariant,
    // The Forge classification narrative (rendered as the chat thread summary).
    summary: z.string().min(1).max(4000),
    proposals: z.array(ProposedSpec).min(1),
    placements: z.array(PlacementOption).min(1),
    deltas: z.array(ImpactDelta).default([]),
    // Files/issues the answerer read while classifying (observability + render).
    readSummary: z.string().max(200).default(""),
  })
  .strict();
export type DiscoveryResult = z.infer<typeof DiscoveryResult>;

// The injectable discovery answerer — the LLM seam, mirroring the conversation answerer's
// `ForgeConversationAnswerer`. The real implementation wraps a provider
// Answerer; tests inject a fake. The answerer never executes tools itself: it
// returns the classification (the engine may ground it via read tools first).
export interface DiscoveryAnswererContext {
  insight: DiscoveryInsight;
  projectId: string;
  // Existing project specs (id + title + status), so the answerer can ground
  // `dependsOn` and placement against the live DAG.
  existingSpecs: ReadonlyArray<{ specId: string; title: string; status: string }>;
}

export interface DiscoveryAnswerer {
  classify(context: DiscoveryAnswererContext): Promise<DiscoveryResult>;
}
