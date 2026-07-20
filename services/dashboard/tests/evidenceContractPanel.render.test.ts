import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  MergeQueueEvidenceContractsClient,
  type MergeQueueEvidenceContractResponse,
} from "../src/api/mergeQueueEvidenceContracts.js";
import { EvidenceContractPanel } from "../src/components/mergeQueue/EvidenceContractPanel.js";

const DIGEST = `sha256:${"c".repeat(64)}`;
const SELECTED: MergeQueueEvidenceContractResponse = {
  resolutionStatus: "selected",
  contract: {
    schemaVersion: "fragment_evidence.v1",
    junitReportPath: "reports/junit.xml",
    testSelector: { path: ".tanren/test-selector.json", format: "json" },
    behaviorManifest: { path: ".tanren/behavior-manifest.json", format: "json" },
    contentDigest: DIGEST,
  },
  proofUnit: { id: "punit_1", inputHash: DIGEST, artifactDigest: DIGEST, verdict: "pass" },
  fallback: null,
};

async function render(projection: MergeQueueEvidenceContractResponse | undefined): Promise<string> {
  const app = new Hono();
  app.get("/", (c) => c.html(EvidenceContractPanel({ projection })));
  return await (await app.request("/")).text();
}

describe("mq-12 evidence-contract dashboard surface", () => {
  it("uses a read-only encoded route and renders no run control", async () => {
    const calls: string[] = [];
    const client = new MergeQueueEvidenceContractsClient({
      orchestratorUrl: "http://orchestrator:3000",
      fetchImpl: async (input) => {
        calls.push(typeof input === "string" ? input : input.toString());
        return new Response(JSON.stringify(SELECTED));
      },
    });
    expect(await client.getEvidenceContract("org/acme", "project tanren", "node/a")).toEqual(SELECTED);
    expect(calls).toEqual([
      "http://orchestrator:3000/orgs/org%2Facme/projects/project%20tanren/merge-queue/evidence-contracts/node%2Fa",
    ]);
    const html = await render(SELECTED);
    expect(html).toContain("fragment evidence contract");
    expect(html).toContain("reports/junit.xml");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("run evidence");
  });

  it("renders unavailable observations as a full-gate posture, never a selected green state", async () => {
    const html = await render({
      resolutionStatus: "full_gate_fallback",
      contract: null,
      proofUnit: null,
      fallback: "artifact_absent",
    });
    expect(html).toContain("full native pre-merge gate retained");
    expect(html).toContain("artifact_absent");
    expect(html).not.toContain("selected declarative evidence");
  });
});
