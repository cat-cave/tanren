/**
 * Former-bug proofs for IN-1 Slice 1 P0/P1 convergence redrive.
 * Production HTTP/authority composition — no SQL-string cosplay claims.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { integrationCatalogRevision } from "../src/engine/contracts/integrationCatalog.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import {
  SentryPrincipalVerifier,
  SlackPrincipalVerifier,
  VercelPrincipalVerifier,
} from "../src/engine/integrations/principalVerifiers.js";
import { PgIntegrationAuthority } from "../src/engine/integrations/integrationAuthorityImpl.js";
import { IntegrationMemoryDb } from "./helpers/integrationMemoryDb.js";
import { secretValueForLease } from "../src/engine/repositories/integrationConnectionResolve.js";
import { testOrgGrant, testPrincipalVerificationPermit } from "./helpers/orgGrant.js";

const SRC_ROOT = resolve(import.meta.dirname, "../src");

function readSrc(rel: string): string {
  return readFileSync(resolve(SRC_ROOT, rel), "utf8");
}

describe("IN-1 P0 convergence — former-bug proofs", () => {
  it("authorityWrites splits reserve → Vault → activate (no secrets under withOrgScope finalize)", () => {
    const writes = readSrc("routes/integrations/authorityWrites.ts");
    const saga = readSrc("routes/integrations/linkSaga.ts");
    expect(writes).toContain("runDurableLinkSaga");
    expect(saga).toContain("finalizeReservedSecret");
    expect(saga).toContain("reserveVerifiedLink");
    expect(saga).toContain("activateReservedLink");
    // Must not call finalizeVerifiedLink inside a single withOrgScope (Vault-in-TX bug).
    expect(`${writes}\n${saga}`).not.toMatch(/withOrgScope\([^)]*finalizeVerifiedLink/u);
    const finalize = readSrc("engine/repositories/integrationConnectionFinalize.ts");
    const activate = readSrc("engine/repositories/integrationConnectionActivate.ts");
    expect(activate).toContain("ON CONFLICT (org_id, provider_kind, connection_id, generation) DO NOTHING");
    expect(`${finalize}\n${activate}`).not.toMatch(
      /ON CONFLICT \(org_id, provider_kind, connection_id, generation\) DO UPDATE/u,
    );
  });

  it("production provider paths do not bypass authorizeOperation with naked grant resolve", () => {
    // Deleted dual authority surfaces must stay gone from production src.
    expect(() =>
      readFileSync(resolve(SRC_ROOT, "engine/repositories/integrationConnectionResolve.ts"), "utf8"),
    ).not.toThrow();
    const resolveSrc = readSrc("engine/repositories/integrationConnectionResolve.ts");
    expect(resolveSrc).not.toContain("export async function resolveExactControlGrant");
    expect(resolveSrc).not.toContain("issueEligibleOperationLease");

    const demo = readSrc("engine/postMerge/demoOnDeploy.ts");
    expect(demo).toContain("authorizeOperation");
    expect(demo).not.toContain("candidates[0]");
    expect(demo).not.toContain("issueEligibleOperationLease");

    const greenfieldAuth = readSrc("routes/projects/greenfieldDeployAuthority.ts");
    expect(greenfieldAuth).toContain("authorizeGreenfieldDeploy");
    expect(greenfieldAuth).not.toMatch(/candidates\[0\]/u);

    // Durable derivation receipts own provisioned apps after the project shell
    // exists. A late compensation destroy path would violate replay ownership.
    expect(() => readSrc("routes/projects/greenfieldDeployDestroy.ts")).toThrow(/ENOENT/u);

    // Integration provisioner token paths must use secretValueForLease / getExact.
    for (const rel of [
      "engine/providers/sentryProvisioner.ts",
      "engine/integrations/slack/slackProvisioner.ts",
      "engine/provisioners/deployProvisioner.ts",
    ]) {
      const text = readSrc(rel);
      expect(text).toMatch(/secretValueFor(?:Lease|DeployOperation)/u);
      expect(text).not.toMatch(/secrets\.get\(\s*grant\.eligibleOperation\.credentialRef/u);
    }
  });

  it("sole-account without project selection returns selection_required (never guesses)", async () => {
    const db = new IntegrationMemoryDb();
    db.seedProject("proj-1", "org-1");
    // Seed one active slack connection+grant with verified scopes.
    db.connections.push({
      id: "c1",
      org_id: "org-1",
      provider_kind: "slack",
      provider_principal_id: "T1",
      principal_kind: "team",
      display_name: "Team",
      principal_metadata: {},
      health: "healthy",
      status: "active",
      current_auth_generation: 1,
      owner_id: "admin",
    });
    db.authGenerations.push({
      org_id: "org-1",
      provider_kind: "slack",
      connection_id: "c1",
      generation: 1,
      credential_ref: "secret://org/org-1/integration/slack/connection/c1/token/g/1",
      auth_kind: "bot_token",
      expires_at: null,
      status: "active",
    });
    db.grants.push({
      id: "g1",
      org_id: "org-1",
      provider_kind: "slack",
      connection_id: "c1",
      plane: "control",
      environment: "control",
      current_generation: 1,
      status: "active",
    });
    db.grantGenerations.push({
      org_id: "org-1",
      provider_kind: "slack",
      connection_id: "c1",
      grant_id: "g1",
      generation: 1,
      capabilities: ["notify"],
      operations: ["discover", "provision", "bind"],
      provider_scopes: ["chat:write", "channels:read", "channels:manage", "channels:join"],
      policy_revision: integrationCatalogRevision(),
      consent_revision: "consent.test",
      status: "active",
      expires_at: null,
    });

    const authority = new PgIntegrationAuthority();
    const result = await authority.authorizeOperation(db.clientForOrg("org-1"), {
      orgId: "org-1",
      projectId: "proj-1",
      providerKind: "slack",
      capability: "notify",
      operation: "provision",
      target: { projectName: "proj-1", orgSlug: "org-1" },
      actor: { kind: "operator", id: "admin" },
    });
    expect(result.status).toBe("selection_required");
    if (result.status !== "selection_required") return;
    expect(result.reason).toBe("selection_missing");
    expect(result.candidates).toHaveLength(1);
  });

  it("zero eligible is ineligible; selected-but-ineligible alone is selected_grant_unavailable", async () => {
    const db = new IntegrationMemoryDb();
    db.seedProject("proj-1", "org-1");
    db.connections.push({
      id: "c-bad",
      org_id: "org-1",
      provider_kind: "slack",
      provider_principal_id: "T-bad",
      principal_kind: "team",
      display_name: "Degraded Team",
      principal_metadata: {},
      health: "degraded",
      status: "active",
      current_auth_generation: 1,
      owner_id: "admin",
    });
    db.authGenerations.push({
      org_id: "org-1",
      provider_kind: "slack",
      connection_id: "c-bad",
      generation: 1,
      credential_ref: "secret://org/org-1/integration/slack/connection/c-bad/token/g/1",
      auth_kind: "bot_token",
      expires_at: null,
      status: "active",
    });
    db.grants.push({
      id: "g-bad",
      org_id: "org-1",
      provider_kind: "slack",
      connection_id: "c-bad",
      plane: "control",
      environment: "control",
      current_generation: 1,
      status: "active",
    });
    db.grantGenerations.push({
      org_id: "org-1",
      provider_kind: "slack",
      connection_id: "c-bad",
      grant_id: "g-bad",
      generation: 1,
      capabilities: ["notify"],
      operations: ["provision"],
      provider_scopes: [],
      policy_revision: integrationCatalogRevision(),
      consent_revision: "consent.test",
      status: "active",
      expires_at: null,
    });
    const authority = new PgIntegrationAuthority();
    const input = {
      orgId: "org-1",
      projectId: "proj-1",
      providerKind: "slack",
      capability: "notify",
      operation: "provision",
      target: { projectName: "proj-1", orgSlug: "org-1" },
      actor: { kind: "operator" as const, id: "admin" },
    };
    const unselected = await authority.authorizeOperation(db.clientForOrg("org-1"), input);
    expect(unselected).toMatchObject({
      status: "ineligible",
      reasons: expect.arrayContaining(["connection_health_degraded", "missing_scope:channels:manage"]),
    });

    db.selections.push({
      org_id: "org-1",
      project_id: "proj-1",
      provider_kind: "slack",
      connection_id: "c-bad",
      auth_generation: 1,
      grant_id: "g-bad",
      grant_generation: 1,
      selected_by: "admin",
    });
    const selected = await authority.authorizeOperation(db.clientForOrg("org-1"), input);
    expect(selected).toMatchObject({
      status: "selection_required",
      reason: "selected_grant_unavailable",
      candidates: [{ connectionId: "c-bad" }],
    });
    db.selections[0]!.auth_generation = 99;
    const stale = await authority.authorizeOperation(db.clientForOrg("org-1"), input);
    expect(stale).toMatchObject({
      status: "selection_required",
      reason: "selected_grant_unavailable",
      candidates: [{ ineligibilityReasons: expect.arrayContaining(["selected_generation_stale"]) }],
    });
  });

  it("Slack verified scopes make notify operations eligible; empty scopes fail", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-slack", "xoxb-token");
    const permit = await testPrincipalVerificationPermit({ providerKind: "slack", operationId: "op-slack" });
    const fetchWithScopes = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true, team_id: "T1", team: "Acme", user_id: "U1" }), {
          status: 200,
          headers: { "content-type": "application/json", "x-oauth-scopes": "channels:read,channels:manage" },
        }),
    );
    const ok = await new SlackPrincipalVerifier(fetchWithScopes as unknown as typeof fetch).verify(
      permit,
      staged,
      secrets,
    );
    expect(ok).toMatchObject({
      status: "verified",
      scopes: expect.arrayContaining(["channels:read", "channels:manage"]),
    });

    const fetchNoScopes = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ ok: true, team_id: "T1", team: "Acme" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const staged2 = await secrets.stage("op-slack-2", "xoxb-token");
    const permit2 = await testPrincipalVerificationPermit({ providerKind: "slack", operationId: "op-slack-2" });
    const bad = await new SlackPrincipalVerifier(fetchNoScopes as unknown as typeof fetch).verify(
      permit2,
      staged2,
      secrets,
    );
    expect(bad).toEqual({ status: "invalid", reason: "slack_scopes_unproven" });
  });

  it("Sentry multi-principal never guesses or borrows scopes before selection", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-sentry", "token");
    const permit = await testPrincipalVerificationPermit({ providerKind: "sentry", operationId: "op-sentry" });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.match(/\/organizations\/[^/?]+\/$/u) || url.match(/\/organizations\/[^/?]+\?$/u)) {
        return Response.json({ id: "1", slug: "a", access: ["project:read", "project:write"] });
      }
      if (url.includes("/organizations/") && url.includes("/projects/")) {
        return Response.json([{ slug: "p1" }]);
      }
      return Response.json([
        { id: "1", slug: "a", name: "A" },
        { id: "2", slug: "b", name: "B" },
      ]);
    });
    const result = await new SentryPrincipalVerifier(fetchImpl as unknown as typeof fetch).verify(
      permit,
      staged,
      secrets,
    );
    expect(result.status).toBe("multi_principal");
    if (result.status !== "multi_principal") return;
    expect(result.candidates).toHaveLength(2);
    expect(result.scopes).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("Sentry full-capability link scopes satisfy catalog provision (project:write only)", async () => {
    const { catalogOperation } = await import("../src/engine/contracts/integrationCatalog.js");
    const provision = catalogOperation("sentry", "errors", "provision");
    expect(provision?.requiredScopes).toEqual(["project:write"]);
    expect(provision?.requiredScopes).not.toContain("project:admin");
    // Proven scopes from access array must authorize provision eligibility.
    const proven = ["project:read", "project:write"];
    for (const required of provision!.requiredScopes) {
      expect(proven).toContain(required);
    }
  });

  it("Vault putCreateOnly uses CAS0 semantics: identical idempotent, different conflict", async () => {
    const calls: Array<{ body?: string; method?: string }> = [];
    const values = new Map<string, string>();
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const method = init?.method ?? "GET";
      const path = String(url);
      calls.push({ method, body: typeof init?.body === "string" ? init.body : undefined });
      if (method === "POST") {
        const parsed = JSON.parse(String(init?.body)) as {
          options?: { cas?: number };
          data?: { value?: string };
        };
        if (parsed.options?.cas === 0) {
          if (values.has(path)) {
            return Response.json(
              { errors: ["check-and-set parameter did not match the current version"] },
              { status: 400 },
            );
          }
          values.set(path, parsed.data?.value ?? "");
          return new Response(null, { status: 204 });
        }
        values.set(path, parsed.data?.value ?? "");
        return new Response(null, { status: 204 });
      }
      if (values.has(path)) {
        return Response.json({ data: { data: { value: values.get(path) } } });
      }
      return new Response("missing", { status: 404 });
    });
    const { VaultSecretStore } = await import("../src/engine/contracts/secretStore.js");
    const vault = new VaultSecretStore({ addr: "http://vault:8200", token: "t", fetchImpl });
    const first = await vault.putCreateOnly({ ref: "secret://g/1", value: "same" });
    expect(first).toEqual({ status: "created" });
    const again = await vault.putCreateOnly({ ref: "secret://g/1", value: "same" });
    expect(again).toEqual({ status: "already_exists_identical" });
    const conflict = await vault.putCreateOnly({ ref: "secret://g/1", value: "other" });
    expect(conflict).toEqual({ status: "conflict_different_value" });
    expect(calls.some((c) => c.body?.includes('"cas":0'))).toBe(true);

    const malformed = new VaultSecretStore({
      addr: "http://vault:8200",
      token: "t",
      fetchImpl: vi.fn<typeof fetch>(async () => Response.json({ errors: ["permission denied"] }, { status: 400 })),
    });
    await expect(malformed.putCreateOnly({ ref: "secret://g/2", value: "value" })).rejects.toMatchObject({
      name: "SecretStoreWriteError",
      writeState: "definitely_unwritten",
    });
  });

  it("Fly multi-org paginates via pageInfo and never sole-principal collapses", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-fly", "token");
    const permit = await testPrincipalVerificationPermit({ providerKind: "deploy.flyio", operationId: "op-fly" });
    let page = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { variables?: { after?: string | null } };
      page += 1;
      if (body.variables?.after === null || body.variables?.after === undefined) {
        return Response.json({
          data: {
            organizations: {
              nodes: [{ id: "o1", slug: "one", name: "One" }],
              pageInfo: { hasNextPage: true, endCursor: "c1" },
            },
          },
        });
      }
      if (body.variables?.after === "c1") {
        return Response.json({
          data: {
            organizations: {
              nodes: [{ id: "o2", slug: "two", name: "Two" }],
              pageInfo: { hasNextPage: false, endCursor: "c2" },
            },
          },
        });
      }
      throw new Error("unexpected cursor");
    });
    const { FlyPrincipalVerifier } = await import("../src/engine/integrations/principalVerifiers.js");
    const result = await new FlyPrincipalVerifier(fetchImpl as unknown as typeof fetch).verify(permit, staged, secrets);
    expect(result.status).toBe("multi_principal");
    if (result.status !== "multi_principal") return;
    expect(result.candidates.map((c) => c.providerPrincipalId)).toEqual(["o1", "o2"]);
    expect(page).toBe(2);
  });

  it("Vercel team fetch non-OK fails loud (never silent user-only downgrade)", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-vercel", "token");
    const permit = await testPrincipalVerificationPermit({ providerKind: "deploy.vercel", operationId: "op-vercel" });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/v2/user")) {
        return Response.json({ user: { id: "u1", username: "alice" } });
      }
      return new Response("forbidden", { status: 403 });
    });
    const result = await new VercelPrincipalVerifier(fetchImpl as unknown as typeof fetch).verify(
      permit,
      staged,
      secrets,
    );
    expect(result).toMatchObject({ status: "invalid", reason: expect.stringContaining("vercel_teams_http_403") });
  });

  it("getExact is generation-addressed: swapped generation cannot be read", async () => {
    const base = new InMemorySecretStore();
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    await base.put({ ref: "secret://org/o/integration/slack/connection/c/token/g/1", value: "gen1" });
    await base.put({ ref: "secret://org/o/integration/slack/connection/c/token/g/2", value: "gen2" });
    const target = { projectName: "p", orgSlug: "o" } as const;
    const first = await testOrgGrant({
      orgId: "o",
      projectId: "p",
      providerKind: "slack",
      connectionId: "c",
      grantId: "g",
      authGeneration: 1,
      credentialRef: "secret://org/o/integration/slack/connection/c/token/g/1",
      capability: "notify",
      operation: "provision",
      providerPrincipalId: "T1",
      target,
    });
    const expected = {
      orgId: "o",
      projectId: "p",
      providerKind: "slack",
      capability: "notify",
      operation: "provision" as const,
      target,
    };
    expect(await secretValueForLease(secrets, first.eligibleOperation, expected)).toBe("gen1");
    const second = await testOrgGrant({
      orgId: "o",
      projectId: "p",
      providerKind: "slack",
      connectionId: "c",
      grantId: "g",
      authGeneration: 2,
      credentialRef: "secret://org/o/integration/slack/connection/c/token/g/1",
      capability: "notify",
      operation: "provision",
      providerPrincipalId: "T1",
      target,
    });
    expect(await secretValueForLease(secrets, second.eligibleOperation, expected)).toBe("gen2");
    expect(await secrets.getExact({ ref: first.eligibleOperation.credentialRef, generation: 99 })).toBeUndefined();
  });

  it("create-only finalize refuses overwrite of a different value at the same generation", async () => {
    const base = new InMemorySecretStore();
    const secrets = new GenerationAddressedIntegrationSecretStore(base);
    await base.put({ ref: "secret://org/o/integration/slack/connection/c/token/g/1", value: "existing" });
    const staged = await secrets.stage("op-f", "different");
    await expect(secrets.finalize(staged, "secret://org/o/integration/slack/connection/c/token", 1)).rejects.toThrow(
      /already exists/u,
    );
    expect(
      await secrets.getExact({ ref: "secret://org/o/integration/slack/connection/c/token/g/1", generation: 1 }),
    ).toBe("existing");
  });
});
