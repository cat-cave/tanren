import { describe, expect, it } from "vitest";
import { AllowAllPeerVerifier, DenyAllPeerVerifier } from "../src/engine/contracts/index.js";
import { createInternalAcceptanceRunRoutes } from "../src/routes/internal/acceptanceRuns.js";

const FAKE_POOL = {} as never;
const ARTIFACT = `sha256:${"a".repeat(64)}`;

function post(app: ReturnType<typeof createInternalAcceptanceRunRoutes>, body: unknown): Promise<Response> {
  return app.request(
    "/internal/acceptance-runs/execute",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { incoming: { socket: {} } },
  );
}

function validBody(operator: string): unknown {
  return {
    orgId: "org_1",
    projectId: "project_1",
    integrationNodeId: "inode_1",
    environmentId: "env_1",
    preparedHeadSha: "abc",
    jjTreeId: "tree",
    artifactDigest: ARTIFACT,
    deploymentFingerprint: "fp",
    plans: [
      {
        planId: "plan_1",
        behaviorRevisionId: "br_1",
        requiredSurfaces: ["browser"],
        assertions: [{ assertionId: "a1", subject: "status", comparisonOperator: operator, expected: 200 }],
      },
    ],
  };
}

describe("internal acceptance-run route — boundary validation", () => {
  it("rejects an untrusted (non-mTLS) caller with 401 before any work", async () => {
    const app = createInternalAcceptanceRunRoutes({ pool: FAKE_POOL, verifier: new DenyAllPeerVerifier() });
    const response = await post(app, validBody("equals"));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "untrusted_peer" });
  });

  it("rejects an UNKNOWN comparison operator with 400 (never silently deepEqual-ed)", async () => {
    const app = createInternalAcceptanceRunRoutes({ pool: FAKE_POOL, verifier: new AllowAllPeerVerifier() });
    const response = await post(app, validBody("not-a-real-operator"));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_acceptance_run");
  });
});
