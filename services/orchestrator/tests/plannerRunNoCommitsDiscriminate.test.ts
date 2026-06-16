// v35 graceful "No commits between base and head": the PR-creation stage NEVER hard-strands
// the empty-branch 422. It DISCRIMINATES the cleaned PR head vs the clone base (the rebase
// `--onto` target the PR diffs against) into one of two legitimate dispositions:
//   - work ALREADY PRESENT in the base (head ahead of base, diff empty) → `converged` (done);
//   - the writer produced NOTHING this attempt (head == base) → `redrive` (transient retry).
// These pin the discriminator + that neither becomes a hard escalating `internal` error.

import { describe, expect, it } from "vitest";
import { discriminateNoCommits, EmptyWriterCommitError } from "../src/engine/workflow/plannerRunCi.js";
import { classifyRunFailure } from "../src/engine/worker/runFailureClassifier.js";
import {
  GitHubPullRequestService,
  NoCommitsBetweenBaseAndHeadError,
} from "../src/engine/providers/githubPullRequestReuse.js";
import { ScriptedGitHubHttp } from "./helpers/githubDraftPrFakes.js";

const BASE = "a".repeat(40);
const AHEAD = "b".repeat(40);

describe("ensureDraftPullRequest — a 'No commits between' 422 throws the TYPED error (v35 graceful)", () => {
  it("a structured code:custom 'No commits between' 422 → NoCommitsBetweenBaseAndHeadError (not the generic loud throw)", async () => {
    // The empty-branch 422: the head has NOTHING ahead of the base. GitHub returns a
    // structured `code: "custom"` + "No commits between ..." error. This must NOT be the
    // generic loud throw (it would escalate to a false `internal` strand) — it is the TYPED
    // error the PR-creation stage discriminates (converge vs re-drive). Live-confirmed shape.
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [
            {
              resource: "PullRequest",
              code: "custom",
              message: "No commits between main and tanren/scaffold-98a58c85",
            },
          ],
        },
      },
      { status: 200, body: [] },
    ]);
    const promise = new GitHubPullRequestService(http).ensureDraftPullRequest({
      repo: { owner: "cat-cave", name: "repo" },
      token: "ghp_secretToken",
      headBranch: "tanren/scaffold-98a58c85",
      baseBranch: "main",
      title: "Tanren: scaffold",
    });

    await expect(promise).rejects.toBeInstanceOf(NoCommitsBetweenBaseAndHeadError);
    await expect(promise).rejects.toMatchObject({ baseBranch: "main", headBranch: "tanren/scaffold-98a58c85" });
    // find-by-head → POST (422) → re-find-by-head (still none) → typed throw.
    expect(http.requests.map((request) => request.method)).toEqual(["GET", "POST", "GET"]);
  });

  it("an UNRELATED 422 (an empty-title missing_field) still throws the generic LOUD error — never mis-routed as empty-branch", async () => {
    const http = new ScriptedGitHubHttp([
      { status: 200, body: [] },
      {
        status: 422,
        body: {
          message: "Validation Failed",
          errors: [{ resource: "PullRequest", field: "title", code: "missing_field" }],
        },
      },
      { status: 200, body: [] },
    ]);
    const promise = new GitHubPullRequestService(http).ensureDraftPullRequest({
      repo: { owner: "cat-cave", name: "repo" },
      token: "ghp_secretToken",
      headBranch: "tanren/run_1",
      baseBranch: "main",
      title: "",
    });
    // A real validation error fails LOUD (not the typed graceful error, not silent).
    await expect(promise).rejects.not.toBeInstanceOf(NoCommitsBetweenBaseAndHeadError);
    await expect(promise).rejects.toThrow(/HTTP 422/u);
  });
});

describe("discriminateNoCommits — converge vs re-drive on an empty branch (v35)", () => {
  it("the cleaned head AHEAD of the clone base → CONVERGED (work already present in base)", () => {
    // The writer DID author a commit; GitHub still finds no diff vs base ⇒ the content is
    // already in main ⇒ the spec is satisfied → converge (the merge path's terminal success).
    expect(discriminateNoCommits(AHEAD, BASE)).toBe("converged");
  });

  it("the cleaned head EQUAL to the clone base → REDRIVE (writer produced no commit this attempt)", () => {
    expect(discriminateNoCommits(BASE, BASE)).toBe("redrive");
  });

  it("an empty head sha (fake-SSH / no real workspace) → REDRIVE (conservative transient, never a spurious converge)", () => {
    expect(discriminateNoCommits("", BASE)).toBe("redrive");
  });

  it("the re-drive disposition's error classifies retriable, NOT a hard internal strand", () => {
    // The `redrive` branch throws EmptyWriterCommitError → the unified finalize re-drives it
    // (the `empty_writer_output` code is retriable; it escalates only after K, as a GENUINE
    // persistent_failure) — never the false escalating `internal` it used to become.
    const classified = classifyRunFailure(new EmptyWriterCommitError("tanren/run_1", "main"));
    expect(classified.code).toBe("empty_writer_output");
    expect(classified.code).not.toBe("internal");
  });
});
