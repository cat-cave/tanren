import { describe, expect, it, vi } from "vitest";
import { BehaviorCoverageClient } from "../src/api/behaviorCoverageClient.js";

const CONTENT_DIGEST = `sha256:${"a".repeat(64)}`;
const ANALYSIS_ID = `sha256:${"b".repeat(64)}`;
const HEAD_SHA = "c".repeat(40);
const MEMBER_KEY = "d".repeat(64);

const SELECTION = {
  version: "v1",
  analysisId: ANALYSIS_ID,
  orgId: "org_a",
  projectId: "project_a",
  binding: {
    integrationNodeId: "integration_node_a",
    baseSha: "0".repeat(40),
    preparedHeadSha: HEAD_SHA,
    treeHash: "tree_a",
    memberKey: MEMBER_KEY,
  },
  mode: "targeted",
  changedTargets: [{ kind: "source", targetRef: "src/login.ts" }],
  unknownTargets: [],
  selected: [
    {
      behaviorRevisionId: "behavior_revision_a",
      reasons: [
        {
          kind: "direct_edge",
          edgeId: "coverage_edge_a",
          target: { kind: "source", targetRef: "src/login.ts" },
        },
      ],
    },
  ],
  excluded: [],
} as const;

const OVERVIEW = {
  version: "v1",
  orgId: "org_a",
  projectId: "project_a",
  graph: {
    status: "available",
    behaviors: [
      {
        behaviorRevisionId: "behavior_revision_a",
        contentDigest: CONTENT_DIGEST,
        title: "login works",
        edges: [{ id: "coverage_edge_a", kind: "source", targetRef: "src/login.ts" }],
      },
    ],
    uncoveredBehaviorRevisionIds: [],
  },
  latestSelection: { status: "available", selection: SELECTION },
} as const;

function clientWith(body: unknown, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>(
    async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
  );
  return {
    client: new BehaviorCoverageClient({
      orchestratorUrl: "http://orchestrator",
      csrfToken: "csrf_a",
      fetchImpl,
    }),
    fetchImpl,
  };
}

describe("BehaviorCoverageClient strict boundary", () => {
  it("accepts only an exact, self-consistent org/project overview", async () => {
    const exact = clientWith(OVERVIEW);
    await expect(exact.client.getOverview("org_a", "project_a")).resolves.toEqual(OVERVIEW);

    const extra = clientWith({ ...OVERVIEW, inventedCount: 12 });
    await expect(extra.client.getOverview("org_a", "project_a")).resolves.toBeUndefined();

    const wrongScope = clientWith({ ...OVERVIEW, orgId: "org_b" });
    await expect(wrongScope.client.getOverview("org_a", "project_a")).resolves.toBeUndefined();
  });

  it("rejects inconsistent graph and latest-selection claims", async () => {
    const wrongUncovered = clientWith({
      ...OVERVIEW,
      graph: { ...OVERVIEW.graph, uncoveredBehaviorRevisionIds: ["behavior_revision_a"] },
    });
    await expect(wrongUncovered.client.getOverview("org_a", "project_a")).resolves.toBeUndefined();

    const wrongSelectionScope = clientWith({
      ...OVERVIEW,
      latestSelection: {
        status: "available",
        selection: { ...SELECTION, projectId: "project_b" },
      },
    });
    await expect(wrongSelectionScope.client.getOverview("org_a", "project_a")).resolves.toBeUndefined();
  });

  it("rejects contradictory modes, widening reasons, and edge identities", async () => {
    const contradictions = [
      {
        ...SELECTION,
        mode: "targeted",
        selected: [{ behaviorRevisionId: "behavior_revision_a", reasons: [{ kind: "uncovered_behavior" }] }],
      },
      {
        ...SELECTION,
        mode: "expanded_unknown",
        excluded: [
          { behaviorRevisionId: "other", reason: "no_reachable_changed_target", inspectedEdgeIds: ["edge-other"] },
        ],
      },
      { ...SELECTION, mode: "expanded_unknown" },
      {
        ...SELECTION,
        selected: [
          {
            behaviorRevisionId: "behavior_revision_a",
            reasons: [
              {
                kind: "direct_edge",
                edgeId: "coverage_edge_a",
                target: { kind: "source", targetRef: "src/other.ts" },
              },
            ],
          },
        ],
      },
      {
        ...SELECTION,
        changedTargets: [
          { kind: "source", targetRef: "src/login.ts" },
          { kind: "source", targetRef: "src/other.ts" },
        ],
        selected: [
          {
            behaviorRevisionId: "behavior_revision_a",
            reasons: [
              ...SELECTION.selected[0].reasons,
              {
                kind: "direct_edge",
                edgeId: "coverage_edge_a",
                target: { kind: "source", targetRef: "src/other.ts" },
              },
            ],
          },
        ],
      },
      { ...SELECTION, mode: "no_active_behaviors", selected: [], excluded: [], unknownTargets: [] },
    ];
    for (const selection of contradictions) {
      const client = clientWith({ ...OVERVIEW, latestSelection: { status: "available", selection } });
      await expect(client.client.getOverview("org_a", "project_a")).resolves.toBeUndefined();
    }
  });

  it("posts the exact integration-node binding and target with CSRF", async () => {
    const { client, fetchImpl } = clientWith({ selection: SELECTION }, 201);
    const result = await client.analyze("org_a", "project_a", {
      integrationNodeId: "integration_node_a",
      target: { kind: "source", targetRef: "src/login.ts" },
    });

    expect(result).toEqual({ ok: true, status: 201, selection: SELECTION });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    if (init === undefined) throw new Error("affected-selection request init missing");
    expect(String(url)).toBe("http://orchestrator/orgs/org_a/projects/project_a/behavior-coverage/affected-selection");
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf_a");
    expect(JSON.parse(String(init.body))).toEqual({
      integrationNodeId: "integration_node_a",
      targets: [{ kind: "source", targetRef: "src/login.ts" }],
    });
  });

  it("withholds malformed, cross-project, or non-created selections", async () => {
    const malformed = clientWith(
      { selection: { ...SELECTION, binding: { ...SELECTION.binding, preparedHeadSha: "bad" } } },
      201,
    );
    await expect(
      malformed.client.analyze("org_a", "project_a", {
        integrationNodeId: "integration_node_a",
        target: { kind: "source", targetRef: "x" },
      }),
    ).resolves.toEqual({ ok: false, status: 502 });

    const wrongProject = clientWith({ selection: { ...SELECTION, projectId: "project_b" } }, 201);
    await expect(
      wrongProject.client.analyze("org_a", "project_a", {
        integrationNodeId: "integration_node_a",
        target: { kind: "source", targetRef: "x" },
      }),
    ).resolves.toEqual({ ok: false, status: 502 });

    const wrongBinding = clientWith(
      { selection: { ...SELECTION, binding: { ...SELECTION.binding, integrationNodeId: "integration_node_b" } } },
      201,
    );
    await expect(
      wrongBinding.client.analyze("org_a", "project_a", {
        integrationNodeId: "integration_node_a",
        target: { kind: "source", targetRef: "src/login.ts" },
      }),
    ).resolves.toEqual({ ok: false, status: 502 });

    const notCreated = clientWith({ selection: SELECTION }, 200);
    await expect(
      notCreated.client.analyze("org_a", "project_a", {
        integrationNodeId: "integration_node_a",
        target: { kind: "source", targetRef: "x" },
      }),
    ).resolves.toEqual({ ok: false, status: 200 });
  });

  it("distinguishes current and stale replay using exact statuses and identities", async () => {
    const current = clientWith({ verification: { status: "current", analysisId: ANALYSIS_ID } }, 200);
    await expect(current.client.verify("org_a", "project_a", ANALYSIS_ID)).resolves.toEqual({
      ok: true,
      status: 200,
      verification: { status: "current", analysisId: ANALYSIS_ID },
    });

    const stale = clientWith({ verification: { status: "stale", analysisId: ANALYSIS_ID } }, 409);
    await expect(stale.client.verify("org_a", "project_a", ANALYSIS_ID)).resolves.toEqual({
      ok: false,
      status: 409,
      verification: { status: "stale", analysisId: ANALYSIS_ID },
    });

    const mismatched = clientWith({ verification: { status: "current", analysisId: CONTENT_DIGEST } }, 200);
    await expect(mismatched.client.verify("org_a", "project_a", ANALYSIS_ID)).resolves.toEqual({
      ok: false,
      status: 502,
    });

    const contradictory = clientWith({ verification: { status: "stale", analysisId: ANALYSIS_ID } }, 200);
    await expect(contradictory.client.verify("org_a", "project_a", ANALYSIS_ID)).resolves.toEqual({
      ok: false,
      status: 502,
    });
  });
});
