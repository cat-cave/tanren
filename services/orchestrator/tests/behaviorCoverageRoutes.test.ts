import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import type { BehaviorCoverageEdgeId } from "../src/engine/contracts/runtimeVerification.js";
import type { BehaviorCoverageEdgesRepository } from "../src/engine/repositories/behaviorCoverageEdges.js";
import type { BehaviorCoverageSnapshot } from "../src/engine/runtimeVerification/affectedSelection.js";
import {
  EventAffectedSelectionFactWriter,
  type AffectedSelectionFactWriter,
} from "../src/engine/runtimeVerification/affectedSelectionFacts.js";
import type { EventStore } from "../src/engine/eventStore.js";
import { EventRegistry } from "../src/engine/events/index.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createBehaviorCoverageRoutes } from "../src/routes/behaviorCoverage/index.js";

const ADMIN: ActorContext = {
  userId: "admin",
  orgId: "org-a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const MEMBER: ActorContext = {
  userId: "member",
  orgId: "org-a",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

const SNAPSHOT: BehaviorCoverageSnapshot = {
  orgId: "org-a",
  projectId: "project-a",
  behaviors: [
    {
      behaviorRevisionId: "br-a" as BehaviorRevisionId,
      title: "behavior a",
      edges: [{ id: "edge-a" as BehaviorCoverageEdgeId, kind: "source", targetRef: "src/a.ts" }],
    },
    { behaviorRevisionId: "br-b" as BehaviorRevisionId, title: "behavior b", edges: [] },
  ],
};

class RecordingFacts implements AffectedSelectionFactWriter {
  readonly records: unknown[] = [];
  fail = false;

  async record(selection: unknown): Promise<void> {
    if (this.fail) throw new Error("fact store unavailable");
    this.records.push(selection);
  }
}

function buildHarness(options?: {
  actor?: ActorContext;
  projectOrgId?: string | null;
  snapshot?: BehaviorCoverageSnapshot;
}) {
  const actor = options?.actor ?? ADMIN;
  const projectOrgId = options?.projectOrgId === undefined ? "org-a" : options.projectOrgId;
  const pool = {
    query: vi.fn<(sql: string) => Promise<{ rows: unknown[]; rowCount: number }>>(async (sql: string) => {
      if (sql.includes("SELECT org_id FROM projects")) {
        return {
          rows: projectOrgId === null ? [] : [{ org_id: projectOrgId }],
          rowCount: projectOrgId === null ? 0 : 1,
        };
      }
      if (sql.includes("SELECT role FROM project_members")) {
        return { rows: [{ role: "member" }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }),
  } as unknown as pg.Pool;
  const repository: BehaviorCoverageEdgesRepository = {
    record: vi.fn<BehaviorCoverageEdgesRepository["record"]>(async (_client, _scope, input) => ({
      id: "edge-new" as BehaviorCoverageEdgeId,
      kind: input.kind,
      targetRef: input.targetRef,
    })),
    readSnapshot: vi.fn<BehaviorCoverageEdgesRepository["readSnapshot"]>(async () => options?.snapshot ?? SNAPSHOT),
  };
  const facts = new RecordingFacts();
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route("/orgs", createBehaviorCoverageRoutes({ pool, repository, facts }));
  return { app, repository, facts };
}

describe("behavior coverage HTTP surface", () => {
  it("returns the active graph and explicitly marks uncovered behavior revisions", async () => {
    const { app } = buildHarness();
    const response = await app.request("/orgs/org-a/projects/project-a/behavior-coverage");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: "v1",
      orgId: "org-a",
      projectId: "project-a",
      uncoveredBehaviorRevisionIds: ["br-b"],
    });
  });

  it("binds project authorization to the path org, including for platform admins", async () => {
    const { app, repository } = buildHarness({ projectOrgId: "org-b" });
    const response = await app.request("/orgs/org-a/projects/project-a/behavior-coverage");

    expect(response.status).toBe(403);
    expect(repository.readSnapshot).not.toHaveBeenCalled();
  });

  it("requires org admin for edge writes and rejects extra body fields", async () => {
    const memberHarness = buildHarness({ actor: MEMBER });
    const denied = await memberHarness.app.request("/orgs/org-a/projects/project-a/behavior-coverage/edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ behaviorRevisionId: "br-a", edgeKind: "source", targetRef: "src/a.ts" }),
    });
    expect(denied.status).toBe(403);

    const adminHarness = buildHarness();
    const malformed = await adminHarness.app.request("/orgs/org-a/projects/project-a/behavior-coverage/edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        behaviorRevisionId: "br-a",
        edgeKind: "source",
        targetRef: "src/a.ts",
        metadata: { shortcut: true },
      }),
    });
    expect(malformed.status).toBe(400);
    expect(adminHarness.repository.record).not.toHaveBeenCalled();
  });

  it("persists the exact selection fact before returning it", async () => {
    const { app, facts } = buildHarness();
    const response = await app.request("/orgs/org-a/projects/project-a/behavior-coverage/affected-selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{ kind: "source", targetRef: "src/a.ts" }] }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as { selection: unknown };
    expect(facts.records).toEqual([body.selection]);
    expect(body.selection).toMatchObject({
      mode: "expanded_unknown",
      selected: [
        { behaviorRevisionId: "br-a" },
        { behaviorRevisionId: "br-b", reasons: [{ kind: "uncovered_behavior" }] },
      ],
    });
  });

  it("withholds an otherwise valid selection when its durable fact cannot append", async () => {
    const { app, facts } = buildHarness();
    facts.fail = true;
    const response = await app.request("/orgs/org-a/projects/project-a/behavior-coverage/affected-selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{ kind: "source", targetRef: "src/a.ts" }] }),
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "affected_selection_unavailable" });
  });

  it("strictly rejects dependency as an external changed-target kind", async () => {
    const { app, facts } = buildHarness();
    const response = await app.request("/orgs/org-a/projects/project-a/behavior-coverage/affected-selection", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [{ kind: "dependency", targetRef: "br-a" }] }),
    });

    expect(response.status).toBe(400);
    expect(facts.records).toEqual([]);
  });
});

describe("canonical affected-selection event adapter", () => {
  it("appends the full exact selection with org/project on the event row", async () => {
    const append = vi.fn<EventStore["append"]>(async () => {});
    const writer = new EventAffectedSelectionFactWriter({ append } as unknown as EventStore);
    const selection = {
      version: "v1" as const,
      analysisId: "coverage_selection_adapter",
      orgId: "org-a",
      projectId: "project-a",
      mode: "targeted" as const,
      changedTargets: [{ kind: "source" as const, targetRef: "src/a.ts" }],
      unknownTargets: [],
      selected: [
        {
          behaviorRevisionId: "br-a" as BehaviorRevisionId,
          reasons: [
            {
              kind: "direct_edge" as const,
              edgeId: "edge-a" as BehaviorCoverageEdgeId,
              target: { kind: "source" as const, targetRef: "src/a.ts" },
            },
          ],
        },
      ],
      excluded: [
        {
          behaviorRevisionId: "br-b" as BehaviorRevisionId,
          reason: "no_reachable_changed_target" as const,
          inspectedEdgeIds: ["edge-b" as BehaviorCoverageEdgeId],
        },
      ],
    };

    await writer.record(selection, { runId: "run-a", specId: "spec-a" });

    expect(append).toHaveBeenCalledWith({
      orgId: "org-a",
      projectId: "project-a",
      runId: "run-a",
      specId: "spec-a",
      eventType: "behavior.coverage.selection_analyzed",
      payload: {
        version: "v1",
        analysisId: "coverage_selection_adapter",
        mode: "targeted",
        changedTargets: [{ kind: "source", targetRef: "src/a.ts" }],
        unknownTargets: [],
        selected: selection.selected,
        excluded: selection.excluded,
      },
    });
    expect(() =>
      EventRegistry["behavior.coverage.selection_analyzed"].parse(append.mock.calls[0]?.[0]?.payload),
    ).not.toThrow();
  });

  it("strictly rejects a selection event payload carrying duplicate org scope", () => {
    expect(() =>
      EventRegistry["behavior.coverage.selection_analyzed"].parse({
        version: "v1",
        analysisId: "a",
        mode: "targeted",
        changedTargets: [],
        unknownTargets: [],
        selected: [],
        excluded: [],
        orgId: "must-live-on-event-row",
      }),
    ).toThrow(/unrecognized|key/iu);
  });
});
