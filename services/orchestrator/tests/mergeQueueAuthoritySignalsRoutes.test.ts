import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { MergeSignalClassifiedPayload } from "../src/engine/events/schemas/mergeQueueAuthoritySignals.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueAuthoritySignalRoutes } from "../src/routes/mergeQueue/authoritySignals.js";

const ORG = "org_acme";
const PROJECT = "project_tanren";
const EVALUATION = "evaluation-17";

const alice: ActorContext = {
  userId: "user_alice",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface StoredSignal {
  id: string;
  orgId: string;
  projectId: string;
  ts: Date;
  payload: MergeSignalClassifiedPayload;
}

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

class SignalProjectionPool {
  readonly scopeStatements: string[] = [];

  constructor(
    private readonly projectOrg: string | null,
    private readonly signals: StoredSignal[],
  ) {}

  asPgPool(): pg.Pool {
    return {
      connect: async () => {
        let scopedOrg: string | undefined;
        return {
          query: async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
            const text = sql.replaceAll(/\s+/gu, " ").trim();
            if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return rows([]);
            if (text.startsWith("SET LOCAL app.current_org_id")) {
              this.scopeStatements.push(text);
              scopedOrg = text.match(/= '([^']+)'$/u)?.[1];
              return rows([]);
            }
            if (text.startsWith("SELECT org_id FROM projects")) {
              if (this.projectOrg === null || this.projectOrg !== scopedOrg || params[0] !== PROJECT) return rows([]);
              return rows([{ org_id: this.projectOrg }]);
            }
            if (text.startsWith("SELECT role FROM project_members")) return rows([]);
            if (text.includes("FROM events") && text.includes("merge.signal.classified")) {
              const [projectId, orgId, evaluationId] = params as string[];
              return rows(
                this.signals
                  .filter(
                    (signal) =>
                      scopedOrg === signal.orgId &&
                      signal.projectId === projectId &&
                      signal.orgId === orgId &&
                      signal.payload.evaluationId === evaluationId,
                  )
                  .map((signal) => ({ event_id: signal.id, ts: signal.ts, payload: signal.payload })),
              );
            }
            throw new Error(`unexpected query: ${text}`);
          },
          release() {},
        };
      },
    } as unknown as pg.Pool;
  }
}

function rows(values: Record<string, unknown>[]): QueryResult {
  return { rows: values, rowCount: values.length };
}

function deterministicPolicySignal(): MergeSignalClassifiedPayload {
  return {
    missionNodeId: "mq-1",
    evaluationId: EVALUATION,
    groupId: "group-9",
    sourceEventId: "event-41",
    memberIds: ["C"],
    findingIds: ["finding-p1"],
    signalVersion: "merge_signal.v1",
    classification: "deterministic_policy",
    reasonCode: "audit_policy",
    retryability: "non_retryable",
    wakeKey: null,
    repairRoute: "respec",
  };
}

function buildApp(pool: pg.Pool, actor: ActorContext = alice) {
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
  app.route("/orgs", createMergeQueueAuthoritySignalRoutes({ pool }));
  return app;
}

function endpoint(evaluationId = EVALUATION): string {
  return `/orgs/${ORG}/projects/${PROJECT}/merge-queue/evaluations/${evaluationId}/signals`;
}

describe("mq-1 authority-signal HTTP projection", () => {
  it("returns the event-backed policy attribution and proves the org-scoped read", async () => {
    const pool = new SignalProjectionPool(ORG, [
      {
        id: "42",
        orgId: ORG,
        projectId: PROJECT,
        ts: new Date("2026-07-15T12:00:00.000Z"),
        payload: deterministicPolicySignal(),
      },
    ]);
    const response = await buildApp(pool.asPgPool()).request(endpoint());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      evaluationId: EVALUATION,
      signals: [
        {
          eventId: "42",
          observedAt: "2026-07-15T12:00:00.000Z",
          signal: deterministicPolicySignal(),
        },
      ],
    });
    expect(pool.scopeStatements).toEqual(["SET LOCAL app.current_org_id = 'org_acme'"]);
  });

  it("returns a typed infrastructure signal with no member attribution", async () => {
    const signal: MergeSignalClassifiedPayload = {
      missionNodeId: "mq-1",
      evaluationId: EVALUATION,
      groupId: "group-9",
      memberIds: [],
      findingIds: [],
      signalVersion: "merge_signal.v1",
      classification: "transient_infrastructure",
      reasonCode: "provider_timeout",
      retryability: "retryable",
      wakeKey: "provider:openai:available",
      repairRoute: null,
    };
    const pool = new SignalProjectionPool(ORG, [
      { id: "43", orgId: ORG, projectId: PROJECT, ts: new Date("2026-07-15T12:01:00.000Z"), payload: signal },
    ]);
    const response = await buildApp(pool.asPgPool()).request(endpoint());

    expect(response.status).toBe(200);
    const body = (await response.json()) as { signals: Array<{ signal: MergeSignalClassifiedPayload }> };
    expect(body.signals[0]?.signal).toMatchObject({
      classification: "transient_infrastructure",
      memberIds: [],
      findingIds: [],
    });
  });

  it("uses the same 404 for a missing evaluation and a cross-org actor", async () => {
    const pool = new SignalProjectionPool(ORG, []);
    const missing = await buildApp(pool.asPgPool()).request(endpoint("evaluation-missing"));
    const crossOrg = await buildApp(pool.asPgPool(), { ...alice, orgId: "org_other" }).request(endpoint());

    expect(missing.status).toBe(404);
    expect(crossOrg.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "merge_queue_evaluation_not_found" });
    expect(await crossOrg.json()).toEqual({ error: "merge_queue_evaluation_not_found" });
  });

  it("does not reveal a project or evaluation outside the transaction org", async () => {
    const pool = new SignalProjectionPool("org_other", [
      {
        id: "99",
        orgId: "org_other",
        projectId: PROJECT,
        ts: new Date("2026-07-15T12:02:00.000Z"),
        payload: deterministicPolicySignal(),
      },
    ]);
    const response = await buildApp(pool.asPgPool()).request(endpoint());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "merge_queue_evaluation_not_found" });
  });
});
