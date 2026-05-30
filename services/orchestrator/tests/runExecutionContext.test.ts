// P3-0001: behavior tests for loadRunExecutionContext — the inverse of
// createQueuedRunFromSpec that re-hydrates a claimed plan job's PlannerRunContext
// from its run⋈spec⋈project rows + resolved credentials. Asserts the mapped
// context fields (so a swapped column survives nothing), the acceptance-criteria
// string filtering, the org-id passthrough, and the not-found error.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { loadRunExecutionContext, RunExecutionContextNotFoundError } from "../src/engine/worker/runExecutionContext.js";

// A minimal query stub returning a crafted run⋈spec⋈project row + the org-config
// read resolveCredentialsForRun issues. Drives the real loader without a DB.
function rowPool(row: Record<string, unknown> | undefined): pg.Pool {
  return {
    async query(sql: string) {
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT config FROM organizations")) {
        return { rows: [{ config: {} }], rowCount: 1 };
      }
      // The run⋈spec⋈project join.
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    },
  } as unknown as pg.Pool;
}

function fullRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    run_id: "run_1",
    spec_id: "spec_1",
    project_id: "project_1",
    branch: "tanren/feature",
    repo_url: "https://github.com/acme/repo",
    default_branch: "main",
    runner_image: "ghcr.io/acme/runner:1",
    config: { version: 1, credentials: { codexCredentialRef: "cred/codex", githubCredentialRef: "cred/gh" } },
    org_id: null,
    title: "Add a marker",
    description: "Create the marker file.",
    acceptance_criteria: ["marker exists", "ci green"],
    ...overrides,
  };
}

describe("loadRunExecutionContext", () => {
  it("maps every run⋈spec⋈project column onto the PlannerRunContext", async () => {
    const { context, projectConfig, orgId } = await loadRunExecutionContext(rowPool(fullRow()), {
      runId: "run_1",
      identitySecretRef: "runner/test/identity",
    });

    expect(context).toMatchObject({
      runId: "run_1",
      specId: "spec_1",
      projectId: "project_1",
      repoUrl: "https://github.com/acme/repo",
      // targetBranch comes from the project default_branch, runBranch from the run branch.
      targetBranch: "main",
      runBranch: "tanren/feature",
      specTitle: "Add a marker",
      specDescription: "Create the marker file.",
      acceptanceCriteria: ["marker exists", "ci green"],
      runnerImage: "ghcr.io/acme/runner:1",
      identitySecretRef: "runner/test/identity",
      githubCredentialRef: "cred/gh",
      codexCredentialRef: "cred/codex",
    });
    expect(projectConfig.version).toBe(1);
    expect(orgId).toBeNull();
  });

  it("distinguishes the run branch from the project default branch", async () => {
    const { context } = await loadRunExecutionContext(
      rowPool(fullRow({ branch: "tanren/x", default_branch: "develop" })),
      { runId: "run_1", identitySecretRef: "id" },
    );
    expect(context.runBranch).toBe("tanren/x");
    expect(context.targetBranch).toBe("develop");
  });

  it("keeps only string acceptance criteria (drops non-strings)", async () => {
    const { context } = await loadRunExecutionContext(
      rowPool(fullRow({ acceptance_criteria: ["a", 5, null, "b", { x: 1 }] })),
      { runId: "run_1", identitySecretRef: "id" },
    );
    expect(context.acceptanceCriteria).toEqual(["a", "b"]);
  });

  it("returns an empty acceptance-criteria list when the column is not an array", async () => {
    const { context } = await loadRunExecutionContext(rowPool(fullRow({ acceptance_criteria: "not-an-array" })), {
      runId: "run_1",
      identitySecretRef: "id",
    });
    expect(context.acceptanceCriteria).toEqual([]);
  });

  it("passes through a non-null org id", async () => {
    const { orgId } = await loadRunExecutionContext(rowPool(fullRow({ org_id: "org_42" })), {
      runId: "run_1",
      identitySecretRef: "id",
    });
    expect(orgId).toBe("org_42");
  });

  it("throws RunExecutionContextNotFoundError (with the run id) when no row is found", async () => {
    await expect(loadRunExecutionContext(rowPool(), { runId: "run_missing", identitySecretRef: "id" })).rejects.toThrow(
      RunExecutionContextNotFoundError,
    );
    await expect(loadRunExecutionContext(rowPool(), { runId: "run_missing", identitySecretRef: "id" })).rejects.toThrow(
      /run_missing/u,
    );
  });
});
