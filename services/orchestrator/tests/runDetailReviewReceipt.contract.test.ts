import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createRunRoutes } from "../src/routes/runs/index.js";
import { RunRoutesPool } from "./helpers/runRoutesPool.js";

const actor: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

function harness() {
  const pool = new RunRoutesPool();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return actor;
        },
      } as never,
      localDevActor: actor,
    }),
  );
  app.route("/orgs", createRunRoutes({ pool: pool.asPgPool() }));
  pool.seedProject({ project_id: "project_gv2", org_id: "org_acme" });
  pool.seedSpec({ spec_id: "spec_gv2", project_id: "project_gv2", title: "Strict review" });
  pool.seedRun({ run_id: "run_gv2", spec_id: "spec_gv2", project_id: "project_gv2" });
  pool.seedEvent({
    id: 42,
    run_id: "run_gv2",
    spec_id: "spec_gv2",
    project_id: "project_gv2",
    event_type: "review.approved",
    payload: {
      prUrl: "https://github.com/o/r/pull/7",
      prNumber: 7,
      reviewer: "tanren-reviewer[bot]",
      forgeReviewId: "9001",
      forgeReviewState: "approved",
      forgeReviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-9001",
      headSha: "a".repeat(40),
    },
  });
  return { app };
}

describe("gv-2 run-detail review receipt HTTP contract", () => {
  it("GET events and run detail preserve the public receipt without redaction", async () => {
    const { app } = harness();
    const path = "/orgs/org_acme/projects/project_gv2/runs/run_gv2";
    const eventsResponse = await app.request(`${path}/events`);
    expect(eventsResponse.status).toBe(200);
    const events = (await eventsResponse.json()) as {
      items: Array<{ eventType: string; payload: Record<string, unknown>; redactedPaths: string[] }>;
    };
    const receipt = events.items.find((event) => event.eventType === "review.approved");
    expect(receipt?.payload).toMatchObject({
      forgeReviewId: "9001",
      forgeReviewState: "approved",
      forgeReviewUrl: "https://github.com/o/r/pull/7#pullrequestreview-9001",
      headSha: "a".repeat(40),
      reviewer: "tanren-reviewer[bot]",
    });
    expect(receipt?.redactedPaths).not.toEqual(
      expect.arrayContaining(["forgeReviewId", "forgeReviewState", "forgeReviewUrl", "headSha", "reviewer"]),
    );

    const detailResponse = await app.request(path);
    expect(detailResponse.status).toBe(200);
    const detail = (await detailResponse.json()) as {
      recentEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
    };
    expect(detail.recentEvents.find((event) => event.eventType === "review.approved")?.payload).toMatchObject(
      receipt?.payload ?? {},
    );
  });

  it("rejects an actor-org mismatch before exposing the receipt", async () => {
    const { app } = harness();
    const response = await app.request("/orgs/org_other/projects/project_gv2/runs/run_gv2/events");
    expect(response.status).toBe(403);
  });
});
