import type pg from "pg";
import { describe, expect, it } from "vitest";
import { migrateProjectConfig } from "../src/engine/config/index.js";
import { MissingCredentialError, resolveCredentialsForRun } from "../src/engine/credentials/resolveCredentials.js";

/**
 * Minimal pg.Pool stub for the single org-config read the resolver performs.
 * `config` is whatever the named org row carries (raw JSONB), so a test can
 * exercise legacy `{}` rows, rows with `defaultCredentials`, and missing rows.
 */
function fakePool(orgs: Record<string, unknown>): Pick<pg.Pool, "query"> {
  return {
    query: (async (_sql: string, params: unknown[]) => {
      const orgId = params[0] as string;
      const config = orgs[orgId];
      return config === undefined ? { rows: [], rowCount: 0 } : { rows: [{ config }], rowCount: 1 };
    }) as unknown as pg.Pool["query"],
  };
}

const codexProjectRef = "credential/codex/org/org_1/project";
const githubProjectRef = "credential/github/org/org_1/project";
const codexOrgRef = "credential/codex/org/org_1/default";
const githubOrgRef = "credential/github/org/org_1/default";

describe("resolveCredentialsForRun", () => {
  it("prefers project config over the org default", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { codex_chatgpt_auth: codexOrgRef, github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { codexCredentialRef: codexProjectRef, githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
    expect(resolved).toEqual({
      codexCredentialRef: codexProjectRef,
      githubCredentialRef: githubProjectRef,
    });
  });

  it("falls back to the org default when project config omits a kind", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { codex_chatgpt_auth: codexOrgRef, github_token: githubOrgRef },
      },
    });
    // Project binds only the GitHub ref; Codex inherits the org default.
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
    expect(resolved).toEqual({
      codexCredentialRef: codexOrgRef,
      githubCredentialRef: githubProjectRef,
    });
  });

  it("lets an explicit override win over both project config and org default", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { codex_chatgpt_auth: codexOrgRef, github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { codexCredentialRef: codexProjectRef, githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, {
      projectConfig,
      orgId: "org_1",
      override: {
        codexCredentialRef: "credential/codex/me/pin",
        githubCredentialRef: "credential/github/me/pin",
      },
    });
    expect(resolved).toEqual({
      codexCredentialRef: "credential/codex/me/pin",
      githubCredentialRef: "credential/github/me/pin",
    });
  });

  it("resolves from org defaults when the project binds nothing (legacy row)", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { codex_chatgpt_auth: codexOrgRef, github_token: githubOrgRef },
      },
    });
    // A Phase-1 fixture project: plain `{}` config, no credentials key.
    const projectConfig = migrateProjectConfig({});
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
    expect(resolved).toEqual({
      codexCredentialRef: codexOrgRef,
      githubCredentialRef: githubOrgRef,
    });
  });

  it("throws MissingCredentialError naming the unresolved kind (github)", async () => {
    const pool = fakePool({
      org_1: { version: 1, defaultCredentials: { codex_chatgpt_auth: codexOrgRef } },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });
    await expect(resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" })).rejects.toMatchObject({
      name: "MissingCredentialError",
      kind: "github_token",
    });
  });

  it("throws MissingCredentialError for codex first when both are unresolved", async () => {
    const pool = fakePool({ org_1: { version: 1 } });
    const projectConfig = migrateProjectConfig({ version: 1 });
    let caught: unknown;
    try {
      await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingCredentialError);
    expect((caught as MissingCredentialError).kind).toBe("codex_chatgpt_auth");
  });

  it("treats a missing org row as no defaults (project config still resolves)", async () => {
    const pool = fakePool({});
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { codexCredentialRef: codexProjectRef, githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "ghost" });
    expect(resolved).toEqual({
      codexCredentialRef: codexProjectRef,
      githubCredentialRef: githubProjectRef,
    });
  });

  it("ignores blank/whitespace refs and falls through to the next layer", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { codex_chatgpt_auth: codexOrgRef, github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });
    const resolved = await resolveCredentialsForRun(pool, {
      projectConfig,
      orgId: "org_1",
      override: { codexCredentialRef: "   " },
    });
    expect(resolved.codexCredentialRef).toBe(codexOrgRef);
  });
});
