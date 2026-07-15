import { describe, expect, it, vi } from "vitest";
import { BehaviorCoverageClient } from "../src/api/behaviorCoverageClient.js";

const SNAPSHOT = {
  version: "v1",
  orgId: "org_a",
  projectId: "project_a",
  behaviors: [
    {
      behaviorRevisionId: "behavior_revision_a",
      title: "login works",
      edges: [{ id: "coverage_edge_a", kind: "source", targetRef: "src/login.ts" }],
    },
  ],
  uncoveredBehaviorRevisionIds: [],
};

const SELECTION = {
  version: "v1",
  analysisId: "coverage_selection_a",
  orgId: "org_a",
  projectId: "project_a",
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
};

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
  it("accepts an exact org/project coverage snapshot", async () => {
    const { client } = clientWith(SNAPSHOT);
    await expect(client.getSnapshot("org_a", "project_a")).resolves.toEqual(SNAPSHOT);
  });

  it("rejects extra fields and mismatched scope instead of trusting JSON casts", async () => {
    const extra = clientWith({ ...SNAPSHOT, inventedCount: 12 });
    await expect(extra.client.getSnapshot("org_a", "project_a")).resolves.toBeUndefined();

    const wrongScope = clientWith({ ...SNAPSHOT, orgId: "org_b" });
    await expect(wrongScope.client.getSnapshot("org_a", "project_a")).resolves.toBeUndefined();
  });

  it("posts one changed target with CSRF and accepts only the canonical selection", async () => {
    const { client, fetchImpl } = clientWith({ selection: SELECTION }, 201);
    const result = await client.analyze("org_a", "project_a", {
      kind: "source",
      targetRef: "src/login.ts",
    });

    expect(result).toEqual({ ok: true, status: 201, selection: SELECTION });
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    if (init === undefined) throw new Error("affected-selection request init missing");
    expect(String(url)).toBe("http://orchestrator/orgs/org_a/projects/project_a/behavior-coverage/affected-selection");
    expect((init.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf_a");
    expect(JSON.parse(String(init.body))).toEqual({ targets: [{ kind: "source", targetRef: "src/login.ts" }] });
  });

  it("withholds malformed or cross-project selection responses", async () => {
    const malformed = clientWith({ selection: { ...SELECTION, selected: [{ behaviorRevisionId: "b", reasons: [] }] } });
    await expect(malformed.client.analyze("org_a", "project_a", { kind: "source", targetRef: "x" })).resolves.toEqual({
      ok: false,
      status: 502,
    });

    const wrongProject = clientWith({ selection: { ...SELECTION, projectId: "project_b" } });
    await expect(
      wrongProject.client.analyze("org_a", "project_a", { kind: "source", targetRef: "x" }),
    ).resolves.toEqual({ ok: false, status: 502 });
  });
});
