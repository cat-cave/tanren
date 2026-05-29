import { describe, expect, it } from "vitest";
import { hashApiToken, IdentityStore } from "../src/auth/index.js";
import { createFakeIdentityPool } from "./helpers/fakeIdentityPool.js";

describe("IdentityStore", () => {
  it("upserts a user, creates the first org member as admin, and joins later members as members", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const claims = {
      providerSubject: "12345",
      login: "alice",
      email: "alice@example.com",
      displayName: "Alice",
      orgs: [{ externalId: "888", login: "acme", displayName: "Acme", kind: "github_org" as const }],
    };
    const first = await store.upsertIdentity("github_oauth", claims);
    expect(first.user.login).toBe("alice");
    expect(first.orgs).toHaveLength(1);
    expect(first.primaryOrgId).toBe(first.orgs[0].id);
    expect(pool.orgMembers.get(`${first.orgs[0].id}:${first.user.id}`)?.role).toBe("admin");

    const second = await store.upsertIdentity("github_oauth", {
      ...claims,
      providerSubject: "67890",
      login: "bob",
      email: "bob@example.com",
      displayName: "Bob",
    });
    expect(pool.orgMembers.get(`${first.orgs[0].id}:${second.user.id}`)?.role).toBe("member");
    expect(second.orgs[0].id).toBe(first.orgs[0].id);
  });

  it("creates a session that expires after its TTL", async () => {
    const pool = createFakeIdentityPool();
    let now = new Date("2026-01-01T00:00:00Z");
    const store = new IdentityStore(pool.asPgPool(), () => now);
    const session = await store.createSession("user_a", { ttlMs: 1000 });
    expect(await store.loadSession(session.id)).toMatchObject({ id: session.id, userId: "user_a" });
    now = new Date("2026-01-01T00:00:02Z");
    expect(await store.loadSession(session.id)).toBeUndefined();
  });

  it("creates and validates an api token by hash, rejecting unknown tokens", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const token = await store.createApiToken({
      userId: "user_a",
      name: "cli",
      scopes: ["read", "write"],
    });
    expect(token.rawToken).toMatch(/^tnt_/);
    expect(token.tokenHash).toBe(hashApiToken(token.rawToken));
    const lookup = await store.findApiTokenByRaw(token.rawToken);
    expect(lookup).toMatchObject({ userId: "user_a", scopes: ["read", "write"] });
    expect(await store.findApiTokenByRaw("tnt_wrong")).toBeUndefined();
  });

  it("resolves actor context with org and project scopes when the user is a member", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const { user, orgs } = await store.upsertIdentity("github_oauth", {
      providerSubject: "99",
      login: "carol",
      email: null,
      displayName: "Carol",
      orgs: [{ externalId: "100", login: "carol-org", displayName: "Carol Org", kind: "github_org" }],
    });
    pool.projects.set("project_1", { projectId: "project_1", orgId: orgs[0].id });
    const actor = await store.resolveActorContext({
      userId: user.id,
      orgId: orgs[0].id,
      projectId: "project_1",
      source: "session",
    });
    expect(actor.scopes).toContain("org:admin");
    expect(actor.scopes).toContain("org:member");
    // project-via-org fallback grants project membership scopes
    expect(actor.scopes).toContain("project:member");
    expect(actor.scopes).toContain("project:admin");
  });

  it("denies cross-org project access in the resolved actor context", async () => {
    const pool = createFakeIdentityPool();
    const store = new IdentityStore(pool.asPgPool());
    const alice = await store.upsertIdentity("github_oauth", {
      providerSubject: "1",
      login: "alice",
      email: null,
      displayName: "Alice",
      orgs: [{ externalId: "11", login: "org-a", displayName: "Org A", kind: "github_org" }],
    });
    const bob = await store.upsertIdentity("github_oauth", {
      providerSubject: "2",
      login: "bob",
      email: null,
      displayName: "Bob",
      orgs: [{ externalId: "22", login: "org-b", displayName: "Org B", kind: "github_org" }],
    });
    pool.projects.set("project_a", { projectId: "project_a", orgId: alice.orgs[0].id });
    const bobAccessingA = await store.resolveActorContext({
      userId: bob.user.id,
      orgId: alice.orgs[0].id,
      projectId: "project_a",
      source: "session",
    });
    expect(bobAccessingA.orgId).toBeNull();
    expect(bobAccessingA.projectId).toBeNull();
    expect(bobAccessingA.scopes).not.toContain("org:member");
  });
});
