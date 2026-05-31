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
      providerMode: "byok",
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
      providerMode: "byok",
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
      providerMode: "byok",
    });
  });

  it("resolves from org defaults when the project binds nothing (legacy row)", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { codex_chatgpt_auth: codexOrgRef, github_token: githubOrgRef },
      },
    });
    // A project with a bare V1 config and no credentials key.
    const projectConfig = migrateProjectConfig({ version: 1 });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
    expect(resolved).toEqual({
      codexCredentialRef: codexOrgRef,
      githubCredentialRef: githubOrgRef,
      providerMode: "byok",
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
      providerMode: "byok",
    });
  });

  it("names Codex vs GitHub in the MissingCredentialError message", async () => {
    const codexMissing = new MissingCredentialError("codex_chatgpt_auth");
    expect(codexMissing.message).toContain("Codex credential");
    expect(codexMissing.kind).toBe("codex_chatgpt_auth");
    const githubMissing = new MissingCredentialError("github_token");
    expect(githubMissing.message).toContain("GitHub credential");
    expect(githubMissing.kind).toBe("github_token");
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

  // SaaS Tier-B #5: BYOK-vs-managed provider seam. These assert OUTCOMES — the
  // resolved LLM credential ref + the endpoint override — not mock calls.
  describe("managed provider mode", () => {
    const platformRef = "credential/openrouter/platform/default";

    it("resolves the PLATFORM credential + managed endpoint when the org is managed", async () => {
      const pool = fakePool({
        org_1: {
          version: 1,
          providerMode: "managed",
          defaultCredentials: { codex_chatgpt_auth: codexOrgRef, github_token: githubOrgRef },
        },
      });
      const projectConfig = migrateProjectConfig({ version: 1 });
      const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
      expect(resolved.providerMode).toBe("managed");
      // The tenant's own codex default is NOT used — the platform ref is.
      expect(resolved.codexCredentialRef).toBe(platformRef);
      expect(resolved.codexCredentialRef).not.toBe(codexOrgRef);
      // GitHub stays the tenant's own credential.
      expect(resolved.githubCredentialRef).toBe(githubOrgRef);
      // The harness is pointed at the OpenRouter OpenAI-compatible endpoint.
      expect(resolved.endpointOverride).toEqual({ baseUrl: "https://openrouter.ai/api/v1" });
    });

    it("honors an org managedProvider override of ref + endpoint", async () => {
      const pool = fakePool({
        org_1: {
          version: 1,
          providerMode: "managed",
          managedProvider: { credentialRef: "credential/openrouter/platform/eu", endpoint: "https://eu.openrouter/v1" },
          defaultCredentials: { github_token: githubOrgRef },
        },
      });
      const resolved = await resolveCredentialsForRun(pool, {
        projectConfig: migrateProjectConfig({ version: 1 }),
        orgId: "org_1",
      });
      expect(resolved.codexCredentialRef).toBe("credential/openrouter/platform/eu");
      expect(resolved.endpointOverride).toEqual({ baseUrl: "https://eu.openrouter/v1" });
    });

    it("lets a project override the org's byok default into managed", async () => {
      const pool = fakePool({
        org_1: { version: 1, providerMode: "byok", defaultCredentials: { github_token: githubOrgRef } },
      });
      const projectConfig = migrateProjectConfig({ version: 1, providerMode: "managed" });
      const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
      expect(resolved.providerMode).toBe("managed");
      expect(resolved.codexCredentialRef).toBe(platformRef);
    });

    it("lets a project pin back to byok over a managed org default", async () => {
      const pool = fakePool({
        org_1: {
          version: 1,
          providerMode: "managed",
          defaultCredentials: { codex_chatgpt_auth: codexOrgRef, github_token: githubOrgRef },
        },
      });
      const projectConfig = migrateProjectConfig({ version: 1, providerMode: "byok" });
      const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
      expect(resolved.providerMode).toBe("byok");
      expect(resolved.codexCredentialRef).toBe(codexOrgRef);
      expect(resolved.endpointOverride).toBeUndefined();
    });

    it("an explicit codex override forces byok even under a managed org", async () => {
      const pool = fakePool({
        org_1: { version: 1, providerMode: "managed", defaultCredentials: { github_token: githubOrgRef } },
      });
      const resolved = await resolveCredentialsForRun(pool, {
        projectConfig: migrateProjectConfig({ version: 1 }),
        orgId: "org_1",
        override: { codexCredentialRef: "credential/codex/me/pin" },
      });
      expect(resolved.providerMode).toBe("byok");
      expect(resolved.codexCredentialRef).toBe("credential/codex/me/pin");
      expect(resolved.endpointOverride).toBeUndefined();
    });

    it("never throws MissingCredentialError for the LLM kind in managed mode", async () => {
      // No codex default anywhere; managed mode resolves the platform ref instead.
      const pool = fakePool({
        org_1: { version: 1, providerMode: "managed", defaultCredentials: { github_token: githubOrgRef } },
      });
      const resolved = await resolveCredentialsForRun(pool, {
        projectConfig: migrateProjectConfig({ version: 1 }),
        orgId: "org_1",
      });
      expect(resolved.codexCredentialRef).toBe(platformRef);
    });
  });
});
