/**
 * Pure project-DAG types. Kept free of any runtime / server-only
 * import so both the server (route + builder) and the browser island can
 * import them without dragging the orchestrator client (and its `process`
 * usage) into the client typecheck/bundle.
 */

/** The five locked node statuses (colour + glyph keyed off these). */
export type DagStatus = "done" | "live" | "review" | "blocked" | "queued";

/**
 * Codex H3 #9 — the triage-routing PROVENANCE trail (Claude RA2, migration
 * 0025) surfaced on a DAG node. Present iff the spec was auto-routed by triage
 * from a parent spec's finding; operator / discovery / seed specs omit. The
 * DAG view renders the routing chain from this block so an operator can trace
 * a routed node back to its origin without a spec-detail fetch.
 */
export interface DagNodeTriageProvenance {
  parentSpecId: string;
  sourceFindingIds: string[];
  originTriageTaskId: string;
  originRunId: string;
}

/** A spec node in the assembled graph. */
export interface DagNode {
  id: string;
  title: string;
  status: DagStatus;
  milestone: string;
  milestoneId: string | null;
  behaviors: string[];
  priority: "review" | "blocked" | "live" | "queued" | "done";
  latestRunId: string | null;
  onCriticalPath: boolean;
  attention: number | null;
  /**
   * Codex H3 #9 — the triage-routing PROVENANCE trail; undefined for a
   * non-routed spec. See {@link DagNodeTriageProvenance}.
   */
  triageProvenance?: DagNodeTriageProvenance;
}

/** A dependency edge: `from` (upstream dep) → `to` (the dependent spec). */
export interface DagEdge {
  from: string;
  to: string;
  hot: boolean;
}

/** A milestone column header. */
export interface DagMilestone {
  id: string;
  label: string;
  name: string;
  status: string;
  attention: number | null;
}

export interface DagAttentionItem {
  n: number;
  kind: "review" | "blocked" | "live";
  nodeId: string;
  title: string;
  sub: string;
}

export interface ProjectDag {
  nodes: DagNode[];
  edges: DagEdge[];
  milestones: DagMilestone[];
  attention: DagAttentionItem[];
  counts: {
    total: number;
    done: number;
    live: number;
    review: number;
    blocked: number;
    queued: number;
    criticalPath: number;
    behaviors: number;
  };
}
