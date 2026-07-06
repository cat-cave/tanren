// spec discovery engine.
//
// Two operations, both composing existing foundations:
//
//   classifyInsight(deps, input)
//     Runs a Forge CLASSIFICATION over the injectable `DiscoveryAnswerer`
//     (the same seam shape as the conversation answerer — provider in
//     prod, fake in tests). It grounds the answerer with the project's existing
//     specs (read through the typed spec list) and returns the proposed specs +
//     DAG-placement options + impact deltas. NOTHING is persisted here.
//
//   acceptProposals(deps, input)
//     Commits accepted proposals: creates each spec through the EXISTING
//     `createSpec` path (so authz/dependency checks are unchanged),
//     then persists discovery PROVENANCE onto each new spec's `metadata` JSONB
//     and records the chosen DAG-placement. Returns the created spec-ids.
//
// The accept path deliberately reuses `createSpec` rather than forking spec
// creation; placement is recorded as provenance + reflected in the spec's
// dependency edges (a slot-after/jump option carries the proposal's `dependsOn`
// onto the new spec). An interrupt placement does NOT auto-trigger a run here —
// triggering stays an explicit operator action through the existing run path.

import type pg from "pg";
import type { ActorContext } from "../../../auth/schemas.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import { systemActor } from "../../state/actor.js";
import { DiscoveryStore, type ExistingSpecSummary } from "../../repositories/discovery.js";
import { createSpec, type SpecContract, type SpecTriageProvenance } from "../../workflow/projectSpec.js";
import { writeProvenance, writeProvenanceViaWriter, type DiscoveryProvenance } from "./provenance.js";
import {
  DiscoveryInsight,
  type DiscoveryAnswerer,
  type DiscoveryResult,
  type PlacementKind,
  type ProposedSpec,
} from "./types.js";

export interface DiscoveryEngineDeps {
  pool: pg.Pool;
  // The classification seam — REQUIRED. Production resolves a real provider
  // answerer from the project's `forge` routing (the model DERIVES the proposed
  // specs + DAG placement); tests inject a fake. There is NO production fallback
  // to a hardcoded-proposal template (§8a). Only `classifyInsight` consults it;
  // `acceptProposals` commits an already-classified set, so it is optional there.
  answerer?: DiscoveryAnswerer;
  // Plane-split (autonomy loops): the control-plane run-state writer. When present
  // (the autonomous-intake path under remote-writes), `acceptProposals` routes its
  // spec INSERT (`createSpec`) + its provenance UPDATE (`writeProvenance`) through
  // the control plane — the de-privileged data plane can no longer write `specs`
  // directly (migration 0035). Absent (the operator route under `tanren_app`, or
  // single-role dev), it writes directly — byte-identical to today.
  runStateWriter?: RunStateWriter;
}

export interface ClassifyInput {
  projectId: string;
  insight: DiscoveryInsight;
  actor: ActorContext;
}

// Loads the project's existing specs (id/title/status) to ground the answerer.
async function loadExistingSpecs(client: pg.Pool, projectId: string): Promise<ExistingSpecSummary[]> {
  return DiscoveryStore.listExistingSpecs(client, projectId, systemActor);
}

/** Thrown when `classifyInsight` runs without a model answerer wired (§8a). */
export class DiscoveryAnswererUnconfiguredError extends Error {
  constructor() {
    super("discovery classification requires a provider answerer; none was wired");
    this.name = "DiscoveryAnswererUnconfiguredError";
  }
}

export async function classifyInsight(deps: DiscoveryEngineDeps, input: ClassifyInput): Promise<DiscoveryResult> {
  // Validate the insight at the engine boundary (defence in depth; the route
  // also validates) so a malformed body never reaches the answerer.
  const insight = DiscoveryInsight.parse(input.insight);
  if (deps.answerer === undefined) {
    throw new DiscoveryAnswererUnconfiguredError();
  }
  const existingSpecs = await loadExistingSpecs(deps.pool, input.projectId);
  return deps.answerer.classify({ insight, projectId: input.projectId, existingSpecs });
}

export interface AcceptInput {
  projectId: string;
  insight: DiscoveryInsight;
  // The proposals to commit (a subset of a prior classify result). Carrying the
  // proposals on the accept request keeps the proposals stateless — they are
  // never persisted until accepted.
  proposals: ProposedSpec[];
  placementKind: PlacementKind;
  placementLabel: string;
  actor: ActorContext;
  /**
   * Triage routing provenance (Claude RA2). Set by the
   * `plannerRunTriageNewSpecs.ts` materializer to stamp the new spec with its
   * origin trail (parent_spec_id / source_finding_ids / origin_triage_task_id /
   * origin_run_id). Absent on operator-driven accepts from an insight or the
   * discovery UI.
   */
  triageProvenance?: SpecTriageProvenance;
}

export interface AcceptedSpec {
  spec: SpecContract;
  proposalId: string;
}

export interface AcceptResult {
  accepted: AcceptedSpec[];
}

const EXCERPT_MAX = 240;

function provenanceFor(insight: DiscoveryInsight, input: AcceptInput): DiscoveryProvenance {
  return {
    variant: insight.variant,
    insightSource: insight.source,
    insightSourceLabel: insight.sourceLabel,
    insightWho: insight.who,
    insightWhen: insight.when,
    insightExcerpt: insight.body.slice(0, EXCERPT_MAX),
    placementKind: input.placementKind,
    placementLabel: input.placementLabel,
    discoveredAt: new Date().toISOString(),
  };
}

// Commit each accepted proposal: create the spec (existing path), then stamp
// provenance + placement onto its metadata. Runs each proposal sequentially so
// a `dependsOn` referencing an earlier proposal in the same batch could be
// honored by id-substitution in a future iteration; v0 only wires `dependsOn`
// that already references existing specs.
export async function acceptProposals(deps: DiscoveryEngineDeps, input: AcceptInput): Promise<AcceptResult> {
  const insight = DiscoveryInsight.parse(input.insight);
  const provenance = provenanceFor(insight, input);
  const accepted: AcceptedSpec[] = [];

  for (const proposal of input.proposals) {
    const createSpecInput = {
      projectId: input.projectId,
      title: proposal.title,
      description: proposal.description,
      acceptanceCriteria: proposal.acceptanceCriteria,
      // Persist the discovery/triage priority onto the spec (autonomy-engine.md
      // §1b) so the DagWalker orders by it instead of FIFO.
      priority: proposal.priority,
      ...(proposal.dependsOn.length > 0 ? { dependsOn: proposal.dependsOn } : {}),
      // Triage routing provenance (Claude RA2) — persisted onto the created
      // spec's first-class columns so the routing trail is queryable, not
      // only recoverable from the discovery jsonb metadata blob.
      ...(input.triageProvenance !== undefined && { triageProvenance: input.triageProvenance }),
    };
    // Plane-split: route the spec INSERT + the provenance UPDATE through the control
    // plane when a writer is wired (the autonomous-intake path under remote-writes);
    // else write directly — byte-identical to the operator route.
    const spec =
      deps.runStateWriter === undefined
        ? await createSpec(deps.pool, createSpecInput, input.actor)
        : await deps.runStateWriter.createSpec({ input: createSpecInput, actor: input.actor });
    if (deps.runStateWriter !== undefined && input.actor.orgId !== null) {
      await writeProvenanceViaWriter(deps.pool, deps.runStateWriter, input.actor.orgId, spec.specId, provenance);
    } else {
      await writeProvenance(deps.pool, spec.specId, provenance);
    }
    accepted.push({ spec, proposalId: proposal.proposalId });
  }

  return { accepted };
}
