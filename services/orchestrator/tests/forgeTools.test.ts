// P2A-0019: tool stub return-shape + write-action authz tests.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  peekAcknowledgedInsightForTests,
  tanrenAcknowledgeInsight,
  tanrenReadInsights,
  tanrenReadMilestones,
  tanrenReadRun,
  tanrenTriggerRun,
  ToolAccessDeniedError,
} from "../src/engine/forge/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const orgMember: ActorContext = {
  userId: "user_m",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

const stranger: ActorContext = {
  userId: "user_x",
  orgId: "org_b",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function pool(p: RoutesPool): pg.Pool {
  return p.asPgPool();
}

function seedProject(p: RoutesPool, projectId: string, orgId: string) {
  p.seedOrg({ id: orgId });
  p.seedMembership(orgId, "user_m");
  p.seedProject({ project_id: projectId, org_id: orgId });
}

describe("tanrenReadInsights", () => {
  it("returns an empty insights array (P2A-0020 stub)", async () => {
    const p = new RoutesPool();
    seedProject(p, "project_a", "org_a");
    const result = await tanrenReadInsights({ pool: pool(p) }, { projectId: "project_a" }, orgMember);
    expect(result).toEqual({ insights: [] });
  });

  it("rejects an actor outside the project's org", async () => {
    const p = new RoutesPool();
    seedProject(p, "project_a", "org_a");
    await expect(tanrenReadInsights({ pool: pool(p) }, { projectId: "project_a" }, stranger)).rejects.toBeInstanceOf(
      ToolAccessDeniedError,
    );
  });
});

describe("tanrenReadMilestones", () => {
  it("returns an empty milestone list when no milestones exist", async () => {
    const p = new RoutesPool();
    seedProject(p, "project_a", "org_a");
    const result = await tanrenReadMilestones({ pool: pool(p) }, { projectId: "project_a" }, orgMember);
    expect(result).toEqual({ milestones: [] });
  });
});

describe("tanrenReadRun authz", () => {
  it("404-equivalent throw when run does not exist", async () => {
    const p = new RoutesPool();
    seedProject(p, "project_a", "org_a");
    await expect(tanrenReadRun({ pool: pool(p) }, { runId: "run_missing" }, orgMember)).rejects.toBeInstanceOf(
      ToolAccessDeniedError,
    );
  });
});

describe("tanrenAcknowledgeInsight stub", () => {
  it("records the ack with the actor's userId", async () => {
    const p = new RoutesPool();
    const result = await tanrenAcknowledgeInsight({ pool: pool(p) }, { insightId: "insight_42" }, orgMember);
    expect(result.insightId).toBe("insight_42");
    expect(result.acknowledgedBy).toBe("user_m");
    expect(peekAcknowledgedInsightForTests("insight_42")?.acknowledgedBy).toBe("user_m");
  });
});

describe("tanrenTriggerRun authz", () => {
  it("propagates a not-found / access-denied error for an unreachable spec", async () => {
    // The trigger path runs through createQueuedRunFromSpec which loads
    // the spec inside a transaction. For a `stranger` actor we expect the
    // call to fail; the exact message comes from the underlying workflow
    // (`spec not found` here because the in-memory pool's transactional
    // SELECT shape returns nothing for the stranger's reachability check).
    // The product invariant is "stranger never gets a queued run".
    const p = new RoutesPool();
    seedProject(p, "project_a", "org_a");
    p.seedSpec({ spec_id: "spec_a", project_id: "project_a", status: "pending" });
    await expect(tanrenTriggerRun({ pool: pool(p) }, { specId: "spec_a" }, stranger)).rejects.toThrow(/spec|access/i);
  });
});
