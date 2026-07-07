// Environment management (env-management.md §4 P4, H1 finding #4) — tests for
// `refineRunnerImageForEnv`. The choke point that used to silently degrade to the
// golden base for an off-baseline toolchain when the JIT env-image seams weren't
// wired (`TANREN_ENV_REGISTRY` unset). It now fails LOUD with `JitBuildRequiredError`
// — no silent fallback, doctrine §2.2.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { refineRunnerImageForEnv } from "../src/engine/worker/runExecutorEnvRefine.js";
import { JitBuildRequiredError } from "../src/engine/environments/creation/index.js";
import type { PlannerRunContext } from "../src/engine/workflow/plannerRun.js";
import type { ProjectConfigV1 } from "../src/engine/config/index.js";

const GOLDEN = "ghcr.io/cat-cave/tanren-runner:golden-deadbeef";

// A stub pool — no query should reach it on the empty/covered/off-baseline+no-JIT
// paths (all short-circuit before the resolver). If a test accidentally routes to
// the resolver we surface it as a loud test failure.
function fakePool(): pg.Pool {
  return {
    query: () => {
      throw new Error("pool.query invoked — expected the short-circuit / early-throw path");
    },
  } as unknown as pg.Pool;
}

function ctx(overrides: Partial<PlannerRunContext> = {}): PlannerRunContext {
  return {
    runId: "run_1",
    specId: "spec_1",
    projectId: "proj_1",
    repoUrl: "https://example.test/repo",
    targetBranch: "main",
    runBranch: "tanren/run/spec_1",
    specTitle: "t",
    specDescription: "d",
    acceptanceCriteria: [],
    runnerImage: GOLDEN,
    identitySecretRef: "ref",
    githubCredentialRef: "cred",
    ...overrides,
  };
}

function projectConfig(toolchain: Array<{ name: string; version: string }> | undefined): ProjectConfigV1 {
  return {
    version: 1,
    ...(toolchain === undefined
      ? {}
      : {
          lifecycle: {
            stack: "ts/pnpm",
            bootstrap: "pnpm install",
            tier1: "pnpm lint",
            tier2: "pnpm test",
            tier3: "pnpm ci",
            build: "pnpm build",
            deploy: "just deploy",
            upgrade: "",
            toolchain,
          },
        }),
  } as unknown as ProjectConfigV1;
}

describe("refineRunnerImageForEnv — H1 #4 loud fallback closure", () => {
  const originalRegistry = process.env["TANREN_ENV_REGISTRY"];
  beforeEach(() => {
    delete process.env["TANREN_ENV_REGISTRY"];
  });
  afterEach(() => {
    if (originalRegistry === undefined) {
      delete process.env["TANREN_ENV_REGISTRY"];
    } else {
      process.env["TANREN_ENV_REGISTRY"] = originalRegistry;
    }
  });

  it("no-ops on an UNDEFINED toolchain (no JIT capability wired)", async () => {
    const context = ctx();
    await refineRunnerImageForEnv({
      pool: fakePool(),
      creation: undefined,
      context,
      // eslint-disable-next-line unicorn/no-useless-undefined -- exercise the undefined-toolchain branch.
      projectConfig: projectConfig(undefined),
      orgId: "org_1",
    });
    // Runner image unchanged — the golden base binding stands.
    expect(context.runnerImage).toBe(GOLDEN);
  });

  it("no-ops on an EMPTY toolchain (no JIT capability wired)", async () => {
    const context = ctx();
    await refineRunnerImageForEnv({
      pool: fakePool(),
      creation: undefined,
      context,
      projectConfig: projectConfig([]),
      orgId: "org_1",
    });
    expect(context.runnerImage).toBe(GOLDEN);
  });

  it("no-ops on a BASELINE-SUBSET toolchain even when JIT is not wired (apex-style node+pnpm)", async () => {
    const context = ctx();
    await refineRunnerImageForEnv({
      pool: fakePool(),
      creation: undefined,
      context,
      projectConfig: projectConfig([
        { name: "node", version: "24" },
        { name: "pnpm", version: "11" },
      ]),
      orgId: "org_1",
    });
    // The golden base already serves this toolchain — no build needed, no throw.
    expect(context.runnerImage).toBe(GOLDEN);
  });

  it("THROWS JitBuildRequiredError on an off-baseline TOOL when JIT is not wired (H1 #4)", async () => {
    await expect(
      refineRunnerImageForEnv({
        pool: fakePool(),
        creation: undefined,
        context: ctx(),
        projectConfig: projectConfig([{ name: "rust", version: "nightly" }]),
        orgId: "org_1",
      }),
    ).rejects.toBeInstanceOf(JitBuildRequiredError);
  });

  it("THROWS on an off-baseline VERSION of a baseline tool when JIT is not wired (node 18 vs 24)", async () => {
    await expect(
      refineRunnerImageForEnv({
        pool: fakePool(),
        creation: undefined,
        context: ctx(),
        projectConfig: projectConfig([{ name: "node", version: "18" }]),
        orgId: "org_1",
      }),
    ).rejects.toBeInstanceOf(JitBuildRequiredError);
  });
});
