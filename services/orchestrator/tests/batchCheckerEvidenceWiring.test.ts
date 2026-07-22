import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { PgBatchChecker, resolveGithubStaticRef, resolveGovernancePosture } from "../src/engine/merge/batchChecker.js";

function rows(values: readonly Record<string, unknown>[]) {
  return { rows: [...values], rowCount: values.length };
}

class BatchCheckerPool {
  constructor(
    private readonly orgId: string | null = "org_mq12",
    private readonly hasProject = true,
    private readonly hasBranch = true,
    private readonly hasProjectCredential = false,
  ) {}

  async connect() {
    return {
      query: async (sql: string) => {
        const statement = sql.replaceAll(/\s+/gu, " ").trim();
        if (statement === "BEGIN" || statement === "COMMIT" || statement === "ROLLBACK") return rows([]);
        if (statement.startsWith("SET LOCAL app.current_org_id")) return rows([]);
        if (statement === "SELECT org_id FROM projects WHERE project_id = $1") return rows([{ org_id: this.orgId }]);
        if (statement.includes("FROM projects p")) {
          return this.hasProject
            ? rows([
                {
                  repo_url: "https://github.com/acme/app.git",
                  default_branch: "main",
                  runner_image: null,
                  project_config: this.hasProjectCredential
                    ? { version: 1, credentials: { githubCredentialRef: "project" } }
                    : { version: 1 },
                  org_config: null,
                },
              ])
            : rows([]);
        }
        if (statement.includes("FROM runs r")) {
          return this.hasBranch
            ? rows([{ run_id: "run_mq12", spec_id: "spec_mq12", branch: "tanren/spec_mq12" }])
            : rows([]);
        }
        if (statement.includes("FROM behavior_verification_runs")) {
          return rows([{ id: "behavior_run_passing", status: "completed" }]);
        }
        if (statement.includes("FROM behavior_verdicts")) return rows([]);
        if (statement.includes("FROM quarantined_tests")) return rows([]);
        throw new Error(`unexpected query: ${statement}`);
      },
      release() {},
    } as never;
  }

  asPgPool() {
    return this as never;
  }
}

function checker(
  pool: BatchCheckerPool,
  credentials: { githubHttp?: unknown; secrets?: unknown } = {},
): PgBatchChecker {
  return new PgBatchChecker({
    pool: pool.asPgPool(),
    githubHttp: (credentials.githubHttp ?? {}) as never,
    secrets: (credentials.secrets ?? {}) as never,
    allocator: {} as never,
    ssh: {} as never,
    identitySecretRef: "identity/mq12",
    runStateWriter: {} as never,
  });
}

describe("PgBatchChecker mq-12 credential and policy boundaries", () => {
  it("keeps unreadable governance configuration at the strict posture", () => {
    expect(resolveGovernancePosture({})).toBe("strict");
  });

  it("binds a project credential to its org and falls back only to a valid org default", () => {
    expect(
      resolveGithubStaticRef({ version: 1, credentials: { githubCredentialRef: "github-project" } }, null, "org_mq12"),
    ).toContain("org_mq12");
    expect(
      resolveGithubStaticRef({}, { version: 1, defaultCredentials: { github_token: "github-default" } }, "org_mq12"),
    ).toContain("org_mq12");
  });

  it("propagates corrupt project configuration instead of switching identities", () => {
    expect(() => resolveGithubStaticRef({ version: 0 }, { version: 1 }, "org_mq12")).toThrow(/unknown config version/u);
  });

  it("fails before integration when a batch has no organization, project, or run branch", async () => {
    const entry = [{ runId: "run_mq12", specId: "spec_mq12" }] as never;

    await expect(
      checker(new BatchCheckerPool(null)).checkBatch({ projectId: "project_mq12", entries: entry }),
    ).rejects.toThrow(/project has no org/u);
    await expect(
      checker(new BatchCheckerPool("org_mq12", false)).checkBatch({ projectId: "project_mq12", entries: entry }),
    ).rejects.toThrow(/project project_mq12 not found/u);
    await expect(
      checker(new BatchCheckerPool("org_mq12", true, false)).checkBatch({ projectId: "project_mq12", entries: entry }),
    ).rejects.toThrow(/has no run branch/u);
  });

  it("accepts the empty bisect lower bound without provisioning F2 evidence or a runner", async () => {
    await expect(
      checker(new BatchCheckerPool()).checkBatch({ projectId: "project_mq12", entries: [] }),
    ).resolves.toEqual({
      result: "pass",
      integrationBranch: "",
    });
  });

  it("does not throw or produce a behavior failure for a completed passing batch behavior run", async () => {
    // Exercise the production caller, not just the resolver: a completed run with
    // no decisive failed verdict is the ordinary passing-batch case. Its optional
    // coordinate must be absent, so it cannot become a false behavior_failed event.
    const batchChecker = checker(new BatchCheckerPool());
    const resolveBatchBehaviorFailure = (
      batchChecker as unknown as {
        resolveBatchBehaviorFailure: (
          orgId: string,
          entries: ReadonlyArray<{ readonly runId: string; readonly specId: string; readonly branch: string }>,
        ) => Promise<unknown>;
      }
    ).resolveBatchBehaviorFailure;

    await expect(
      resolveBatchBehaviorFailure.call(batchChecker, "org_mq12", [
        { runId: "run_mq12", specId: "spec_mq12", branch: "tanren/spec_mq12" },
      ]),
    ).resolves.toBeNull();
  });

  it("propagates an unreadable default-branch ref after resolving only the project-bound credential", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_mq12/project", value: "token_mq12" });
    const githubHttp = {
      async request() {
        return { status: 503, body: { message: "GitHub unavailable" } };
      },
    };

    await expect(
      checker(new BatchCheckerPool("org_mq12", true, true, true), { githubHttp, secrets }).checkBatch({
        projectId: "project_mq12",
        entries: [{ runId: "run_mq12", specId: "spec_mq12" }] as never,
      }),
    ).rejects.toThrow(/GitHub ref read for main failed: HTTP 503/u);
  });

  it("returns a retriable hold when the authenticated default branch is absent", async () => {
    const secrets = new FakeSecretStore();
    await secrets.put({ ref: "credential/github/org/org_mq12/project", value: "token_mq12" });

    await expect(
      checker(new BatchCheckerPool("org_mq12", true, true, true), {
        secrets,
        githubHttp: {
          async request() {
            return { status: 404, body: {} };
          },
        },
      }).checkBatch({ projectId: "project_mq12", entries: [{ runId: "run_mq12", specId: "spec_mq12" }] as never }),
    ).resolves.toMatchObject({ result: "infra-error", retriable: true });
  });
});
