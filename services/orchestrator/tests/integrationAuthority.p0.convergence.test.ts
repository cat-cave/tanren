/**
 * Former-bug proofs for IN-1 Slice 1 P0/P1 convergence redrive.
 * Production HTTP/authority composition — no SQL-string cosplay claims.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  issueEligibleOperationLease,
  issuePrincipalVerificationPermit,
} from "../src/engine/contracts/integrationAuthority.js";
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

const SRC_ROOT = resolve(import.meta.dirname, "../src");

function readSrc(rel: string): string {
  return readFileSync(resolve(SRC_ROOT, rel), "utf8");
}

describe("IN-1 P0 convergence — former-bug proofs", () => {
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

    const destroy = readSrc("routes/projects/greenfieldDeployDestroy.ts");
    expect(destroy).toContain("authorizeGreenfieldDeploy");
    expect(destroy).not.toContain("resolveExactControlGrant");

    // Integration provisioner token paths must use secretValueForLease / getExact.
    for (const rel of [
      "engine/providers/sentryProvisioner.ts",
      "engine/integrations/slack/slackProvisioner.ts",
      "engine/provisioners/deployProvisioner.ts",
    ]) {
      const text = readSrc(rel);
      expect(text).toContain("secretValueForLease");
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
      provider_scopes: ["channels:read", "channels:manage"],
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
      actor: { kind: "operator", id: "admin" },
    });
    expect(result.status).toBe("selection_required");
    if (result.status !== "selection_required") return;
    expect(result.reason).toBe("selection_missing");
    expect(result.candidates).toHaveLength(1);
  });

  it("Slack verified scopes make notify operations eligible; empty scopes fail", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-slack", "xoxb-token");
    const permit = issuePrincipalVerificationPermit({
      orgId: "org-1",
      providerKind: "slack",
      operationId: "op-slack",
      actorId: "admin",
      stagedSecretHandle: staged.handle,
    });
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
    const permit2 = issuePrincipalVerificationPermit({
      orgId: "org-1",
      providerKind: "slack",
      operationId: "op-slack-2",
      actorId: "admin",
      stagedSecretHandle: staged2.handle,
    });
    const bad = await new SlackPrincipalVerifier(fetchNoScopes as unknown as typeof fetch).verify(
      permit2,
      staged2,
      secrets,
    );
    expect(bad).toEqual({ status: "invalid", reason: "slack_scopes_unproven" });
  });

  it("Sentry multi-principal never guesses; scopes come from capability probes", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-sentry", "token");
    const permit = issuePrincipalVerificationPermit({
      orgId: "org-1",
      providerKind: "sentry",
      operationId: "op-sentry",
      actorId: "admin",
      stagedSecretHandle: staged.handle,
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes("/organizations/") && url.includes("/projects/")) {
        return Response.json([{ slug: "p1" }]);
      }
      if (url.includes("/teams/")) {
        return Response.json([{ slug: "t1" }]);
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
    expect(result.scopes).toEqual(expect.arrayContaining(["project:read"]));
  });

  it("Vercel team fetch non-OK fails loud (never silent user-only downgrade)", async () => {
    const secrets = new GenerationAddressedIntegrationSecretStore(new InMemorySecretStore());
    const staged = await secrets.stage("op-vercel", "token");
    const permit = issuePrincipalVerificationPermit({
      orgId: "org-1",
      providerKind: "deploy.vercel",
      operationId: "op-vercel",
      actorId: "admin",
      stagedSecretHandle: staged.handle,
    });
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
    const lease = issueEligibleOperationLease({
      orgId: "o",
      projectId: "p",
      providerKind: "slack",
      connectionId: "c",
      grantId: "g",
      authGeneration: 1,
      grantGeneration: 1,
      credentialRef: "secret://org/o/integration/slack/connection/c/token/g/1",
      capability: "notify",
      operation: "provision",
      providerPrincipalId: "T1",
      principalMetadata: {},
      policyRevision: integrationCatalogRevision(),
      consentRevision: "consent.test",
    });
    expect(await secretValueForLease(secrets, lease)).toBe("gen1");
    const swapped = issueEligibleOperationLease({ ...lease, authGeneration: 2, credentialRef: lease.credentialRef });
    // Swapped generation reads g/2 path from generationSecretRef, not g/1 value via latest.
    expect(await secretValueForLease(secrets, swapped)).toBe("gen2");
    expect(await secrets.getExact({ ref: lease.credentialRef, generation: 99 })).toBeUndefined();
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
