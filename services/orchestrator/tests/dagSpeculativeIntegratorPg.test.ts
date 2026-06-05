// focused unit test of `PgSpeculativeIntegrator`'s VcsProvider driving +
// ancestor-branch resolution, over a FAKE pool + FAKE VcsProvider (test fixtures —
// they live here, never src/). It proves the integrator resolves each unmerged
// ancestor's run branch under the project org, orders them in the caller's DAG
// order, and drives `VcsProvider.buildIntegrationBranch` with the project's
// default_branch as the base — surfacing an integrated branch or the conflict pair
// unchanged. The full RLS/credential resolution is integration-tested live.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgSpeculativeIntegrator } from "../src/engine/dag/speculativeIntegrator.js";
import type {
  BuildIntegrationBranchInput,
  BuildIntegrationBranchResult,
  RepoRef,
  ResolvedVcsToken,
  VcsCredentialContext,
  VcsProvider,
} from "../src/engine/contracts/vcsProvider.js";

const ORG = "org_1";
const PROJECT = "project_1";

/** A fake pg pool that routes on SQL fragments to canned rows (covers connect()). */
class FakePool {
  async connect(): Promise<FakeClient> {
    return new FakeClient();
  }
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    return new FakeClient().query(sql, params);
  }
}

class FakeClient {
  async query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }> {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (
      text.startsWith("BEGIN") ||
      text.startsWith("SET LOCAL") ||
      text.startsWith("COMMIT") ||
      text.startsWith("ROLLBACK")
    ) {
      return { rows: [] };
    }
    // resolveProjectOrg + the org guard reads.
    if (text.includes("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: ORG }] };
    }
    // loadProject: repo + default_branch + configs.
    if (text.includes("FROM projects p") && text.includes("default_branch")) {
      return {
        rows: [
          {
            repo_url: "https://github.com/cat-cave/apex",
            default_branch: "main",
            project_config: { version: 1, credentials: { githubCredentialRef: "credential/github/project" } },
            org_config: { version: 1 },
            org_id: ORG,
          },
        ],
      };
    }
    // loadAncestorBranches: one branch per ancestor spec.
    if (text.includes("FROM runs r") && text.includes("DISTINCT ON")) {
      const ids = (params?.[0] as string[]) ?? [];
      return { rows: ids.map((specId) => ({ spec_id: specId, branch: `tanren/${specId}` })) };
    }
    // resolveCredentialsForRun reads organizations.config.
    if (text.includes("SELECT config FROM organizations")) {
      return { rows: [{ config: { version: 1 } }] };
    }
    throw new Error(`unexpected query: ${text}`);
  }
  release(): void {}
}

class FakeVcsProvider implements Partial<VcsProvider> {
  lastInput?: BuildIntegrationBranchInput;
  constructor(private readonly mode: "ok" | "conflict") {}
  async resolveToken(_creds: VcsCredentialContext): Promise<ResolvedVcsToken> {
    return { token: "t", source: "static", refresh: async () => "t2" };
  }
  parseRepository(repoUrl: string): RepoRef {
    const m = /github\.com\/([^/]+)\/([^/]+)/u.exec(repoUrl)!;
    return { owner: m[1]!, name: m[2]! };
  }
  async buildIntegrationBranch(input: BuildIntegrationBranchInput): Promise<BuildIntegrationBranchResult> {
    this.lastInput = input;
    if (this.mode === "conflict") {
      return {
        outcome: "conflict",
        integrationBranch: input.integrationBranch,
        mergedAncestors: [input.ancestors[0]!.specId],
        conflictBetween: { specId: input.ancestors[1]!.specId, otherSpecId: input.ancestors[0]!.specId },
        message: "conflict",
      };
    }
    return {
      outcome: "integrated",
      integrationBranch: input.integrationBranch,
      mergedAncestors: input.ancestors.map((a) => a.specId),
      message: "ok",
    };
  }
}

function makeIntegrator(vcs: FakeVcsProvider): PgSpeculativeIntegrator {
  return new PgSpeculativeIntegrator({
    pool: new FakePool() as unknown as pg.Pool,
    vcsProvider: vcs as unknown as VcsProvider,
    secrets: new InMemorySecretStore(),
  });
}

describe("PgSpeculativeIntegrator", () => {
  it("drives buildIntegrationBranch with default_branch base + DAG-ordered ancestor branches", async () => {
    const vcs = new FakeVcsProvider("ok");
    const integrator = makeIntegrator(vcs);
    const result = await integrator.buildIntegration({
      projectId: PROJECT,
      dependentSpecId: "spec_c",
      unmergedAncestorSpecIds: ["spec_a", "spec_b"],
    });

    expect(result.outcome).toBe("integrated");
    expect(result.integrationBranch).toBe("tanren/integ/spec_c");
    expect(vcs.lastInput?.baseBranch).toBe("main");
    expect(vcs.lastInput?.integrationBranch).toBe("tanren/integ/spec_c");
    expect(vcs.lastInput?.ancestors).toEqual([
      { specId: "spec_a", branch: "tanren/spec_a" },
      { specId: "spec_b", branch: "tanren/spec_b" },
    ]);
  });

  it("returns the ancestor-vs-ancestor conflict pair unchanged (does not throw)", async () => {
    const vcs = new FakeVcsProvider("conflict");
    const integrator = makeIntegrator(vcs);
    const result = await integrator.buildIntegration({
      projectId: PROJECT,
      dependentSpecId: "spec_c",
      unmergedAncestorSpecIds: ["spec_a", "spec_b"],
    });
    expect(result.outcome).toBe("conflict");
    expect(result.conflictBetween).toEqual({ specId: "spec_b", otherSpecId: "spec_a" });
  });
});
