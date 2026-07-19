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
import { AUTONOMOUS_AUDIT_POSTURE, DEFAULT_AUDIT_POSTURE } from "../src/engine/config/auditPostureConfig.js";
import {
  assertAuditPostureReentersFindings,
  AuditPostureStrandsFindingsError,
} from "../src/engine/workflow/auditPosturePreflight.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";

const noopAppend: AppendEvent = async () => {};

// A minimal query stub returning a crafted run⋈spec⋈project row + the org-config
// read resolveCredentialsForRun issues. Drives the real loader without a DB.
function rowPool(row: Record<string, unknown> | undefined, behaviorIds: readonly string[] = []): pg.Pool {
  const behaviorRows = behaviorIds.map((behavior_id) => ({ behavior_id }));
  return {
    async query(sql: string) {
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT config FROM organizations")) {
        return { rows: [{ config: { version: 1 } }], rowCount: 1 };
      }
      // WS-D2: the writer-context design read — no design contract in these fixtures.
      if (trimmed.includes("FROM design_contracts")) {
        return { rows: [], rowCount: 0 };
      }
      // rv-premerge: the run's declared behaviors (spec_behaviors ⋈ specs) hydrate context.behaviorIds.
      if (trimmed.includes("FROM\n         spec_behaviors") || trimmed.includes("FROM spec_behaviors")) {
        return { rows: behaviorRows, rowCount: behaviorRows.length };
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
    config: {
      version: 1,
      credentials: {
        defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" },
        githubCredentialRef: "gh",
      },
    },
    // A run is ALWAYS tenant-scoped (`runs.org_id` / `projects.org_id` are NOT-NULL).
    // The fixture carries a REAL org id so the loader resolves credentials org-scoped;
    // a null/empty org_id is exercised separately as a LOUD failure (UnscopedOrgError).
    org_id: "org_42",
    title: "Add a marker",
    description: "Create the marker file.",
    acceptance_criteria: ["marker exists", "ci green"],
    // Task #86: `specs.mode` is NOT NULL in the DB. The row-schema now insists on a
    // real value (no optional().default() accommodation), so fixtures must carry it.
    mode: "from_scratch",
    ...overrides,
  };
}

describe("loadRunExecutionContext", () => {
  it("rv-premerge: hydrates context.behaviorIds from spec_behaviors (production, not injected)", async () => {
    const { context } = await loadRunExecutionContext(rowPool(fullRow(), ["beh_a", "beh_b"]), {
      runId: "run_1",
      identitySecretRef: "runner/test/identity",
    });
    // The pre-merge behavior gate reads context.behaviorIds; an EMPTY hydration would make the
    // producer a silent no-op (the fail-open bug). The declared behaviors are populated here.
    expect(context.behaviorIds).toEqual(["beh_a", "beh_b"]);
  });

  it("rv-premerge: a run with no declared behaviors hydrates an empty behaviorIds", async () => {
    const { context } = await loadRunExecutionContext(rowPool(fullRow(), []), {
      runId: "run_1",
      identitySecretRef: "runner/test/identity",
    });
    expect(context.behaviorIds).toEqual([]);
  });

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
      githubCredentialRef: "credential/github/org/org_42/gh",
      defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" },
    });
    expect(projectConfig.version).toBe(1);
    expect(orgId).toBe("org_42");
  });

  // Regression guard for the auditPosture-eradication wire-up: the governance API
  // accepts `auditPosture` on the project config, and the run-execution context MUST
  // thread it onto the `PlannerRunContext` so `assertAuditPostureReentersFindings`
  // (the preflight at the planner-run boundary) sees what the operator PUT. A previous
  // change deleted the env-driven default but forgot this wire, so every autonomous
  // run failed the preflight regardless of what the operator configured.
  it("threads projectConfig.auditPosture + convergencePolicy onto the PlannerRunContext", async () => {
    const projectConfigWithAutonomous = {
      version: 1,
      credentials: {
        defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" },
        githubCredentialRef: "gh",
      },
      auditPosture: AUTONOMOUS_AUDIT_POSTURE,
      convergencePolicy: {
        demoRunEnabled: true,
        velocityDeferEnabled: false,
        velocityDeferMaxSeverity: "P2" as const,
        velocityDeferAfterStalls: 2,
      },
    };
    const { context } = await loadRunExecutionContext(rowPool(fullRow({ config: projectConfigWithAutonomous })), {
      runId: "run_1",
      identitySecretRef: "id",
    });
    expect(context.auditPosture).toEqual(AUTONOMOUS_AUDIT_POSTURE);
    expect(context.convergencePolicy).toEqual(projectConfigWithAutonomous.convergencePolicy);
    // The preflight that gates an autonomous run sees the threaded posture and PASSES.
    await expect(
      assertAuditPostureReentersFindings({ autonomous: true, posture: context.auditPosture! }, noopAppend),
    ).resolves.toBeUndefined();
  });

  it("an autonomous run whose project did NOT set auditPosture trips the preflight on the BALANCED default", async () => {
    // A project that did not PUT `auditPosture` resolves to the BALANCED default (the
    // safe human-stop). The preflight FAILS LOUD if such a project tries to run
    // autonomously — exactly the fail-closed bar the eradication doctrine demands.
    const { context } = await loadRunExecutionContext(rowPool(fullRow()), {
      runId: "run_1",
      identitySecretRef: "id",
    });
    expect(context.auditPosture).toEqual(DEFAULT_AUDIT_POSTURE);
    await expect(
      assertAuditPostureReentersFindings({ autonomous: true, posture: context.auditPosture! }, noopAppend),
    ).rejects.toBeInstanceOf(AuditPostureStrandsFindingsError);
  });

  it("FAILS LOUD (UnscopedOrgError) when the run row carries a null/empty org id — never a silent BYOK degrade", async () => {
    // `runs.org_id` is NOT-NULL, so a null/empty org id at a run path is a scoping
    // bug. The loader threads it through `orgScopeFromRunOrgId`, which throws rather
    // than coercing `?? ""` into project-config-only BYOK (no_silent_fallbacks).
    await expect(
      loadRunExecutionContext(rowPool(fullRow({ org_id: null })), { runId: "run_1", identitySecretRef: "id" }),
    ).rejects.toMatchObject({ name: "UnscopedOrgError" });
    await expect(
      loadRunExecutionContext(rowPool(fullRow({ org_id: "" })), { runId: "run_1", identitySecretRef: "id" }),
    ).rejects.toMatchObject({ name: "UnscopedOrgError" });
    await expect(
      loadRunExecutionContext(rowPool(fullRow({ org_id: "   " })), { runId: "run_1", identitySecretRef: "id" }),
    ).rejects.toMatchObject({ name: "UnscopedOrgError" });
  });

  it("H2 org-scope invariant: the hydrated PlannerRunContext.orgId is the SAME real non-empty string as the row's org_id", async () => {
    // The H2 findings (#2 designWriterContext / #3 providerFactory / #4-#5
    // plannerRunSeams) each defended against a `context.orgId` state that
    // "cannot happen" but silently degraded (undefined skip / `""` coercion) if
    // it did. The fix enforces the invariant HERE at the hydration boundary:
    // `runs.org_id` is threaded through `orgScopeFromRunOrgId`, which throws
    // `UnscopedOrgError` on a missing value AND returns the narrowed
    // `TenantScope`. The context's `orgId` is populated from THAT scope, so a
    // downstream consumer can read it as a REQUIRED non-empty string with no
    // `?? ""` / `typeof …` narrow (the whole vestigial safety-net cluster).
    const { context, orgId } = await loadRunExecutionContext(rowPool(fullRow({ org_id: "org_h2" })), {
      runId: "run_1",
      identitySecretRef: "id",
    });
    expect(context.orgId).toBe("org_h2");
    expect(orgId).toBe("org_h2");
    // TypeScript narrowing: at this point `context.orgId` and `orgId` are both
    // typed `string` (not `string | null | undefined`). A vestigial `?? ""`
    // downstream would now be a type error, not a silent runtime empty-string.
    const narrow: string = context.orgId;
    expect(narrow).toBe("org_h2");
    const returnedOrgId: string = orgId;
    expect(returnedOrgId).toBe("org_h2");
  });

  it("distinguishes the run branch from the project default branch", async () => {
    const { context } = await loadRunExecutionContext(
      rowPool(fullRow({ branch: "tanren/x", default_branch: "develop" })),
      { runId: "run_1", identitySecretRef: "id" },
    );
    expect(context.runBranch).toBe("tanren/x");
    expect(context.targetBranch).toBe("develop");
  });

  it("§2c jj-local: a DEPENDENT speculative run's targetBranch is default_branch + its ancestor stack is threaded for the LOCAL assembly", async () => {
    const stack = [{ specId: "spec_anc", runId: "run_anc", branch: "tanren/spec_anc", headSha: "sha_anc" }];
    const { context } = await loadRunExecutionContext(
      rowPool(fullRow({ default_branch: "main", ancestor_stack: stack })),
      { runId: "run_1", identitySecretRef: "id" },
    );
    // The run's history root is `default_branch`; the dependent jj-assembles its base
    // LOCALLY from the threaded ancestor stack (no synthesized integration ref).
    expect(context.targetBranch).toBe("main");
    expect(context.ancestorStack).toEqual(stack);
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
        credentialRef: "credential/github_app/org/org_42/test",
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
        githubCredentialRef: "gh",
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

// Environment management (env P3) — the per-project env resolution at the image
// seam, exercised THROUGH the loader. A stub that distinguishes the `environments`
// registry lookup (returning either a match or no rows) from the run⋈spec join.
function envRowPool(row: Record<string, unknown>, env: { match?: Record<string, unknown> } = {}): pg.Pool {
  return {
    async query(sql: string) {
      const trimmed = sql.trim();
      if (trimmed.startsWith("SELECT config FROM organizations")) {
        return { rows: [{ config: { version: 1 } }], rowCount: 1 };
      }
      if (trimmed.includes("FROM environments")) {
        return env.match === undefined ? { rows: [], rowCount: 0 } : { rows: [env.match], rowCount: 1 };
      }
      // WS-D2: the writer-context design read — no design contract in these fixtures.
      if (trimmed.includes("FROM design_contracts")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [row], rowCount: 1 };
    },
  } as unknown as pg.Pool;
}

// A config carrying a declared toolchain (so resolution computes an env_key + hits
// the registry). The lifecycle is otherwise minimal — only `toolchain` is read here.
function configWithToolchain(): Record<string, unknown> {
  return {
    version: 1,
    credentials: {
      defaultLlm: { cli: "codex", model: "default", authRef: "credential/codex/dev" },
      githubCredentialRef: "gh",
    },
    lifecycle: {
      stack: "ts-pnpm",
      bootstrap: "just bootstrap",
      tier1: "just tier-1",
      tier2: "just tier-2",
      tier3: "just tier-3",
      build: "just build",
      deploy: "just deploy",
      upgrade: "just upgrade",
      toolchain: [{ name: "node", version: "22" }],
    },
  };
}

describe("loadRunExecutionContext — env resolution at the image seam (env P3)", () => {
  it("no declared toolchain → keeps the project runner_image + records NO environmentRef", async () => {
    const { context, projectConfig } = await loadRunExecutionContext(rowPool(fullRow()), {
      runId: "run_1",
      identitySecretRef: "id",
    });
    expect(context.runnerImage).toBe("ghcr.io/acme/runner:1");
    expect(projectConfig.environmentRef).toBeUndefined();
  });

  it("a declared toolchain with NO registry match → golden-base fallback, env_key recorded, no environmentRef", async () => {
    const { context, projectConfig } = await loadRunExecutionContext(
      envRowPool(fullRow({ config: configWithToolchain() })),
      { runId: "run_1", identitySecretRef: "id" },
    );
    // No match ⇒ the project's runner_image (its base), but the env_key WAS computed.
    expect(context.runnerImage).toBe("ghcr.io/acme/runner:1");
    expect(projectConfig.environmentRef?.envKey).toMatch(/^[0-9a-f]{64}$/u);
    expect(projectConfig.environmentRef?.environmentRef).toBeUndefined();
    expect(projectConfig.environmentRef?.imageRef).toBe("ghcr.io/acme/runner:1");
  });

  it("a declared toolchain WITH a validated registry match → env.image_ref + environmentRef recorded", async () => {
    const match = {
      id: "env_matched",
      org_id: "org_42",
      env_key: "ignored-by-test",
      image_ref: "registry:5000/tanren-env@sha256:matched",
      capabilities: { tools: { node: "22" } },
      channel: "lts",
      status: "validated",
      provenance: { baseDigest: "golden-deadbeef", miseLockHash: "h" },
      validation_proof: null,
    };
    const { context, projectConfig } = await loadRunExecutionContext(
      envRowPool(fullRow({ config: configWithToolchain() }), { match }),
      { runId: "run_1", identitySecretRef: "id" },
    );
    expect(context.runnerImage).toBe("registry:5000/tanren-env@sha256:matched");
    expect(projectConfig.environmentRef?.environmentRef).toBe("env_matched");
    expect(projectConfig.environmentRef?.imageRef).toBe("registry:5000/tanren-env@sha256:matched");
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
