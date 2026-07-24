import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { createGitHubIssuesConnector, ingestSource, type InboxSource } from "../src/engine/forge/inbox/index.js";
import type { GitHubHttpClient } from "../src/engine/providers/github.js";
const source: InboxSource = {
  id: "source-1",
  orgId: "org-1",
  projectId: "project-1",
  kind: "issues",
  name: "GitHub issues",
  detail: "open issues",
  config: { owner: "cat-cave", repo: "tanren", labels: [] },
  enabled: true,
  autoRoute: false,
};
const credentialRef = "credential/github/org/org-1/default";
async function connector(githubHttp: GitHubHttpClient) {
  const secrets = new InMemorySecretStore();
  await secrets.put({ ref: credentialRef, value: "token" });
  return createGitHubIssuesConnector({ secrets, githubHttp, defaultStaticRef: credentialRef });
}
function ingestion(githubConnector: Awaited<ReturnType<typeof connector>>, input = source) {
  const query = vi.fn<() => Promise<void>>(async () => {});
  const result = ingestSource(
    {
      pool: { query } as never,
      connectors: new Map([["issues", githubConnector]]),
      answerer: { triage: async () => ({}) } as never,
    },
    input,
  );
  return { query, result };
}
describe("GitHub inbox connector fail-closed decoding", () => {
  it("NEGATIVE CONTROL — rejects null, string, and number PR markers before persistence", async () => {
    const issue = { comments: 0, user: { login: "octocat" } };
    const body = [
      { ...issue, number: 1, title: "valid" },
      { ...issue, number: 2, title: "null", pull_request: null },
      { ...issue, number: 3, title: "string", pull_request: "bad" },
      { ...issue, number: 4, title: "number", pull_request: 1 },
    ];
    const http: GitHubHttpClient = { request: async () => ({ status: 200, body }) };
    const { query, result } = ingestion(await connector(http));
    await expect(result).rejects.toBeInstanceOf(z.ZodError);
    expect(query).not.toHaveBeenCalled();
  });
  it("rejects an encoded-NUL query collision before another request or persistence", async () => {
    let calls = 0;
    const githubConnector = await connector({
      async request() {
        calls += 1;
        return {
          status: 200,
          body: [{ number: 1, title: "first", comments: 0, user: { login: "octocat" } }],
          nextPagePath: "/repos/cat-cave/tanren/issues?state=open&per_page=50&labels%00a=b&page=2",
        };
      },
    });
    const { query, result } = ingestion(githubConnector, {
      ...source,
      config: { ...source.config, labels: ["a\u0000b"] },
    });
    await expect(result).rejects.toThrow(/configured issues resource scope/u);
    expect(query).not.toHaveBeenCalled();
    expect(calls).toBe(1);
  });
});
