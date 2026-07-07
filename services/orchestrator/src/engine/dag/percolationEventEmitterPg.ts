// The pg-backed dag.spec.percolation.* event emitter, split from `percolationPg.ts`
// for the 500-line cap + to mirror the sibling `PgDagEventEmitter` file layout.
// Resolves the project's org, then writes each of the four dag.spec.percolation
// events (percolating / percolated / percolation_deferred / percolation_replan)
// through the org-scoped writer seam (the de-privileged data plane can no longer
// write `events` directly; PR #714 made the writer-undefined fallback unreachable).

import { runWithJobOrgId } from "@tanren/db";
import type pg from "pg";
import type { ImmediateSeverity, LazySeverity, PercolationEventEmitter } from "../contracts/changePercolation.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { EventStore } from "../eventStore.js";
import { createLogger } from "../observability/logger.js";
import { resolveProjectOrg } from "./percolationWrites.js";

const log = createLogger("change-percolation");

export interface PgPercolationEventEmitterDeps {
  pool: pg.Pool;
  /** REQUIRED (audit D-R3.2 sweep, PR #714): the dag.spec.percolation events append through
   * the writer — the de-privileged data plane can no longer write `events` directly. */
  runStateWriter: RunStateWriter;
}

/** The pg-backed dag.spec.percolation emitter (org-scoped, mirrors PgDagEventEmitter). */
export class PgPercolationEventEmitter implements PercolationEventEmitter {
  constructor(private readonly deps: PgPercolationEventEmitterDeps) {}

  private async withScopedStore(
    pid: string,
    eventKind: string,
    work: (s: EventStore, o: string) => Promise<void>,
  ): Promise<void> {
    const orgId = await resolveProjectOrg(this.deps.pool, pid);
    if (orgId === null) {
      // Observability fix (task #46 follow-up to PR #763): this branch used to
      // silently return when the project row was missing or its `org_id` was
      // NULL — the dag.spec.percolation.* event was DROPPED so the operator
      // could not see WHY without grepping engine logs. Mirrors the exact fail-
      // loud posture PR #763 introduced on the sibling `PgDagEventEmitter`: log
      // at ERROR with the projectId + eventKind + a machine-parseable
      // `unresolvable_project_org` reason so an operator has a grep-able signal.
      // We do NOT synthesize an org (events.org_id NOT NULL + FK-tied — v68
      // jobReaper.ts rationale: never fake tenancy to satisfy a NOT NULL).
      log.error("dag event DROPPED — project org unresolvable", {
        projectId: pid,
        eventKind,
        reason: "unresolvable_project_org",
      });
      return;
    }
    const writer = this.deps.runStateWriter;
    await runWithJobOrgId(orgId, () => work(writer, orgId));
  }

  async emitPercolating(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    fromAncestorSha: string;
    toAncestorSha: string;
    severity: ImmediateSeverity;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, "dag.spec.percolating", (store, orgId) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        orgId,
        eventType: "dag.spec.percolating",
        payload: {
          specId: input.specId,
          runId: input.runId,
          ancestorSpecId: input.ancestorSpecId,
          fromAncestorSha: input.fromAncestorSha,
          toAncestorSha: input.toAncestorSha,
          severity: input.severity,
        },
      }),
    );
  }

  async emitPercolated(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    integratedAncestorSha: string;
    viaResolver: boolean;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, "dag.spec.percolated", (store, orgId) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        orgId,
        eventType: "dag.spec.percolated",
        payload: {
          specId: input.specId,
          runId: input.runId,
          ancestorSpecId: input.ancestorSpecId,
          integratedAncestorSha: input.integratedAncestorSha,
          viaResolver: input.viaResolver,
        },
      }),
    );
  }

  async emitPercolationDeferred(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    pendingAncestorSha: string;
    severity: LazySeverity;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, "dag.spec.percolation_deferred", (store, orgId) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        orgId,
        eventType: "dag.spec.percolation_deferred",
        payload: {
          specId: input.specId,
          runId: input.runId,
          ancestorSpecId: input.ancestorSpecId,
          pendingAncestorSha: input.pendingAncestorSha,
          severity: input.severity,
        },
      }),
    );
  }

  async emitPercolationReplan(input: {
    projectId: string;
    specId: string;
    runId: string;
    ancestorSpecId: string;
    ancestorSha: string;
    reason: string;
  }): Promise<void> {
    await this.withScopedStore(input.projectId, "dag.spec.percolation_replan", (store, orgId) =>
      store.append({
        runId: input.runId,
        specId: input.specId,
        projectId: input.projectId,
        orgId,
        eventType: "dag.spec.percolation_replan",
        payload: {
          specId: input.specId,
          runId: input.runId,
          ancestorSpecId: input.ancestorSpecId,
          ancestorSha: input.ancestorSha,
          reason: input.reason,
        },
      }),
    );
  }
}
