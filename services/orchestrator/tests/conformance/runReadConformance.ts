// The run-detail read-projection half of the `Repositories` conformance suite:
// the RunStore summary + project run-list reads, the TaskStore timeline, the
// EventStore recent/feed reads, and the CostStore snapshot — the routes/runs
// loaders migrated onto the seam. Split out of repositoriesConformance.ts to
// keep each file under the line cap; it reuses that suite's harness + fixtures.

import { describe, expect, it } from "vitest";
import { systemActor } from "../../src/engine/state/actor.js";
import {
  ORG_A,
  ORG_B,
  projectA,
  type RepositoriesConformanceHarness,
  runA,
  specA,
  T0,
  T1,
} from "./conformanceFixtures.js";

export function describeRunReadConformance(
  label: string,
  makeHarness: () => RepositoriesConformanceHarness | Promise<RepositoriesConformanceHarness>,
): void {
  describe(`Repositories conformance (run reads): ${label}`, () => {
    it("reads the run-detail summary projection and scopes off-scope to undefined", async () => {
      const h = await makeHarness();
      await h.seed({ projects: [projectA()], specs: [specA()], runs: [runA()] });
      const row = await h.repositories.runs.selectSummary(h.clientForOrg(ORG_A), "run_a", ORG_A, systemActor);
      expect(row).toMatchObject({ run_id: "run_a", spec_id: "spec_a", project_id: "project_a", status: "running" });
      // Off-scope: an org-B client cannot see org A's run.
      const off = await h.repositories.runs.selectSummary(h.clientForOrg(ORG_B), "run_a", ORG_A, systemActor);
      expect(off).toBeUndefined();
      // Missing run yields undefined (no throw).
      const missing = await h.repositories.runs.selectSummary(h.clientForOrg(ORG_A), "run_missing", ORG_A, systemActor);
      expect(missing).toBeUndefined();
    });

    it("reads the project run-list projection (spec title + aggregates), off-scope sees zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        specs: [specA()],
        runs: [runA()],
        events: [{ id: 1, ts: T1, runId: "run_a", projectId: "project_a", eventType: "run_started", orgId: ORG_A }],
        costRecords: [
          {
            id: 1,
            runId: "run_a",
            taskId: "task_a",
            projectId: "project_a",
            costUsd: "1.50",
            recordedAt: T1,
            orgId: ORG_A,
          },
        ],
      });
      const rows = await h.repositories.runs.selectListForProject(
        h.clientForOrg(ORG_A),
        { projectId: "project_a", orgId: ORG_A, status: undefined, specId: undefined },
        systemActor,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        run_id: "run_a",
        spec_title: "Spec A",
        cost_total_usd: "1.50",
        last_event_at: T1,
      });
      // status filter narrows; a non-matching status yields zero rows.
      const filtered = await h.repositories.runs.selectListForProject(
        h.clientForOrg(ORG_A),
        { projectId: "project_a", orgId: ORG_A, status: "succeeded", specId: undefined },
        systemActor,
      );
      expect(filtered).toHaveLength(0);
      // Off-scope: org-B client sees none of org A's runs.
      const off = await h.repositories.runs.selectListForProject(
        h.clientForOrg(ORG_B),
        { projectId: "project_a", orgId: ORG_A, status: undefined, specId: undefined },
        systemActor,
      );
      expect(off).toHaveLength(0);
    });

    it("reads the run-detail task timeline in phase order, off-scope sees zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        runs: [runA()],
        runTasks: [
          {
            taskId: "task_write",
            runId: "run_a",
            kind: "write",
            title: "w",
            status: "running",
            startedAt: T1,
            orgId: ORG_A,
          },
          {
            taskId: "task_plan",
            runId: "run_a",
            kind: "plan",
            title: "p",
            status: "succeeded",
            startedAt: T0,
            orgId: ORG_A,
          },
        ],
      });
      const rows = await h.repositories.tasks.selectTimeline(h.clientForOrg(ORG_A), "run_a", ORG_A, systemActor);
      expect(rows.map((r) => r["task_id"])).toEqual(["task_plan", "task_write"]);
      const off = await h.repositories.tasks.selectTimeline(h.clientForOrg(ORG_B), "run_a", ORG_A, systemActor);
      expect(off).toHaveLength(0);
    });

    it("reads run events (recent snapshot) and scopes off-scope to zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        runs: [runA()],
        events: [
          { id: 1, ts: T0, runId: "run_a", projectId: "project_a", eventType: "run_started", orgId: ORG_A },
          { id: 2, ts: T1, runId: "run_a", projectId: "project_a", eventType: "task_started", orgId: ORG_A },
        ],
      });
      // Oldest-first after taking the newest N.
      const rows = await h.repositories.events.selectRecentForRun(
        h.clientForOrg(ORG_A),
        { runId: "run_a", orgId: ORG_A, limit: 10 },
        systemActor,
      );
      expect(rows.map((r) => r.id)).toEqual([1, 2]);
      const off = await h.repositories.events.selectRecentForRun(
        h.clientForOrg(ORG_B),
        { runId: "run_a", orgId: ORG_A, limit: 10 },
        systemActor,
      );
      expect(off).toHaveLength(0);
    });

    it("reads the SSE event delta (id > sinceId) and scopes off-scope to zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        runs: [runA()],
        events: [
          { id: 1, ts: T0, runId: "run_a", projectId: "project_a", eventType: "run_started", orgId: ORG_A },
          { id: 2, ts: T1, runId: "run_a", projectId: "project_a", eventType: "task_started", orgId: ORG_A },
        ],
      });
      const rows = await h.repositories.events.selectNewForRunSince(
        h.clientForOrg(ORG_A),
        { runId: "run_a", orgId: ORG_A, sinceId: 1 },
        systemActor,
      );
      // Only event id 2 is newer than the last-seen id.
      expect(rows.map((r) => r.id)).toEqual([2]);
      const off = await h.repositories.events.selectNewForRunSince(
        h.clientForOrg(ORG_B),
        { runId: "run_a", orgId: ORG_A, sinceId: 0 },
        systemActor,
      );
      expect(off).toHaveLength(0);
    });

    it("reads the SSE cost delta (id > sinceId) and scopes off-scope to zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        runs: [runA()],
        costRecords: [
          { id: 1, runId: "run_a", taskId: "t", projectId: "project_a", costUsd: "1.00", recordedAt: T0, orgId: ORG_A },
          { id: 2, runId: "run_a", taskId: "t", projectId: "project_a", costUsd: "2.00", recordedAt: T1, orgId: ORG_A },
        ],
      });
      const rows = await h.repositories.costs.selectNewForRunSince(
        h.clientForOrg(ORG_A),
        { runId: "run_a", orgId: ORG_A, sinceId: 1 },
        systemActor,
      );
      expect(rows.map((r) => r["id"])).toEqual([2]);
      const off = await h.repositories.costs.selectNewForRunSince(
        h.clientForOrg(ORG_B),
        { runId: "run_a", orgId: ORG_A, sinceId: 0 },
        systemActor,
      );
      expect(off).toHaveLength(0);
    });

    it("reads the project event feed (newest-first, run-scoped) and scopes off-scope to zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        runs: [runA()],
        events: [
          { id: 1, ts: T0, runId: "run_a", projectId: "project_a", eventType: "run_started", orgId: ORG_A },
          { id: 2, ts: T1, runId: null, projectId: "project_a", eventType: "project_event", orgId: ORG_A },
        ],
      });
      const rows = await h.repositories.events.selectFeedPageForProject(
        h.clientForOrg(ORG_A),
        { projectId: "project_a", orgId: ORG_A, cursor: undefined, limit: 10 },
        systemActor,
      );
      // Only the run-scoped event (run_id NOT NULL) appears in the feed.
      expect(rows.map((r) => r.id)).toEqual([1]);
      const off = await h.repositories.events.selectFeedPageForProject(
        h.clientForOrg(ORG_B),
        { projectId: "project_a", orgId: ORG_A, cursor: undefined, limit: 10 },
        systemActor,
      );
      expect(off).toHaveLength(0);
    });

    it("reads run cost records (snapshot) and scopes off-scope to zero", async () => {
      const h = await makeHarness();
      await h.seed({
        projects: [projectA()],
        runs: [runA()],
        costRecords: [
          {
            id: 1,
            runId: "run_a",
            taskId: "task_a",
            projectId: "project_a",
            costUsd: "1.50",
            recordedAt: T0,
            orgId: ORG_A,
          },
        ],
      });
      const rows = await h.repositories.costs.selectForRun(
        h.clientForOrg(ORG_A),
        { runId: "run_a", orgId: ORG_A },
        systemActor,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 1, run_id: "run_a", cost_usd: "1.50" });
      const off = await h.repositories.costs.selectForRun(
        h.clientForOrg(ORG_B),
        { runId: "run_a", orgId: ORG_A },
        systemActor,
      );
      expect(off).toHaveLength(0);
    });
  });
}
