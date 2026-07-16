import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import {
  contentDigestOf,
  parseDigest,
  type CasArtifactBytes,
  type CasArtifactRef,
  type CasByteStore,
  type Digest,
} from "../src/engine/contracts/cas.js";
import type { BehaviorCoverageEdgeId } from "../src/engine/contracts/runtimeVerification.js";
import type { EventStore } from "../src/engine/eventStore.js";
import type {
  AffectedSelectionFactRepository,
  PersistedAffectedSelection,
} from "../src/engine/repositories/affectedSelectionFacts.js";
import type { BehaviorCoverageEdgesRepository } from "../src/engine/repositories/behaviorCoverageEdges.js";
import { CoverageIntegrationNodeUnavailableError } from "../src/engine/repositories/behaviorCoverageEdges.js";
import type { BoundBehaviorCoverageSnapshot } from "../src/engine/runtimeVerification/affectedSelection.js";
import {
  AFFECTED_SELECTION_FACT_MEDIA_TYPE,
  decodeAffectedSelectionFact,
  selectionFromFact,
} from "../src/engine/runtimeVerification/affectedSelectionFacts.js";
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
const HEAD = "a".repeat(40);
const MEMBER_KEY = "b".repeat(64);
const REVISION_DIGEST = parseDigest(`sha256:${"c".repeat(64)}`);

function bound(): BoundBehaviorCoverageSnapshot {
  return {
    binding: { integrationNodeId: "node-a", preparedHeadSha: HEAD, treeHash: "tree-a", memberKey: MEMBER_KEY },
    snapshot: {
      orgId: "org-a",
      projectId: "project-a",
      behaviors: [
        {
          behaviorRevisionId: "br-a" as BehaviorRevisionId,
          contentDigest: REVISION_DIGEST,
          title: "behavior a",
          edges: [{ id: "edge-a" as BehaviorCoverageEdgeId, kind: "source", targetRef: "src/a.ts" }],
        },
        {
          behaviorRevisionId: "br-b" as BehaviorRevisionId,
          contentDigest: parseDigest(`sha256:${"d".repeat(64)}`),
          title: "behavior b",
          edges: [],
        },
      ],
    },
  };
}

class MemoryCas implements CasByteStore {
  readonly rows = new Map<Digest, CasArtifactBytes>();
  async put(input: { orgId: string; bytes: Uint8Array; mediaType: string }): Promise<CasArtifactRef> {
    const digest = contentDigestOf(input.bytes);
    this.rows.set(digest, { digest, bytes: input.bytes, mediaType: input.mediaType });
    return { digest, byteSize: input.bytes.byteLength, mediaType: input.mediaType };
  }
  async get(_orgId: string, digest: Digest): Promise<CasArtifactBytes> {
    const row = this.rows.get(digest);
    if (row === undefined) throw new Error("missing CAS fact");
    return row;
  }
  async has(_orgId: string, digest: Digest): Promise<boolean> {
    return this.rows.has(digest);
  }
}

function scopedPool(projectOrgId: string | null): pg.Pool {
  const client = {
    query: vi.fn<(sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>>(async (sql) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("SELECT org_id FROM projects")) {
        return {
          rows: projectOrgId === null ? [] : [{ org_id: projectOrgId }],
          rowCount: projectOrgId === null ? 0 : 1,
        };
      }
      if (sql.includes("SELECT role FROM project_members")) return { rows: [{ role: "member" }], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    release: vi.fn<() => void>(),
  };
  return { connect: vi.fn<() => Promise<typeof client>>(async () => client) } as unknown as pg.Pool;
}

function persistedFromCas(cas: MemoryCas, analysisId: Digest): PersistedAffectedSelection {
  const artifact = cas.rows.get(analysisId);
  if (artifact === undefined) throw new Error("CAS fact missing in harness");
  const fact = decodeAffectedSelectionFact(artifact.bytes);
  return { fact, selection: selectionFromFact(fact, analysisId) };
}

function buildHarness(options?: { actor?: ActorContext; projectOrgId?: string | null }) {
  const actor = options?.actor ?? ADMIN;
  const current = bound();
  let locked = current;
  let latest: PersistedAffectedSelection | undefined;
  let graphFailure = false;
  let appendFailure = false;
  let bindingUnavailable = false;
  const cas = new MemoryCas();
  const append = vi.fn<EventStore["append"]>(async () => {
    if (appendFailure) throw new Error("event append failed");
  });
  const repository: BehaviorCoverageEdgesRepository = {
    record: vi.fn<BehaviorCoverageEdgesRepository["record"]>(async (_client, _scope, input) => ({
      id: "edge-new" as BehaviorCoverageEdgeId,
      kind: input.kind,
      targetRef: input.targetRef,
    })),
    readSnapshot: vi.fn<BehaviorCoverageEdgesRepository["readSnapshot"]>(async () => {
      if (graphFailure) throw new Error("graph read failed");
      return current.snapshot;
    }),
    readBoundSnapshot: vi.fn<BehaviorCoverageEdgesRepository["readBoundSnapshot"]>(async () => current),
    lockAndReadBoundSnapshot: vi.fn<BehaviorCoverageEdgesRepository["lockAndReadBoundSnapshot"]>(async () => {
      if (bindingUnavailable) throw new CoverageIntegrationNodeUnavailableError("integration node unavailable");
      return locked;
    }),
  };
  const facts: AffectedSelectionFactRepository = {
    read: vi.fn<AffectedSelectionFactRepository["read"]>(async (_client, _cas, _scope, analysisId) =>
      persistedFromCas(cas, analysisId),
    ),
    readLatest: vi.fn<AffectedSelectionFactRepository["readLatest"]>(async () => latest),
  };
  const pool = scopedPool(options?.projectOrgId === undefined ? "org-a" : options.projectOrgId);
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor);
    await next();
  });
  app.route(
    "/orgs",
    createBehaviorCoverageRoutes({
      pool,
      cas,
      repository,
      facts,
      eventsForClient: () => ({ append }),
    }),
  );
  return {
    app,
    cas,
    append,
    repository,
    setLocked(value: BoundBehaviorCoverageSnapshot) {
      locked = value;
    },
    setLatest(value: PersistedAffectedSelection | undefined) {
      latest = value;
    },
    failGraph() {
      graphFailure = true;
    },
    failAppend() {
      appendFailure = true;
    },
    makeBindingUnavailable() {
      bindingUnavailable = true;
    },
  };
}

async function analyze(harness: ReturnType<typeof buildHarness>) {
  return harness.app.request("/orgs/org-a/projects/project-a/behavior-coverage/affected-selection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ integrationNodeId: "node-a", targets: [{ kind: "source", targetRef: "src/a.ts" }] }),
  });
}

describe("behavior coverage HTTP surface", () => {
  it("keeps graph unavailability distinct from latest durable evidence", async () => {
    const harness = buildHarness();
    const created = await analyze(harness);
    const body = (await created.json()) as { selection: { analysisId: Digest } };
    harness.setLatest(persistedFromCas(harness.cas, body.selection.analysisId));
    harness.failGraph();
    const response = await harness.app.request("/orgs/org-a/projects/project-a/behavior-coverage");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      graph: { status: "unavailable" },
      latestSelection: { status: "available", selection: { analysisId: body.selection.analysisId } },
    });
  });

  it("binds project authorization to the path org even for platform admins", async () => {
    const harness = buildHarness({ projectOrgId: "org-b" });
    const response = await harness.app.request("/orgs/org-a/projects/project-a/behavior-coverage");
    expect(response.status).toBe(403);
    expect(harness.repository.readSnapshot).not.toHaveBeenCalled();
  });

  it("requires org admin for edge writes and rejects extra fields", async () => {
    const member = buildHarness({ actor: MEMBER });
    const denied = await member.app.request("/orgs/org-a/projects/project-a/behavior-coverage/edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ behaviorRevisionId: "br-a", edgeKind: "source", targetRef: "src/a.ts" }),
    });
    expect(denied.status).toBe(403);

    const admin = buildHarness();
    const malformed = await admin.app.request("/orgs/org-a/projects/project-a/behavior-coverage/edges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ behaviorRevisionId: "br-a", edgeKind: "source", targetRef: "src/a.ts", metadata: {} }),
    });
    expect(malformed.status).toBe(400);
    expect(admin.repository.record).not.toHaveBeenCalled();
  });

  it("persists CAS, locked-rechecks, then appends W0 before returning 201", async () => {
    const harness = buildHarness();
    const response = await analyze(harness);
    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      selection: { analysisId: Digest; binding: unknown; selected: unknown[] };
    };
    expect(body.selection.analysisId).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(body.selection.binding).toEqual(bound().binding);
    expect(body.selection.selected).toHaveLength(2);
    expect(harness.cas.rows.get(body.selection.analysisId)?.mediaType).toBe(AFFECTED_SELECTION_FACT_MEDIA_TYPE);
    expect(harness.repository.lockAndReadBoundSnapshot).toHaveBeenCalled();
    expect(harness.append).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org-a",
        projectId: "project-a",
        eventType: "behavior.coverage.selection_analyzed",
        payload: expect.objectContaining({ analysisId: body.selection.analysisId }),
      }),
    );
  });

  it("withholds 2xx when event append fails and when graph changes during publication", async () => {
    const appendFailure = buildHarness();
    appendFailure.failAppend();
    expect((await analyze(appendFailure)).status).toBe(503);

    const concurrent = buildHarness();
    concurrent.setLocked({ ...bound(), binding: { ...bound().binding, preparedHeadSha: "e".repeat(40) } });
    const stale = await analyze(concurrent);
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "affected_selection_stale_during_publication" });
    expect(concurrent.append).not.toHaveBeenCalled();

    const missingNode = buildHarness();
    missingNode.makeBindingUnavailable();
    expect((await analyze(missingNode)).status).toBe(409);
    expect(missingNode.append).not.toHaveBeenCalled();
  });

  it("strictly rejects dependency as a changed target and requires an integration node", async () => {
    const harness = buildHarness();
    for (const body of [
      { integrationNodeId: "node-a", targets: [{ kind: "dependency", targetRef: "br-a" }] },
      { targets: [{ kind: "source", targetRef: "src/a.ts" }] },
    ]) {
      const response = await harness.app.request(
        "/orgs/org-a/projects/project-a/behavior-coverage/affected-selection",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      );
      expect(response.status).toBe(400);
    }
    expect(harness.append).not.toHaveBeenCalled();
  });

  it("retrieves the exact CAS fact and reports node/head mutations stale", async () => {
    const harness = buildHarness();
    const created = (await (await analyze(harness)).json()) as { selection: { analysisId: Digest } };
    const id = encodeURIComponent(created.selection.analysisId);
    const exact = await harness.app.request(
      `/orgs/org-a/projects/project-a/behavior-coverage/affected-selections/${id}`,
    );
    expect(exact.status).toBe(200);

    const current = await harness.app.request(
      `/orgs/org-a/projects/project-a/behavior-coverage/affected-selections/${id}/verify`,
      { method: "POST" },
    );
    expect(current.status).toBe(200);
    harness.setLocked({ ...bound(), binding: { ...bound().binding, treeHash: "tree-mutated" } });
    const stale = await harness.app.request(
      `/orgs/org-a/projects/project-a/behavior-coverage/affected-selections/${id}/verify`,
      { method: "POST" },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({ verification: { status: "stale" } });

    harness.makeBindingUnavailable();
    const missingNode = await harness.app.request(
      `/orgs/org-a/projects/project-a/behavior-coverage/affected-selections/${id}/verify`,
      { method: "POST" },
    );
    expect(missingNode.status).toBe(409);
    await expect(missingNode.json()).resolves.toMatchObject({ verification: { status: "stale" } });
  });
});
