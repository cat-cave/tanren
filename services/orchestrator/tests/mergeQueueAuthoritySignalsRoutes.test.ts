import { Hono } from "hono";
import type pg from "pg";
// cspell:ignore mqeval mqgrp mqwake
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { MergeSignalClassificationV1 } from "../src/engine/merge/authoritySignalClassification.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createMergeQueueAuthoritySignalRoutes } from "../src/routes/mergeQueue/authoritySignals.js";

const ORG = "org_acme";
const PROJECT = "project_tanren";
const EVALUATION_A = `mqeval_${"a".repeat(64)}`;
const EVALUATION_B = `mqeval_${"b".repeat(64)}`;
const GROUP = `mqgrp_${"c".repeat(64)}`;

const alice: ActorContext = {
  userId: "user_alice",
  orgId: ORG,
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface StoredSignal {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly ts: Date;
  readonly payload: MergeSignalClassificationV1;
}

interface QueryResult {
  readonly rows: Record<string, unknown>[];
  readonly rowCount: number;
}

class SignalProjectionPool {
  readonly scopeStatements: string[] = [];
  readonly eventQueries: Array<{ sql: string; params: unknown[] }> = [];

  constructor(
    private readonly projectOrg: string | null,
    private readonly signals: ReadonlyArray<StoredSignal>,
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
              this.eventQueries.push({ sql: text, params });
              const projectId = params[0];
              const orgId = params[1];
              const visible = this.signals.filter(
                (signal) => scopedOrg === signal.orgId && signal.projectId === projectId && signal.orgId === orgId,
              );
              const selected = text.includes("payload->>'evaluationId'")
                ? visible
                    .filter((signal) => signal.payload.evaluationId === params[2])
                    .toSorted((left, right) => Number(left.id) - Number(right.id))
                : visible.toSorted((left, right) => Number(right.id) - Number(left.id)).slice(0, Number(params[2]));
              return rows(selected.map((signal) => ({ event_id: signal.id, ts: signal.ts, payload: signal.payload })));
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

function policySignal(evaluationId = EVALUATION_A): MergeSignalClassificationV1 {
  return {
    missionNodeId: "mq-1",
    evaluationId,
    groupId: GROUP,
    signalVersion: "merge_signal.v1",
    memberIds: ["C"],
    findingIds: ["finding-p1"],
    classification: "deterministic_policy",
    reasonCode: "audit_policy",
    retryability: "non_retryable",
    wakeKey: null,
    disposition: "member_repair",
  };
}

function infrastructureSignal(): MergeSignalClassificationV1 {
  return {
    missionNodeId: "mq-1",
    evaluationId: EVALUATION_B,
    groupId: GROUP,
    signalVersion: "merge_signal.v1",
    memberIds: [],
    findingIds: [],
    classification: "transient_infrastructure",
    reasonCode: "runner_unavailable",
    retryability: "retryable",
    wakeKey: `mqwake_${"d".repeat(64)}`,
    disposition: "retry_when_ready",
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

function listEndpoint(limit = 20): string {
  return `/orgs/${ORG}/projects/${PROJECT}/merge-queue/authority-signals?limit=${limit}`;
}

function evaluationEndpoint(evaluationId = EVALUATION_A): string {
  return `/orgs/${ORG}/projects/${PROJECT}/merge-queue/evaluations/${evaluationId}/signals`;
}

describe("mq-1 authority-signal HTTP projection", () => {
  it("discovers the latest signals without a caller-supplied evaluation ID", async () => {
    const pool = new SignalProjectionPool(ORG, [
      {
        id: "41",
        orgId: ORG,
        projectId: PROJECT,
        ts: new Date("2026-07-15T12:00:00.000Z"),
        payload: policySignal(),
      },
      {
        id: "42",
        orgId: ORG,
        projectId: PROJECT,
        ts: new Date("2026-07-15T12:01:00.000Z"),
        payload: infrastructureSignal(),
      },
    ]);

    const response = await buildApp(pool.asPgPool()).request(listEndpoint(1));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      latestEvaluationId: EVALUATION_B,
      signals: [
        {
          eventId: "42",
          observedAt: "2026-07-15T12:01:00.000Z",
          signal: infrastructureSignal(),
        },
      ],
    });
    expect(pool.eventQueries[0]?.params).toEqual([PROJECT, ORG, 1]);
    expect(pool.scopeStatements).toEqual(["SET LOCAL app.current_org_id = 'org_acme'"]);
  });

  it("returns the exact event-backed member attribution for a known evaluation", async () => {
    const pool = new SignalProjectionPool(ORG, [
      {
        id: "43",
        orgId: ORG,
        projectId: PROJECT,
        ts: new Date("2026-07-15T12:02:00.000Z"),
        payload: policySignal(),
      },
    ]);

    const response = await buildApp(pool.asPgPool()).request(evaluationEndpoint());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      evaluationId: EVALUATION_A,
      signals: [
        {
          eventId: "43",
          observedAt: "2026-07-15T12:02:00.000Z",
          signal: policySignal(),
        },
      ],
    });
  });

  it("returns an empty discoverable collection for an authorized project with no evidence", async () => {
    const response = await buildApp(new SignalProjectionPool(ORG, []).asPgPool()).request(listEndpoint());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ latestEvaluationId: null, signals: [] });
  });

  it("rejects invalid collection limits before querying the event projection", async () => {
    const pool = new SignalProjectionPool(ORG, []);
    const response = await buildApp(pool.asPgPool()).request(listEndpoint(101));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_limit", min: 1, max: 100 });
    expect(pool.eventQueries).toEqual([]);
  });

  it("uses the same 404 for a missing evaluation and a cross-org actor", async () => {
    const pool = new SignalProjectionPool(ORG, []);
    const missing = await buildApp(pool.asPgPool()).request(evaluationEndpoint());
    const crossOrg = await buildApp(pool.asPgPool(), { ...alice, orgId: "org_other" }).request(evaluationEndpoint());

    expect(missing.status).toBe(404);
    expect(crossOrg.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "merge_queue_evaluation_not_found" });
    expect(await crossOrg.json()).toEqual({ error: "merge_queue_evaluation_not_found" });
  });

  it("does not reveal a project whose transaction org does not match", async () => {
    const pool = new SignalProjectionPool("org_other", [
      {
        id: "99",
        orgId: "org_other",
        projectId: PROJECT,
        ts: new Date("2026-07-15T12:03:00.000Z"),
        payload: policySignal(),
      },
    ]);
    const response = await buildApp(pool.asPgPool()).request(listEndpoint());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "merge_queue_signals_not_found" });
    expect(pool.eventQueries).toEqual([]);
  });
});
