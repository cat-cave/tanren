// P1d autonomous intake — the system actor that COMMITS an auto-routed spec
// (autonomy-engine.md §1d). Intake has no operator, so the DAG insert runs as a
// platform-admin actor carrying the candidate's org — the SAME pattern the
// DagWalker enqueuer and the BenchmarkRunner use, so the `acceptProposals` →
// `createSpec` write is RLS-scoped to the tenant (org-scoped insert under RLS).

import type { ActorContext } from "../../../auth/schemas.js";
import type { RunStateWriter } from "../../contracts/runStateWriter.js";
import type { AutoRouteDeps } from "../inbox/index.js";

export interface IntakeAutoRouteOptions {
  runStateWriter?: RunStateWriter;
  /**
   * The spec-quality VALIDATOR resolver (workstream 1). When wired, every
   * auto-routed `routableSpec` is gated against the four-part spec-quality contract
   * before it lands in the DAG (a failing spec escalates LOUD, never a silent
   * commit). Resolved per-candidate from the candidate's org/project — the same
   * per-call allocation model the triage answerer uses.
   */
  resolveSpecValidator?: AutoRouteDeps["resolveSpecValidator"];
}

/**
 * Build the auto-route deps whose actor is a platform-admin scoped to the org.
 * Plane-split: when a control-plane writer is wired (remote-writes on), the
 * auto-route's spec creation + provenance stamp route through it instead of the
 * de-privileged direct-pool writes. When a spec-quality validator resolver is
 * wired, the auto-routed spec is gated against the spec-quality contract first.
 */
export function intakeAutoRouteDeps(options: IntakeAutoRouteOptions = {}): AutoRouteDeps {
  return {
    resolveActor: (orgId: string): ActorContext => ({
      userId: "intake",
      orgId,
      projectId: null,
      scopes: ["platform:admin"],
      source: "local_dev",
    }),
    ...(options.runStateWriter !== undefined && { runStateWriter: options.runStateWriter }),
    ...(options.resolveSpecValidator !== undefined && { resolveSpecValidator: options.resolveSpecValidator }),
  };
}
