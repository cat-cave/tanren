// CI-intelligence PR2 — the worker-loop flaky+duration detector. Before this, the
// flaky detector ran ONLY as a side effect of the dashboard `GET …/insights`
// route (the route passed an eventStore so a read triggered the write). That made
// actuation depend on a human opening a page. This loop drives the SAME
// `detectAndQuarantineFlaky` pass on a cadence — independent of any GET — so a
// proven-flaky check/test is quarantined (and the merge gate's quarantine READ
// excludes it) without an operator trigger.
//
// Template: the AuditSchedulerLoop (engine/forge/audits/loop.ts) — a long-lived
// per-process loop the worker boot starts, cross-org (system-scoped to enumerate),
// per-project under that project's org scope (so the `quarantined_tests` write +
// the `ci.flaky.detected`/`ci.test.quarantined` emits are RLS-admitted, exactly as
// the insights route runs them inside the request's org transaction). Tolerant of a
// per-project failure: one project erroring never stalls the rest or the next tick.

import type pg from "pg";
import { runWithJobOrgId, runWithOrgScope, runWithSystemScope } from "@tanren/db";
import { PgEventStore } from "../eventStore.js";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import { detectAndQuarantineFlaky, loadCiObservations } from "../insights/ciFlaky.js";
import { emitCiInsightCandidates } from "../insights/ciInsightsCandidates.js";
import type { InsightThresholds } from "../insights/thresholds.js";
import type { AutoRouteDeps, TriageAnswerer } from "../forge/inbox/index.js";
import type { ForgeAnswererTarget } from "../forge/providerFactory.js";

export interface CiInsightsLoopDeps {
  pool: pg.Pool;
  /**
   * Plane-split: the control-plane run-state writer. The worker runs as
   * `tanren_dataplane`, which has NO `events` grant — so the detector's
   * `ci.flaky.detected` / `ci.test.quarantined` emits CANNOT go through the
   * org-scoped data-plane client; they route through this writer (the control
   * plane) instead. Absent ⇒ in-process via `PgEventStore` (tests / single
   * privileged pool), exactly as `DeployOnMergeWatcher` does it.
   */
  runStateWriter?: RunStateWriter;
  /** Per-org/project threshold overrides. */
  thresholds?: Partial<InsightThresholds>;
  /**
   * The GENERATIVE arm (PR3). When BOTH are wired the loop also emits one
   * auto-routed candidate per GENUINE recurring problem (flaky/slow) AFTER the
   * mechanical quarantine, root-cause-triages it, and ships the fix-spec through the
   * SAME inbox auto-route spine. Absent ⇒ the loop only detects+quarantines (PR2),
   * so a caller that has no provider answerer / auto-route still runs.
   */
  answererFactory?: (target: ForgeAnswererTarget) => TriageAnswerer;
  /** The autonomous DAG-insert deps (system actor + plane-split writer). */
  autoRoute?: AutoRouteDeps;
  now?: () => number;
}

interface ProjectOrgRow {
  project_id: string;
  org_id: string;
}

/**
 * The recurring CI-insights detector. `start()` ticks on an interval; each tick
 * runs `detectAndQuarantineFlaky` for every project (under its org scope). The
 * detector is idempotent (the partial unique index + ON CONFLICT DO NOTHING guard
 * a re-record; events fire once per episode), so re-running on a cadence is safe.
 */
export class CiInsightsLoop {
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;
  private ticking = false;
  private readonly now: () => number;

  constructor(
    private readonly deps: CiInsightsLoopDeps,
    private readonly tickIntervalMs: number = 15 * 60_000,
  ) {
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer !== undefined) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one detection pass over every project. Returns the project ids processed. */
  async tick(): Promise<string[]> {
    if (this.ticking || this.stopped) return [];
    this.ticking = true;
    try {
      let projects: ProjectOrgRow[];
      try {
        projects = await this.listProjects();
      } catch (error) {
        console.error("[ci-insights] failed to list projects (will retry next tick):", error);
        return [];
      }
      const processed: string[] = [];
      for (const project of projects) {
        if (this.stopped) break;
        try {
          await this.detectForProject(project);
          processed.push(project.project_id);
        } catch (error) {
          console.error(`[ci-insights] detection failed for project ${project.project_id}:`, error);
        }
      }
      return processed;
    } finally {
      this.ticking = false;
    }
  }

  private async detectForProject(project: ProjectOrgRow): Promise<void> {
    const nowDate = new Date(this.now());
    // PLANE-SPLIT: the worker runs as `tanren_dataplane`. Tenant work
    // (`ci_test_results` + `quarantined_tests`) runs on the org-scoped client — both
    // are RLS-admitted under the project's org. But `events` is OFF this plane: the
    // `ci.*` READ goes through a system-scoped client (no dataplane `events` grant)
    // and the `ci.flaky.detected` / `ci.test.quarantined` EMITS route through the
    // control-plane writer. Both event sites are wrapped in the job org id so the
    // control plane attributes them. Absent a writer (single privileged pool), the
    // in-process `PgEventStore` on the org client serves (tests / non-plane-split).
    await runWithJobOrgId(project.org_id, () =>
      runWithOrgScope(this.deps.pool, project.org_id, async (client) => {
        await detectAndQuarantineFlaky(client, {
          projectId: project.project_id,
          now: nowDate,
          ...(this.deps.thresholds !== undefined && { thresholds: this.deps.thresholds }),
          eventStore: this.deps.runStateWriter ?? new PgEventStore(client),
          loadChecks: (since) =>
            runWithSystemScope(this.deps.pool, (sysClient) =>
              loadCiObservations(sysClient, { projectId: project.project_id, since }),
            ),
        });
      }),
    );
    // PR3 generative arm: AFTER the mechanical quarantine, turn each genuine recurring
    // problem into a durable-fix candidate that ships through the inbox auto-route
    // spine. Runs under a per-job org id (the emitter wraps the pool in
    // `orgScopingPool`, like the intake poller) so the candidate/spec writes are
    // RLS-scoped. Only when the generative deps are wired (else PR2 detect-only).
    await this.emitForProject(project, nowDate);
  }

  private async emitForProject(project: ProjectOrgRow, nowDate: Date): Promise<void> {
    const { answererFactory, autoRoute } = this.deps;
    if (answererFactory === undefined || autoRoute === undefined) return;
    await runWithJobOrgId(project.org_id, () =>
      emitCiInsightCandidates({
        pool: this.deps.pool,
        projectId: project.project_id,
        orgId: project.org_id,
        answerer: answererFactory({ orgId: project.org_id, projectId: project.project_id }),
        autoRoute,
        now: nowDate,
        ...(this.deps.thresholds !== undefined && { thresholds: this.deps.thresholds }),
      }),
    );
  }

  private async listProjects(): Promise<ProjectOrgRow[]> {
    return runWithSystemScope(this.deps.pool, async (client) => {
      const result = await client.query<ProjectOrgRow>(
        "SELECT project_id, org_id FROM projects WHERE org_id IS NOT NULL",
      );
      return result.rows;
    });
  }
}
