// The REAL Answerer-backed scheduled-audit pass runner (`createAnswererPassRunner`).
//
// Proves the runner composes the read-only repo index + the audit answerer, and —
// critically — that it indexes the repo at the PROJECT'S OWN `default_branch` (read
// per-job from the `projects` row), NOT a hardcoded `main`. Before this, the audit
// hardcoded `main`, so a repo whose real default is `develop`/`master`/etc. indexed
// a non-existent ref ⇒ no finding, no spec, and the audit loop retried forever.
// Also proves the §8a loud-fail discipline: a repo-less job and an unresolvable
// default branch are HARD failures, never a silent empty pass / a `main` fallback.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  createAnswererPassRunner,
  AuditJobNotProjectScopedError,
  AuditProjectDefaultBranchUnresolvableError,
  type AuditAnswerer,
  type AuditJob,
} from "../src/engine/forge/audits/index.js";
import type { RepoReader } from "../src/engine/forge/brownfield/index.js";

const fakeRepoReader: RepoReader = {
  index: async (repoUrl) => ({
    repoUrl,
    filesIndexed: 1,
    files: [{ path: "src/users.ts", size: 100, preview: "for (const u of users) { await db.find(u) }" }],
  }),
};

const fakeAuditAnswerer: AuditAnswerer = {
  audit: async () => ({
    findings: [{ externalId: "n-plus-1", title: "N+1 query", body: "batch it", severity: "P2" }],
  }),
};

// A secret store returning a fake token for the org's default github credential
// ref, so `resolveGithubToken` (static path) resolves without a real provider.
const fakeSecrets = {
  get: async (ref: string) => (ref === "gh/org" ? { value: "ghs_fake" } : undefined),
} as never;

// A repo stub whose `projects` row reports the given `default_branch` (the column
// is `NOT NULL DEFAULT 'main'`), so tests can drive a repo whose real default is
// `develop`/`master`/etc. and assert the audit indexes AT THAT branch, not `main`.
function repoStubQueryWith(defaultBranch: string | null) {
  return async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.includes("SELECT repo_url, default_branch, config FROM projects")) {
      return {
        rows: [{ repo_url: "https://github.com/cat-cave/app", default_branch: defaultBranch, config: {} }],
        rowCount: 1,
      };
    }
    if (sql.includes("SELECT config FROM organizations")) {
      // No App installation, an org-default static github credential ref.
      return { rows: [{ config: { version: 1, defaultCredentials: { github_token: "gh/org" } } }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
}

// Build a pool whose `projects` row carries `defaultBranch` (default greenfield `main`).
function repoStubPool(defaultBranch: string | null = "main"): pg.Pool {
  const query = repoStubQueryWith(defaultBranch);
  return {
    query,
    connect: async () => ({ query, release() {} }),
  } as unknown as pg.Pool;
}

function passRunnerJob(projectId: string | null): AuditJob {
  return {
    id: "audit_1",
    orgId: "org_a",
    projectId,
    kind: "perf",
    name: "perf",
    cadence: "nightly",
    targetWindow: "",
    answererCli: "",
    enabled: true,
    lastRun: null,
    findings: { count: 0, severity: "ok", note: "" },
  };
}

describe("createAnswererPassRunner", () => {
  it("indexes the repo read-only and returns the answerer's findings", async () => {
    const runner = createAnswererPassRunner({
      pool: repoStubPool(),
      secrets: fakeSecrets,
      githubHttp: {} as never,
      answererFactory: () => fakeAuditAnswerer,
      repoReaderFor: () => fakeRepoReader,
    });
    const result = await runner.run(passRunnerJob("project_a"));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.externalId).toBe("n-plus-1");
    expect(result.findings[0]!.severity).toBe("P2");
  });

  // The regression guard: a greenfield project (default branch `main`) indexes at `main`
  // — but because that branch comes from the project ROW, not a literal, a project on a
  // non-`main` default branch indexes at ITS branch. Before the fix the audit hardcoded
  // `main`, so a `develop`/`master` repo indexed an empty/non-existent ref ⇒ no finding,
  // no spec, and the audit loop retried forever.
  it("indexes at the project's OWN default branch (greenfield `main`), not a hardcoded literal", async () => {
    let indexedBranch: string | undefined;
    const runner = createAnswererPassRunner({
      pool: repoStubPool("main"),
      secrets: fakeSecrets,
      githubHttp: {} as never,
      answererFactory: () => fakeAuditAnswerer,
      repoReaderFor: (_repoUrl, defaultBranch) => {
        indexedBranch = defaultBranch;
        return fakeRepoReader;
      },
    });
    await runner.run(passRunnerJob("project_a"));
    expect(indexedBranch).toBe("main");
  });

  it("indexes a non-`main`-default repo at its real default branch (e.g. `develop`)", async () => {
    let indexedBranch: string | undefined;
    const runner = createAnswererPassRunner({
      pool: repoStubPool("develop"),
      secrets: fakeSecrets,
      githubHttp: {} as never,
      answererFactory: () => fakeAuditAnswerer,
      repoReaderFor: (_repoUrl, defaultBranch) => {
        indexedBranch = defaultBranch;
        return fakeRepoReader;
      },
    });
    const result = await runner.run(passRunnerJob("project_a"));
    // The repo was indexed at `develop` (NOT `main`), and the audit produced its finding.
    expect(indexedBranch).toBe("develop");
    expect(result.findings).toHaveLength(1);
  });

  it("LOUD-fails when the project's default branch is unresolvable — never falls back to `main`", async () => {
    const runner = createAnswererPassRunner({
      pool: repoStubPool("   "),
      secrets: fakeSecrets,
      githubHttp: {} as never,
      answererFactory: () => fakeAuditAnswerer,
      repoReaderFor: () => fakeRepoReader,
    });
    await expect(runner.run(passRunnerJob("project_a"))).rejects.toBeInstanceOf(
      AuditProjectDefaultBranchUnresolvableError,
    );
  });

  it("LOUD-fails for a repo-less (project-less) job — never a silent empty pass", async () => {
    const runner = createAnswererPassRunner({
      pool: repoStubPool(),
      secrets: fakeSecrets,
      githubHttp: {} as never,
      answererFactory: () => fakeAuditAnswerer,
      repoReaderFor: () => fakeRepoReader,
    });
    await expect(runner.run(passRunnerJob(null))).rejects.toBeInstanceOf(AuditJobNotProjectScopedError);
  });
});
