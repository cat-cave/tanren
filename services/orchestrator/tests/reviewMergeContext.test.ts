// Covers the review/merge run-context credential resolution. The bug this guards
// against: the review/merge stage resolved its GitHub credential ref ONLY from
// the project-config JSONB (`config.credentials.githubCredentialRef`), which
// `projects link --github-credential-ref` does NOT write (it sets the project
// RECORD column). The run path now threads the SAME resolved ref the PR-creation
// + CI-poll steps used into the context, so all three steps share one source.

import { describe, expect, it } from "vitest";
import { loadReviewMergeRunContext, type RunStateClient } from "../src/engine/workflow/reviewMerge/context.js";

interface RowOverrides {
  config?: unknown;
  orgConfig?: unknown;
}

/** A minimal pool that returns one runs-join row for the context query. */
function poolReturning(overrides: RowOverrides = {}): RunStateClient {
  return {
    async query(sql: string) {
      if (sql.includes("FROM runs r") && sql.includes("default_branch")) {
        return {
          rows: [
            {
              run_id: "run_1",
              spec_id: "spec_1",
              project_id: "project_1",
              pr_url: "https://github.com/cat-cave/fix/pull/7",
              config: overrides.config ?? { version: 1 },
              default_branch: "main",
              org_config: overrides.orgConfig ?? null,
            },
          ],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  } as unknown as RunStateClient;
}

describe("loadReviewMergeRunContext credential resolution", () => {
  it("uses the run-resolved github ref (project record → org default) over the config JSONB", async () => {
    // The project record's ref is threaded in; the config JSONB carries a
    // DIFFERENT ref. The resolved ref must win — proving the review/merge step
    // resolves from the same source as the PR-creation + CI-poll steps.
    const pool = poolReturning({
      config: { version: 1, credentials: { githubCredentialRef: "credential/github/stale-config" } },
    });
    const context = await loadReviewMergeRunContext(pool, "run_1", {
      resolvedGithubCredentialRef: "credential/github/project-record",
    });
    expect(context.staticCredentialRef).toBe("credential/github/project-record");
  });

  it("resolves the org default ref when the project record had only the org default", async () => {
    // `resolveCredentialsForRun` already collapsed project-record → org-default
    // into one ref before the run path threads it here, so an org-default-only
    // setup still resolves at review/merge.
    const pool = poolReturning({ config: { version: 1 } });
    const context = await loadReviewMergeRunContext(pool, "run_1", {
      resolvedGithubCredentialRef: "credential/github/org-default",
    });
    expect(context.staticCredentialRef).toBe("credential/github/org-default");
  });

  it("falls back to the config JSONB ref when no resolved ref is threaded in", async () => {
    // Out-of-band callers that do not pre-resolve keep the prior behavior.
    const pool = poolReturning({
      config: { version: 1, credentials: { githubCredentialRef: "credential/github/from-config" } },
    });
    const context = await loadReviewMergeRunContext(pool, "run_1");
    expect(context.staticCredentialRef).toBe("credential/github/from-config");
  });

  it("leaves staticCredentialRef unset when neither a resolved ref nor a config ref exists", async () => {
    // No ref anywhere → undefined. The token resolver then raises a hard config
    // error at use time (no hardcoded default ref).
    const pool = poolReturning({ config: { version: 1 } });
    const context = await loadReviewMergeRunContext(pool, "run_1");
    expect(context.staticCredentialRef).toBeUndefined();
  });

  it("validates the threaded ref shape (must be a credential/github/ ref)", async () => {
    const pool = poolReturning({ config: { version: 1 } });
    await expect(
      loadReviewMergeRunContext(pool, "run_1", { resolvedGithubCredentialRef: "credential/openai/wrong" }),
    ).rejects.toThrow(/credential\/github\//u);
  });
});
