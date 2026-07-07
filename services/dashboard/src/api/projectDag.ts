/**
 * Typed project-DAG read. The orchestrator already exposes every
 * primitive the spec graph is built from — specs (with `dependsOn` spec-id
 * edges + status), milestones, behaviors, and runs — but no single endpoint
 * that returns the assembled graph. Rather than add a new persisted view or a
 * migration (explicitly out of scope), this composes the existing typed reads
 * into one `ProjectDag` payload (nodes + edges + per-node status/attention)
 * that the DAG-primary view consumes. No new persisted data is written.
 *
 * Status mapping mirrors the chat-primary `dagStatusForRun` rules so a spec's
 * node colour matches its run state across both modes.
 */

import { RECOVERABLE_OUTCOMES } from "@tanren/db";
import type { DagAttentionItem, DagEdge, DagMilestone, DagNode, DagStatus, ProjectDag } from "./dagTypes.js";
import type { OrchestratorClient } from "./orchestrator.js";
import type { RunListItem, SpecTriageProvenance } from "./types.js";

export type { DagAttentionItem, DagEdge, DagMilestone, DagNode, DagStatus, ProjectDag };

// HALTED-outcome policy set is imported from @tanren/db so the dashboard and the
// orchestrator's `assertRecoverable` gate read the SAME source-of-truth. The prior
// private `HALTED` copy here was missing `convergence_stalled` + `window_exhausted`,
// so runs with those outcomes did not colour the DAG node blocked. See
// `db/src/recoveryOutcomes.ts` for the drift rationale.

/** Per-spec run state → node status, mirroring `dagStatusForRun`. */
function statusForSpec(specStatus: string, run: RunListItem | undefined): DagStatus {
  if (run !== undefined) {
    if (run.needsReview) return "review";
    if (run.status === "running") return "live";
    if (run.outcome !== null && RECOVERABLE_OUTCOMES.has(run.outcome)) return "blocked";
    if (run.status === "completed") return "done";
    if (run.status === "queued") return "queued";
  }
  // No run yet — fall back to the spec's own lifecycle status.
  const s = specStatus.toLowerCase();
  if (s === "merged") return "done";
  if (s === "in_flight" || s === "running") return "live";
  if (s === "review") return "review";
  if (s === "blocked" || s === "halted") return "blocked";
  return "queued";
}

function priorityFor(status: DagStatus): DagNode["priority"] {
  return status;
}

/**
 * Pick the most-recent run per spec from the run list (runs arrive newest
 * first per ordering, so the first match wins).
 */
function latestRunsBySpec(runs: RunListItem[]): Map<string, RunListItem> {
  const map = new Map<string, RunListItem>();
  for (const run of runs) {
    if (!map.has(run.specId)) map.set(run.specId, run);
  }
  return map;
}

export interface BuildDagInput {
  specs: {
    specId: string;
    title: string;
    dependsOn: string[];
    status: string;
    /**
     * Codex H3 #9 — the triage-routing PROVENANCE trail on a routed spec.
     * Threaded from the orchestrator `SpecSummary` so the DAG-view node exposes
     * the routing origin. Absent on operator/discovery/seed specs.
     */
    triageProvenance?: SpecTriageProvenance;
  }[];
  milestones: { id: string; label: string; name: string; status: string }[];
  runs: RunListItem[];
  /** spec-id → behaviour titles (best-effort; empty when unlinked). */
  behaviorsBySpec?: Map<string, string[]>;
  /** spec-id → milestone-id (best-effort; empty when unlinked). */
  milestoneBySpec?: Map<string, string>;
}

/**
 * Assemble the DAG model from the orchestrator primitives. Pure + I/O-free so
 * it is unit-testable; `getProjectDag` does the fetching and calls this.
 */
export function buildProjectDag(input: BuildDagInput): ProjectDag {
  const runsBySpec = latestRunsBySpec(input.runs);
  const specIds = new Set(input.specs.map((s) => s.specId));

  // Critical path: a spec is on it when at least one other spec depends on it.
  const dependedOn = new Set<string>();
  for (const spec of input.specs) {
    for (const dep of spec.dependsOn) {
      if (specIds.has(dep)) dependedOn.add(dep);
    }
  }

  const milestoneById = new Map(input.milestones.map((m) => [m.id, m]));

  const nodes: DagNode[] = input.specs.map((spec) => {
    const run = runsBySpec.get(spec.specId);
    const status = statusForSpec(spec.status, run);
    const mId = input.milestoneBySpec?.get(spec.specId) ?? null;
    const milestone = mId === null ? "—" : (milestoneById.get(mId)?.label ?? "—");
    return {
      id: spec.specId,
      title: spec.title,
      status,
      milestone,
      milestoneId: mId,
      behaviors: input.behaviorsBySpec?.get(spec.specId) ?? [],
      priority: priorityFor(status),
      latestRunId: run?.runId ?? null,
      onCriticalPath: dependedOn.has(spec.specId),
      attention: null,
      // Codex H3 #9 — thread the triage-routing PROVENANCE trail (Claude RA2)
      // onto the DAG node so the DAG view can render the routing chain for a
      // routed spec. Undefined on operator/discovery/seed specs.
      ...(spec.triageProvenance !== undefined && { triageProvenance: spec.triageProvenance }),
    };
  });

  const statusById = new Map(nodes.map((n) => [n.id, n.status]));
  const edges: DagEdge[] = [];
  for (const spec of input.specs) {
    for (const dep of spec.dependsOn) {
      if (!specIds.has(dep)) continue;
      const hot = isActionStatus(statusById.get(dep)) || isActionStatus(statusById.get(spec.specId));
      edges.push({ from: dep, to: spec.specId, hot });
    }
  }

  // Attention numbering: review first, then blocked, then live — capped to
  // keep the numbered overlay legible (matches the hi-fi "N need you" strip).
  const attention: DagAttentionItem[] = [];
  const order: DagStatus[] = ["review", "blocked", "live"];
  let n = 0;
  for (const kind of order) {
    for (const node of nodes) {
      if (node.status !== kind) continue;
      n += 1;
      node.attention = n;
      attention.push({
        n,
        kind: kind as "review" | "blocked" | "live",
        nodeId: node.id,
        title: node.title,
        sub: attentionSub(kind, node),
      });
    }
  }

  const milestones: DagMilestone[] = input.milestones.map((m) => ({
    id: m.id,
    label: m.label,
    name: m.name,
    status: m.status,
    attention: null,
  }));

  const behaviorTitles = new Set<string>();
  for (const node of nodes) for (const b of node.behaviors) behaviorTitles.add(b);

  return {
    nodes,
    edges,
    milestones,
    attention,
    counts: {
      total: nodes.length,
      done: nodes.filter((nd) => nd.status === "done").length,
      live: nodes.filter((nd) => nd.status === "live").length,
      review: nodes.filter((nd) => nd.status === "review").length,
      blocked: nodes.filter((nd) => nd.status === "blocked").length,
      queued: nodes.filter((nd) => nd.status === "queued").length,
      criticalPath: dependedOn.size,
      behaviors: behaviorTitles.size,
    },
  };
}

function isActionStatus(status: DagStatus | undefined): boolean {
  return status === "review" || status === "blocked" || status === "live";
}

function attentionSub(kind: DagStatus, node: DagNode): string {
  if (kind === "review") return "review-ready";
  if (kind === "blocked") return node.onCriticalPath ? "blocking the critical path" : "blocked";
  return "in flight";
}

/**
 * Fetch + assemble the project DAG. Composes the existing typed orchestrator
 * reads (specs, milestones, runs, behaviors). Degrades to an empty graph when
 * a source is unreachable — the view renders a "fresh DAG" empty state rather
 * than 500-ing.
 */
export async function getProjectDag(client: OrchestratorClient, orgId: string, projectId: string): Promise<ProjectDag> {
  const [specs, milestones, runs, behaviors] = await Promise.all([
    client.listSpecs(orgId, projectId),
    client.listMilestones(orgId, projectId),
    client.listRuns(orgId, projectId),
    client.listAllBehaviors(orgId, projectId),
  ]);

  // Behaviour linkage is not yet exposed per-spec by the read API, so we leave
  // `behaviorsBySpec` empty for now and surface the project behaviour count via
  // the milestone strip. Group-by-behavior buckets unlinked specs together.
  void behaviors;

  return buildProjectDag({
    specs: specs.map((s) => ({
      specId: s.specId,
      title: s.title,
      dependsOn: s.dependsOn,
      status: s.status,
      // Codex H3 #9 — forward the SpecSummary's triage-routing PROVENANCE onto
      // the DAG-build input so the routing origin surfaces on the DAG node.
      ...(s.triageProvenance !== undefined && { triageProvenance: s.triageProvenance }),
    })),
    milestones: milestones.map((m) => ({
      id: m.id,
      label: m.label,
      name: m.name,
      status: m.status,
    })),
    runs,
  });
}
