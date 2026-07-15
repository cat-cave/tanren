import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};
const PROJECTS = [
  {
    projectId: "project_easy",
    name: "tanren-fixture-easy",
    repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
    defaultBranch: "main",
    runnerImage: null,
    allocator: "local_docker",
  },
];

const IDENTITY = {
  missionNodeId: "mq-1",
  evaluationId: "evaluation-17",
  groupId: "group-9",
  signalVersion: "merge_signal.v1",
} as const;

const POLICY_PROJECTION = {
  evaluationId: "evaluation-17",
  signals: [
    {
      eventId: "42",
      observedAt: "2026-07-15T12:00:00.000Z",
      signal: {
        ...IDENTITY,
        sourceEventId: "event-41",
        memberIds: ["C"],
        findingIds: ["finding-p1"],
        classification: "deterministic_policy",
        reasonCode: "audit_policy",
        retryability: "non_retryable",
        wakeKey: null,
        repairRoute: "respec",
      },
    },
  ],
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

let projection: unknown = POLICY_PROJECTION;
let signalReads = 0;

function mockOrchestrator(): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    }
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (/\/merge-queue\/evaluations\/.+\/signals$/u.test(url)) {
      signalReads += 1;
      return projection === undefined
        ? new Response(JSON.stringify({ error: "merge_queue_evaluation_not_found" }), { status: 404 })
        : new Response(JSON.stringify(projection), { status: 200 });
    }
    if (/\/(integration-metrics|queue-stats)(\?|$)/u.test(url)) return new Response("unavailable", { status: 500 });
    if (url.includes("/projects")) return new Response(JSON.stringify({ projects: PROJECTS }), { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
  projection = POLICY_PROJECTION;
  signalReads = 0;
  mockOrchestrator();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function render(path: string): Promise<string> {
  const app = await createApp({ pool: stubPool(), skipMigrate: true });
  return await (await app.request(path)).text();
}

describe("mq-1 authority-signal panel", () => {
  it("renders the durable member-C policy proof and preserves the evaluation in window links", async () => {
    const html = await render("/merge-queue?evaluationId=evaluation-17");

    expect(html).toContain("authority signal classification");
    expect(html).toContain("policy block · member-local");
    expect(html).toContain("members · <b>C</b>");
    expect(html).toContain("findings · <b>finding-p1</b>");
    expect(html).toContain("source event · event-41");
    expect(html).not.toContain("infrastructure signal");
    expect(html).toContain("windowDays=7&amp;evaluationId=evaluation-17");
  });

  it("visibly distinguishes infrastructure, product-decision, and unknown fail-closed states", async () => {
    projection = {
      evaluationId: "evaluation-17",
      signals: [
        {
          eventId: "50",
          observedAt: "2026-07-15T12:01:00.000Z",
          signal: {
            ...IDENTITY,
            memberIds: [],
            findingIds: [],
            classification: "transient_infrastructure",
            reasonCode: "provider_timeout",
            retryability: "retryable",
            wakeKey: "provider:openai:available",
            repairRoute: null,
          },
        },
        {
          eventId: "51",
          observedAt: "2026-07-15T12:02:00.000Z",
          signal: {
            ...IDENTITY,
            memberIds: ["B"],
            findingIds: [],
            classification: "needs_product_decision",
            reasonCode: "hitl_pending",
            retryability: "non_retryable",
            wakeKey: "review:decision",
            repairRoute: null,
          },
        },
        {
          eventId: "52",
          observedAt: "2026-07-15T12:03:00.000Z",
          signal: {
            ...IDENTITY,
            memberIds: [],
            findingIds: [],
            classification: "unknown_fail_closed",
            reasonCode: "untyped_error",
            retryability: "unknown",
            wakeKey: null,
            repairRoute: null,
          },
        },
      ],
    };

    const html = await render("/merge-queue?evaluationId=evaluation-17");
    expect(html).toContain("infrastructure signal");
    expect(html).toContain("product decision required");
    expect(html).toContain("unknown · fail closed");
    expect(html).toContain("reason · provider_timeout");
  });

  it("renders absence as unclassified and does not invent a signal read", async () => {
    const html = await render("/merge-queue");

    expect(html).toContain("No evaluation selected");
    expect(html).toContain("never treated as healthy or transient");
    expect(signalReads).toBe(0);
  });

  it("renders a missing projection as unknown and fail-closed", async () => {
    projection = undefined;
    const html = await render("/merge-queue?evaluationId=evaluation-missing");

    expect(html).toContain("No classified signal is visible for evaluation");
    expect(html).toContain("unknown and fail-closed");
    expect(signalReads).toBe(1);
  });
});
