// cspell:ignore headsha mainsha
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  MergeQueueTrainClient,
  type MergeTrainArtifact,
  type MergeTrainArtifactSummary,
  type MergeTrainListResponse,
} from "../src/api/mergeQueueTrain.js";
import { MergeTrainPanel } from "../src/components/mergeQueue/MergeTrainPanel.js";

const SHA = (c: string): string => `sha256:${c.repeat(64)}`;

const SUMMARY: MergeTrainArtifactSummary = {
  id: "mta-lg1",
  landGroupId: "lg1",
  authorityDecisionId: "decision-node1-headsha",
  integrationNodeId: "node1",
  proofRoot: SHA("a"),
  receiptMainSha: "mainsha1",
  deployDeploymentId: "dep1",
  demoSurfaceKind: "web_url",
  demoBehaviorCount: 3,
  demoPassed: 3,
  bundleDigest: SHA("b"),
  contentHash: SHA("f"),
  createdAt: "2026-07-20T00:00:00.000Z",
};

const LIST: MergeTrainListResponse = { artifacts: [SUMMARY] };

const ARTIFACT: MergeTrainArtifact = {
  version: 1,
  schemaVersion: "merge_train_artifact.v1",
  orgId: "org1",
  projectId: "proj1",
  landGroupId: "lg1",
  authorityDecisionId: "decision-node1-headsha",
  integrationNodeId: "node1",
  proofRoot: SHA("a"),
  receipt: { mainSha: "mainsha1", auditId: "audit1" },
  members: [{ ordinal: 0, memberKey: "mk-a", runId: "run-a", specId: "spec-a", prNumber: 11 }],
  deploy: { provider: "fly", appId: "app1", deploymentId: "dep1", url: "https://x", state: "live" },
  demo: { surfaceKind: "web_url", behaviorCount: 3, passed: 3, failed: 0 },
  sealedBundle: {
    bundleId: "bundle-1",
    bundleDigest: SHA("b"),
    proofRoot: SHA("c"),
    bytesDigest: SHA("d"),
    signingKeyId: "key1",
    rootSignatureHex: "abcd",
  },
  contentHash: SHA("f"),
};

async function render(projection?: MergeTrainListResponse): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.html(MergeTrainPanel({ projection, orgId: "org1", projectId: "proj1" })));
  return await (await app.request("/")).text();
}

describe("mq-15 merge-train dashboard surface", () => {
  it("client reads the train list + one land-group artifact with encoded identities", async () => {
    const calls: string[] = [];
    const client = new MergeQueueTrainClient({
      orchestratorUrl: "http://orchestrator:3000",
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push(url);
        if (url.includes("/train")) return new Response(JSON.stringify(LIST), { status: 200 });
        return new Response(JSON.stringify({ artifact: ARTIFACT }), { status: 200 });
      },
    });

    expect(await client.listTrain("org/acme", "project tanren", 7)).toEqual(LIST);
    expect(await client.getArtifact("org/acme", "project tanren", "lg 1")).toEqual(ARTIFACT);
    expect(calls).toEqual([
      "http://orchestrator:3000/orgs/org%2Facme/projects/project%20tanren/merge-queue/train?limit=7",
      "http://orchestrator:3000/orgs/org%2Facme/projects/project%20tanren/merge-queue/land-groups/lg%201/artifact",
    ]);
  });

  it("client swallows a read failure to undefined (panel degrades to unknown)", async () => {
    const client = new MergeQueueTrainClient({
      orchestratorUrl: "http://orchestrator:3000",
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(await client.listTrain("o", "p")).toBeUndefined();
    expect(await client.getArtifact("o", "p", "g")).toBeUndefined();
  });

  it("renders a sealed train with its bound evidence + a verify action", async () => {
    const html = await render(LIST);
    expect(html).toContain("sealed delivery · verified");
    expect(html).toContain('data-land-group="lg1"');
    expect(html).toContain(SHA("a"));
    expect(html).toContain("3/3 behaviors passed");
    expect(html).toContain("verify artifact");
    expect(html).toContain("/merge-queue/land-groups/lg1/artifact");
  });

  it("renders unavailable and empty reads as unknown, never green", async () => {
    const unavailable = await render();
    const empty = await render({ artifacts: [] });
    expect(unavailable).toContain("unknown, not green");
    expect(unavailable).not.toContain("sealed delivery · verified");
    expect(empty).toContain("unknown, never green");
    expect(empty).not.toContain("sealed delivery · verified");
  });
});
