import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mountMergeQueueScreen } from "../src/routes/mergeQueue/index.js";

const ORG = { id: "org_mq12", kind: "github_org", login: "mq12", displayName: "MQ 12", role: "org:admin" };
const PROJECT = {
  projectId: "project_mq12",
  name: "evidence-app",
  repoUrl: "https://github.com/acme/evidence-app",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};
const NODE = "node_mq12";

function build(): Hono {
  const app = new Hono();
  mountMergeQueueScreen(app, { orchestratorUrl: "http://orchestrator" });
  return app;
}

describe("mq-12 merge-queue evidence route", () => {
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/auth/me")) return new Response(JSON.stringify({ csrfToken: "csrf_mq12" }));
      if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }));
      if (url.endsWith("/orgs/org_mq12/projects")) return new Response(JSON.stringify({ projects: [PROJECT] }));
      if (url.endsWith("/merge-queue/train")) {
        return new Response(JSON.stringify({ artifacts: [{ integrationNodeId: NODE }] }));
      }
      if (url.endsWith(`/merge-queue/evidence-contracts/${NODE}`)) {
        return new Response(
          JSON.stringify({
            resolutionStatus: "full_gate_fallback",
            contract: null,
            proofUnit: null,
            fallback: "selector_set_mismatch",
          }),
        );
      }
      return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("fetches evidence only for the latest sealed node and renders its fail-closed full-gate posture", async () => {
    const response = await build().request("/merge-queue?windowDays=90");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("full native pre-merge gate retained");
    expect(calls).toContain(
      "http://orchestrator/orgs/org_mq12/projects/project_mq12/merge-queue/evidence-contracts/node_mq12",
    );
  });
});
