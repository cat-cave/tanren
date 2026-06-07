import type pg from "pg";
import { describe, expect, it } from "vitest";
import { migrateProjectConfig } from "../src/engine/config/index.js";
import {
  MissingCredentialError,
  OrgProviderModeUnresolved,
  resolveCredentialsForRun,
} from "../src/engine/credentials/resolveCredentials.js";

/**
 * Minimal pg.Pool stub for the single org-config read the resolver performs.
 * `config` is whatever the named org row carries (raw JSONB), so a test can
 * exercise bare `version:1` rows, rows with `defaultCredentials`, and missing rows.
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

/** The default LLM routing entry shape stored under `defaultLlm`. */
function codexEntry(authRef: string) {
  return { cli: "codex", model: "default", authRef };
}

describe("resolveCredentialsForRun", () => {
  it("prefers project config over the org default", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { defaultLlm: codexEntry(codexProjectRef), githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
    expect(resolved).toEqual({
      defaultLlm: codexEntry(codexProjectRef),
      githubCredentialRef: githubProjectRef,
      providerMode: "byok",
    });
  });

  it("falls back to the org default when project config omits a kind", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    // Project binds only the GitHub ref; the default LLM inherits the org default.
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
    expect(resolved).toEqual({
      defaultLlm: codexEntry(codexOrgRef),
      githubCredentialRef: githubProjectRef,
      providerMode: "byok",
    });
  });

  it("lets an explicit GitHub override win over both project config and org default", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { defaultLlm: codexEntry(codexProjectRef), githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, {
      projectConfig,
      orgId: "org_1",
      override: { githubCredentialRef: "credential/github/me/pin" },
    });
    expect(resolved).toEqual({
      defaultLlm: codexEntry(codexProjectRef),
      githubCredentialRef: "credential/github/me/pin",
      providerMode: "byok",
    });
  });

  it("resolves from org defaults when the project binds nothing", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    // A project with no bound credentials key (bare version:1 config).
    const projectConfig = migrateProjectConfig({ version: 1 });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
    expect(resolved).toEqual({
      defaultLlm: codexEntry(codexOrgRef),
      githubCredentialRef: githubOrgRef,
      providerMode: "byok",
    });
  });

  it("throws MissingCredentialError naming the unresolved kind (github)", async () => {
    const pool = fakePool({
      org_1: { version: 1, defaultCredentials: { defaultLlm: codexEntry(codexOrgRef) } },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });
    await expect(resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" })).rejects.toMatchObject({
      name: "MissingCredentialError",
      kind: "github_token",
    });
  });

  it("throws MissingCredentialError for the default LLM first when both are unresolved", async () => {
    const pool = fakePool({ org_1: { version: 1 } });
    const projectConfig = migrateProjectConfig({ version: 1 });
    let caught: unknown;
    try {
      await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MissingCredentialError);
    expect((caught as MissingCredentialError).kind).toBe("llm_default");
  });

  it("THROWS OrgProviderModeUnresolved when a NON-EMPTY org id reads back no row (scoping/denial bug, not 'no config')", async () => {
    const pool = fakePool({});
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { defaultLlm: codexEntry(codexProjectRef), githubCredentialRef: githubProjectRef },
    });
    let caught: unknown;
    try {
      await resolveCredentialsForRun(pool, { projectConfig, orgId: "ghost" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(OrgProviderModeUnresolved);
    expect((caught as OrgProviderModeUnresolved).orgId).toBe("ghost");
  });

  it("treats an EMPTY org id ('') with no row as no defaults — the project-config-only path", async () => {
    const pool = fakePool({});
    const projectConfig = migrateProjectConfig({
      version: 1,
      credentials: { defaultLlm: codexEntry(codexProjectRef), githubCredentialRef: githubProjectRef },
    });
    const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "" });
    expect(resolved).toEqual({
      defaultLlm: codexEntry(codexProjectRef),
      githubCredentialRef: githubProjectRef,
      providerMode: "byok",
    });
  });

  it("names the default LLM vs GitHub in the MissingCredentialError message", async () => {
    const llmMissing = new MissingCredentialError("llm_default");
    expect(llmMissing.message).toContain("default LLM");
    expect(llmMissing.kind).toBe("llm_default");
    const githubMissing = new MissingCredentialError("github_token");
    expect(githubMissing.message).toContain("GitHub credential");
    expect(githubMissing.kind).toBe("github_token");
  });

  it("ignores blank/whitespace GitHub override refs and falls through to the next layer", async () => {
    const pool = fakePool({
      org_1: {
        version: 1,
        defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
      },
    });
    const projectConfig = migrateProjectConfig({ version: 1 });
    const resolved = await resolveCredentialsForRun(pool, {
      projectConfig,
      orgId: "org_1",
      override: { githubCredentialRef: "   " },
    });
    expect(resolved.githubCredentialRef).toBe(githubOrgRef);
  });

  // SaaS Tier-B #5: BYOK-vs-managed provider seam. These assert OUTCOMES — the
  // resolved default LLM entry + the endpoint override — not mock calls.
  describe("managed provider mode", () => {
    const platformRef = "credential/openrouter/platform/default";

    it("resolves the PLATFORM credential + managed endpoint when the org is managed", async () => {
      const pool = fakePool({
        org_1: {
          version: 1,
          providerMode: "managed",
          defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
        },
      });
      const projectConfig = migrateProjectConfig({ version: 1 });
      const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
      expect(resolved.providerMode).toBe("managed");
      // The tenant's own default LLM is NOT used — the platform ref is.
      expect(resolved.defaultLlm).toEqual(codexEntry(platformRef));
      expect(resolved.defaultLlm.authRef).not.toBe(codexOrgRef);
      // GitHub stays the tenant's own credential.
      expect(resolved.githubCredentialRef).toBe(githubOrgRef);
      // The harness is pointed at the OpenRouter OpenAI-compatible endpoint.
      expect(resolved.endpointOverride).toEqual({ baseUrl: "https://openrouter.ai/api/v1" });
    });

    it("lets a project override the org's byok default into managed", async () => {
      const pool = fakePool({
        org_1: { version: 1, providerMode: "byok", defaultCredentials: { github_token: githubOrgRef } },
      });
      const projectConfig = migrateProjectConfig({ version: 1, providerMode: "managed" });
      const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
      expect(resolved.providerMode).toBe("managed");
      expect(resolved.defaultLlm.authRef).toBe(platformRef);
    });

    it("lets a project pin back to byok over a managed org default", async () => {
      const pool = fakePool({
        org_1: {
          version: 1,
          providerMode: "managed",
          defaultCredentials: { defaultLlm: codexEntry(codexOrgRef), github_token: githubOrgRef },
        },
      });
      const projectConfig = migrateProjectConfig({ version: 1, providerMode: "byok" });
      const resolved = await resolveCredentialsForRun(pool, { projectConfig, orgId: "org_1" });
      expect(resolved.providerMode).toBe("byok");
      expect(resolved.defaultLlm).toEqual(codexEntry(codexOrgRef));
      expect(resolved.endpointOverride).toBeUndefined();
    });

    it("never throws MissingCredentialError for the LLM kind in managed mode", async () => {
      // No default LLM anywhere; managed mode resolves the platform ref instead.
      const pool = fakePool({
        org_1: { version: 1, providerMode: "managed", defaultCredentials: { github_token: githubOrgRef } },
      });
      const resolved = await resolveCredentialsForRun(pool, {
        projectConfig: migrateProjectConfig({ version: 1 }),
        orgId: "org_1",
      });
      expect(resolved.defaultLlm.authRef).toBe(platformRef);
    });
  });
});
