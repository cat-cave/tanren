// Tenant-isolation hardening (tanren SaaS Tier-A): proves cross-tenant access
// is denied at the LOADER level, not merely at the route gate. Every core
// run-execution loader takes the actor's resolved org and filters by org_id,
// so even if a route gate were bypassed a foreign-org actor sees nothing.
//
// The fixtures seed identical run/task/event/cost rows under two orgs and then
// query each loader with the WRONG org; the loader must return empty / undefined
// while the right org still returns the row.

import { describe, expect, it } from "vitest";
import {
  fetchCostsPage,
  fetchEventsPage,
  fetchRunCostsForSnapshot,
  fetchRunEventsForSnapshot,
  fetchRunListItems,
  fetchRunSummary,
  fetchRunTasks,
} from "../src/routes/runs/list.js";
import { RunRoutesPool } from "./helpers/runRoutesPool.js";
import type { ActorContext } from "../src/auth/schemas.js";

const OWNER_ORG = "org_acme";
const FOREIGN_ORG = "org_intruder";

const actor: ActorContext = {
  userId: "user_alice",
  orgId: OWNER_ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function seedOwnedRun(pool: RunRoutesPool): { runId: string; projectId: string } {
  const runId = "run_owned";
  const projectId = "project_owned";
  pool.seedProject({ project_id: projectId, org_id: OWNER_ORG });
  pool.seedSpec({ spec_id: "spec_owned", project_id: projectId, title: "Owned spec" });
  pool.seedRun({ run_id: runId, spec_id: "spec_owned", project_id: projectId, org_id: OWNER_ORG, status: "completed" });
  pool.seedTask({ task_id: "task_owned", run_id: runId, org_id: OWNER_ORG, kind: "plan", status: "done" });
  pool.seedEvent({ id: 1, run_id: runId, project_id: projectId, org_id: OWNER_ORG, event_type: "run.queued" });
  pool.seedCost({ id: 1, run_id: runId, task_id: "task_owned", project_id: projectId, org_id: OWNER_ORG });
  return { runId, projectId };
}

describe("tenant isolation — loaders filter by org_id", () => {
  it("fetchRunSummary hides a run from a foreign org but shows it to the owner", async () => {
    const pool = new RunRoutesPool();
    const { runId } = seedOwnedRun(pool);
    expect(await fetchRunSummary(pool.asPgPool(), runId, OWNER_ORG)).toBeDefined();
    expect(await fetchRunSummary(pool.asPgPool(), runId, FOREIGN_ORG)).toBeUndefined();
  });

  it("fetchRunTasks returns no tasks for a foreign org", async () => {
    const pool = new RunRoutesPool();
    const { runId } = seedOwnedRun(pool);
    expect(await fetchRunTasks(pool.asPgPool(), runId, OWNER_ORG)).toHaveLength(1);
    expect(await fetchRunTasks(pool.asPgPool(), runId, FOREIGN_ORG)).toHaveLength(0);
  });

  it("fetchRunEventsForSnapshot returns no events for a foreign org", async () => {
    const pool = new RunRoutesPool();
    const { runId } = seedOwnedRun(pool);
    const args = { runId, limit: 50, actor, rawView: false };
    expect(await fetchRunEventsForSnapshot(pool.asPgPool(), { ...args, orgId: OWNER_ORG })).toHaveLength(1);
    expect(await fetchRunEventsForSnapshot(pool.asPgPool(), { ...args, orgId: FOREIGN_ORG })).toHaveLength(0);
  });

  it("fetchEventsPage returns no events for a foreign org", async () => {
    const pool = new RunRoutesPool();
    const { runId } = seedOwnedRun(pool);
    const args = { runId, cursor: undefined, pageSize: undefined, actor, rawView: false };
    expect((await fetchEventsPage(pool.asPgPool(), { ...args, orgId: OWNER_ORG })).items).toHaveLength(1);
    expect((await fetchEventsPage(pool.asPgPool(), { ...args, orgId: FOREIGN_ORG })).items).toHaveLength(0);
  });

  it("fetchRunCostsForSnapshot returns no costs for a foreign org", async () => {
    const pool = new RunRoutesPool();
    const { runId } = seedOwnedRun(pool);
    expect(await fetchRunCostsForSnapshot(pool.asPgPool(), runId, OWNER_ORG)).toHaveLength(1);
    expect(await fetchRunCostsForSnapshot(pool.asPgPool(), runId, FOREIGN_ORG)).toHaveLength(0);
  });

  it("fetchCostsPage returns no costs for a foreign org", async () => {
    const pool = new RunRoutesPool();
    const { runId } = seedOwnedRun(pool);
    const args = { runId, cursor: undefined, pageSize: undefined };
    expect((await fetchCostsPage(pool.asPgPool(), { ...args, orgId: OWNER_ORG })).items).toHaveLength(1);
    expect((await fetchCostsPage(pool.asPgPool(), { ...args, orgId: FOREIGN_ORG })).items).toHaveLength(0);
  });

  it("fetchRunListItems returns no runs for a foreign org", async () => {
    const pool = new RunRoutesPool();
    const { projectId } = seedOwnedRun(pool);
    const args = { projectId, status: undefined, specId: undefined };
    expect(await fetchRunListItems(pool.asPgPool(), { ...args, orgId: OWNER_ORG })).toHaveLength(1);
    expect(await fetchRunListItems(pool.asPgPool(), { ...args, orgId: FOREIGN_ORG })).toHaveLength(0);
  });
});
