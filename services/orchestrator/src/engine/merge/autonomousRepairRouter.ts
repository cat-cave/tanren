// mq-10 — the AutonomousRepairRouter seam. The merge-queue embark consults it when a member
// is isolated for a deterministic policy failure; the router classifies the failure, persists
// the routing decision, emits the typed events, and (for a respec) re-drives spec authoring.
// This light interface is what the embark imports; the Pg impl lives in `respecRouterPg.ts`.

import type { RepairFailureClassification } from "./repairRouteDecision.js";

export interface RouteMemberFailureInput {
  readonly projectId: string;
  readonly groupId: string;
  readonly evaluationId: string;
  readonly sourceSpecId: string;
  readonly runId: string;
  /** In production always `deterministic_policy` (a `member_failure`); other arms fail closed. */
  readonly classification: RepairFailureClassification;
  readonly findingIds: ReadonlyArray<string>;
  readonly reasonCodes: ReadonlyArray<string>;
}

export type RouteMemberFailureOutcome =
  | { readonly kind: "repair_in_place" }
  | { readonly kind: "respec"; readonly replacementSpecIds: ReadonlyArray<string>; readonly packetHash: string }
  | { readonly kind: "blocked_needs_attention"; readonly reason: string };

export interface AutonomousRepairRouter {
  /**
   * Decide + durably record how to remediate an isolated member. NEVER lands, NEVER touches
   * the queue (the caller owns queue retirement); it only classifies + routes + re-drives.
   */
  routeMemberFailure(input: RouteMemberFailureInput): Promise<RouteMemberFailureOutcome>;
}
