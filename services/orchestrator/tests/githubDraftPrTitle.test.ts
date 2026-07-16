import { describe, expect, it } from "vitest";
import type { RunPoolSpecOverrides } from "./helpers/githubDraftPrFakes.js";
import { RecordingRunPool, RecordingSsh, ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { publishDraftPullRequestForRun } from "../src/engine/workflow/githubDraftPr.js";

// The PR-title resolution (apex v31): GitHub 422s an EMPTY title (`missing_field:
// title`). `??` does NOT catch an empty string, so a blank `input.title` once flowed
// straight through to GitHub. These drive the run publish path and assert on the
// `title` the GitHub client actually receives (the POST /pulls request body) — the fix
// lives in `publishDraftPullRequestForRun` (githubDraftPr.ts). Split into its own file
// from `githubDraftPr.test.ts` to keep both under the 500-line architecture cap.
// Drive `publishDraftPullRequestForRun` and return the title in the POST /pulls body.
async function publishedTitle(options: {
  inputTitle?: string;
  spec?: RunPoolSpecOverrides;
}): Promise<string | undefined> {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: "credential/github/org/org_fake/dev", value: "ghp_secretToken" });
  const http = new ScriptedGitHubHttp([
    { status: 200, body: [] },
    {
      status: 201,
      body: {
        number: 9,
        html_url: "https://github.com/cat-cave/repo/pull/9",
        draft: true,
        base: { ref: "main" },
      },
    },
  ]);
  const pool = new RecordingRunPool(options.spec);

  await publishDraftPullRequestForRun({
    pool: pool.asPgPool(),
    eventStore: new FakeEventStore(),
    secrets,
    githubHttp: http,
    ssh: new RecordingSsh(),
    runId: "run_123",
    identitySecretRef: "runner/local/identity",
    title: options.inputTitle,
    timeoutMs: 500,
  });

  const createReq = http.requests.find((r) => r.method === "POST" && r.path.endsWith("/pulls"));
  return (createReq?.body as { title?: string } | undefined)?.title;
}

describe("draft PR title resolution coalesces on BLANK (apex v31)", () => {
  it('empty input.title ("") → falls back to `Tanren: <specTitle>`, NEVER the empty string', async () => {
    const title = await publishedTitle({ inputTitle: "", spec: { specTitle: "Deploy the URL shortener" } });
    expect(title).toBe("Tanren: Deploy the URL shortener");
    expect(title).not.toBe("");
  });

  it('whitespace input.title ("  ") → also falls back to `Tanren: <specTitle>`', async () => {
    const title = await publishedTitle({ inputTitle: "  ", spec: { specTitle: "Deploy the URL shortener" } });
    expect(title).toBe("Tanren: Deploy the URL shortener");
    expect(title?.trim()).not.toBe("");
  });

  it("BOTH input.title and specTitle blank → `Tanren change <specId>` (structurally non-empty)", async () => {
    const title = await publishedTitle({ inputTitle: "   ", spec: { specTitle: "   " } });
    // spec_id is "spec_123" in the run-pool fixture.
    expect(title).toBe("Tanren change spec_123");
    expect(title?.trim()).not.toBe("");
  });

  it("a real input.title is used verbatim (trimmed), specTitle ignored", async () => {
    const title = await publishedTitle({
      inputTitle: "  Add the redirect endpoint  ",
      spec: { specTitle: "Deploy the URL shortener" },
    });
    expect(title).toBe("Add the redirect endpoint");
  });
});
