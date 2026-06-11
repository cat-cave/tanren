import { describe, expect, it } from "vitest";
import { ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";
import { projectHostSeamsOver, readChangeRequestShas } from "../src/engine/providers/projectHostSeamsOver.js";
import type { PullRequestRef, ResolvedVcsToken } from "../src/engine/contracts/codeHostTypes.js";

const TOKEN: ResolvedVcsToken = { token: "ghp_test", source: "static", refresh: async () => "ghp_test" };
const PR: PullRequestRef = { repo: { owner: "cat-cave", name: "repo" }, number: 7 };

describe("projectHostSeamsOver (decomposition PR-5/PR-9 host-seam bridge)", () => {
  it("builds the real { codeHost, visibility } pair over the run's GitHub HTTP client", () => {
    const http = new ScriptedGitHubHttp([]);
    const seams = projectHostSeamsOver(http, async () => TOKEN);
    expect(typeof seams.codeHost.readDiff).toBe("function");
    // The visibility surface is the HARDENED safe projection (every call yields a
    // ProjectionOutcome, never throws) — it carries the PR-1 best-effort methods.
    expect(typeof seams.visibility.markChangeRequestReady).toBe("function");
    expect(typeof seams.visibility.publishReview).toBe("function");
    expect(typeof seams.visibility.readExternalApproval).toBe("function");
  });
});

describe("readChangeRequestShas (sha-addressed diff migration, §1 #16)", () => {
  it("lifts the PR's exact base/head shas from a single GET /pulls/{n}", async () => {
    const baseSha = "a".repeat(40);
    const headSha = "b".repeat(40);
    const http = new ScriptedGitHubHttp([{ status: 200, body: { base: { sha: baseSha }, head: { sha: headSha } } }]);

    const shas = await readChangeRequestShas(http, PR, TOKEN);

    expect(shas).toEqual({ baseSha, headSha });
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]?.method).toBe("GET");
    expect(http.requests[0]?.path).toBe("/repos/cat-cave/repo/pulls/7");
  });

  it("throws LOUDLY when the PR read returns no base/head sha (never a silent empty diff)", async () => {
    const http = new ScriptedGitHubHttp([{ status: 200, body: { base: {}, head: {} } }]);
    await expect(readChangeRequestShas(http, PR, TOKEN)).rejects.toThrow(/no base\/head sha/u);
  });

  it("surfaces a non-200 PR read as a loud failure", async () => {
    const http = new ScriptedGitHubHttp([{ status: 404, body: { message: "Not Found" } }]);
    await expect(readChangeRequestShas(http, PR, TOKEN)).rejects.toThrow(/HTTP 404/u);
  });
});
