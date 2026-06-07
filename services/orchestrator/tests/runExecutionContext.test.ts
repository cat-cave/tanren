// behavior tests for loadRunExecutionContext — the inverse of
// createQueuedRunFromSpec that re-hydrates a claimed plan job's PlannerRunContext
// from its run⋈spec⋈project rows + resolved credentials. Asserts the mapped
// context fields (so a swapped column survives nothing), the acceptance-criteria
// string filtering, the org-id passthrough, and the not-found error.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { emptyRoutingTable } from "../src/engine/config/shared.js";
import {
  buildEffectiveRouting,
  loadRunExecutionContext,
  RunExecutionContextNotFoundError,
} from "../src/engine/worker/runExecutionContext.js";

// A minimal query stub returning a crafted run⋈spec⋈project row + the org-config
// read resolveCredentialsForRun issues. Drives the real loader without a DB.
function rowPool(row: Record<string, unknown> | undefined): pg.Pool {
  return {
    async query(sql: string) {
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT config FROM organizations")) {
        return { rows: [{ config: { version: 1 } }], rowCount: 1 };
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
    speculative_base: null,
    runner_image: "ghcr.io/acme/runner:1",
    config: {
      version: 1,
      credentials: {
        defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" },
        githubCredentialRef: "cred/gh",
      },
    },
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
      defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" },
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

  it("P2c-1: a speculative run's targetBranch is its integration branch (the DYNAMIC BASE), not default_branch", async () => {
    const { context } = await loadRunExecutionContext(
      rowPool(fullRow({ default_branch: "main", speculative_base: "tanren/integ/spec_1" })),
      { runId: "run_1", identitySecretRef: "id" },
    );
    expect(context.targetBranch).toBe("tanren/integ/spec_1");
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

  it("P2a Part 2: threads the org App installation onto the context (for App-first clone)", async () => {
    const orgConfig = {
      version: 1,
      github_app: {
        appId: "12345",
        installationId: "67890",
        credentialRef: "credential/github_app/test",
        installedAt: "2026-01-01T00:00:00Z",
      },
    };
    const { context } = await loadRunExecutionContext(rowPool(fullRow({ org_id: "org_42", org_config: orgConfig })), {
      runId: "run_1",
      identitySecretRef: "id",
    });
    expect(context.installation).toEqual(orgConfig.github_app);
  });

  it("P2a Part 2: leaves installation undefined when the org has no App installed", async () => {
    const { context } = await loadRunExecutionContext(
      rowPool(fullRow({ org_id: "org_42", org_config: { version: 1 } })),
      { runId: "run_1", identitySecretRef: "id" },
    );
    expect(context.installation).toBeUndefined();
  });

  it("throws RunExecutionContextNotFoundError (with the run id) when no row is found", async () => {
    await expect(loadRunExecutionContext(rowPool(), { runId: "run_missing", identitySecretRef: "id" })).rejects.toThrow(
      RunExecutionContextNotFoundError,
    );
    await expect(loadRunExecutionContext(rowPool(), { runId: "run_missing", identitySecretRef: "id" })).rejects.toThrow(
      /run_missing/u,
    );
  });

  it("threads a default-Codex routing table when project config carries no routing", async () => {
    const { context } = await loadRunExecutionContext(rowPool(fullRow()), {
      runId: "run_1",
      identitySecretRef: "id",
    });
    // The four loop roles head with a Codex entry pointing at the resolved ref —
    // Codex by DATA, not a code-level hardcode.
    for (const role of ["plan", "write", "check", "audit"] as const) {
      expect(context.routing?.[role].chain[0]).toEqual({
        cli: "codex",
        model: "default",
        authRef: "credential/codex/dev",
      });
    }
  });

  it("threads the project routing override (a non-Codex writer) onto the run context", async () => {
    const config = {
      version: 1,
      credentials: {
        defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" },
        githubCredentialRef: "cred/gh",
      },
      routing: {
        write: { chain: [{ cli: "opencode", model: "zai/glm-5.1", authRef: "cred/opencode" }] },
      },
    };
    const { context } = await loadRunExecutionContext(rowPool(fullRow({ config })), {
      runId: "run_1",
      identitySecretRef: "id",
    });
    // The overridden write role keeps the project's provider…
    expect(context.routing?.write.chain[0]).toEqual({
      cli: "opencode",
      model: "zai/glm-5.1",
      authRef: "cred/opencode",
    });
    // …while the roles the project left empty still default to Codex.
    expect(context.routing?.plan.chain[0]?.cli).toBe("codex");
  });
});

describe("buildEffectiveRouting", () => {
  it("fills every empty loop-role chain with a default-Codex entry", () => {
    const effective = buildEffectiveRouting(emptyRoutingTable(), {
      cli: "codex",
      model: "default",
      authRef: "credential/codex/dev",
    });
    for (const role of ["plan", "write", "check", "audit"] as const) {
      expect(effective[role].chain).toEqual([{ cli: "codex", model: "default", authRef: "credential/codex/dev" }]);
    }
  });

  it("keeps a project's per-role override instead of the Codex default", () => {
    const project = emptyRoutingTable();
    project.write = { chain: [{ cli: "claude", model: "claude-opus-4-8", authRef: "cred/claude" }] };
    const effective = buildEffectiveRouting(project, {
      cli: "codex",
      model: "default",
      authRef: "credential/codex/dev",
    });
    expect(effective.write.chain[0]?.cli).toBe("claude");
    // Roles the project did not override still default to Codex.
    expect(effective.check.chain[0]?.cli).toBe("codex");
  });

  it("does NOT default demo or forge — they keep their empty chains", () => {
    const effective = buildEffectiveRouting(emptyRoutingTable(), {
      cli: "codex",
      model: "default",
      authRef: "credential/codex/dev",
    });
    // demo carries its own empty-chain semantics (narrator template fallback);
    // forge is not a loop adapter — neither is filled with a Codex default.
    expect(effective.demo.chain).toEqual([]);
    expect(effective.forge.chain).toEqual([]);
  });
});
