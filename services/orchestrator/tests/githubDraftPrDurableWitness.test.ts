import { describe, expect, it } from "vitest";
import { readDurableDraftPrPublishedHead } from "../src/engine/workflow/githubDraftPrLease.js";

const repoUrl = "https://github.com/cat-cave/repo.git";
const branch = "tanren/run_123";
const sha = "a".repeat(40);

class WitnessPool {
  constructor(private readonly payload: unknown) {}

  async query() {
    return { rows: [{ payload: this.payload }] };
  }
}

const input = { orgId: "org_fake", specId: "spec_123", branch, repoUrl };

function witness(overrides: Record<string, unknown> = {}) {
  return {
    repoUrl,
    branch,
    headSha: sha,
    sourceRef: sha,
    credentialRef: "github_app",
    redacted: true,
    ...overrides,
  };
}

describe("draft publication durable source/ref witness", () => {
  it.each([
    ["legacy head-only", { headSha: sha }],
    ["malformed head", witness({ headSha: "not-a-sha" })],
    ["mismatched source", witness({ sourceRef: "b".repeat(40) })],
  ])("rejects %s state before it can lease a remote ref", async (_label, payload) => {
    await expect(readDurableDraftPrPublishedHead(new WitnessPool(payload), input)).rejects.toThrow(
      "durable source/ref witness is invalid",
    );
  });

  it("rejects a valid witness from another repository", async () => {
    await expect(
      readDurableDraftPrPublishedHead(
        new WitnessPool(witness({ repoUrl: "https://github.com/other/repo.git" })),
        input,
      ),
    ).rejects.toThrow("durable ownership witness does not match");
  });
});
