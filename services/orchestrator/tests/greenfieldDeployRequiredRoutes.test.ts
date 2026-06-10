import { describe, expect, it } from "vitest";
import { RepositoryCreationForbiddenError } from "../src/engine/contracts/vcsProvider.js";
import { emptyCapture } from "../src/engine/forge/interview/index.js";
import { InMemoryVcsProvider } from "./conformance/fakes/inMemoryVcsProvider.js";
import { RoutesPool } from "./helpers/routesPool.js";
import {
  apexCapture,
  appWithGreenfieldRoutes as appWithRoutes,
  captureWithLifecycle,
  preparedDeploy,
  seedGithubAppOrg,
  seedStaticTokenOrg,
} from "./helpers/greenfieldRoutes.js";

class ForbiddenCreateVcsProvider extends InMemoryVcsProvider {
  override async createRepository(input: Parameters<InMemoryVcsProvider["createRepository"]>[0]) {
    throw new RepositoryCreationForbiddenError(input.owner);
  }
}

class LinkedDeployRoutesPool extends RoutesPool {
  override async query(sql: string, params: unknown[] = []) {
    const text = sql.replaceAll(/\s+/gu, " ").trim();
    if (
      text.startsWith(
        "SELECT id, org_id, provider_kind, credential_ref, metadata, capabilities, status FROM org_integrations",
      )
    ) {
      const [orgId, providerKind] = params as string[];
      return {
        rows: [
          {
            id: "integration_1",
            org_id: orgId,
            provider_kind: providerKind,
            credential_ref: "secret://missing/deploy-token",
            metadata: {},
            capabilities: ["deploy"],
            status: "linked",
          },
        ],
        rowCount: 1,
      };
    }
    return super.query(sql, params);
  }
}

describe("greenfield/apex deploy dependency routes", () => {
  it("rejects autonomous onboarding derive without a deploy provider before creating a project", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture: captureWithLifecycle(), owner: "cat-cave", autonomy: "auto" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; supportedProviderKinds: string[] };
    expect(body.error).toBe("deploy_provider_missing");
    expect(body.supportedProviderKinds).toEqual(["deploy.vercel", "deploy.flyio"]);
    expect(pool.projects.size).toBe(0);
  });

  it("rejects onboarding derive without deploy even when autonomy is omitted", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture: captureWithLifecycle(), owner: "cat-cave" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("deploy_provider_missing");
    expect(pool.projects.size).toBe(0);
  });

  it("rejects onboarding derive when the architecture step captured NO lifecycle (400, no Node default)", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool);

    // A deploy provider IS supplied, so the rejection is specifically the missing
    // lifecycle (not the deploy guard).
    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture: emptyCapture(), owner: "cat-cave", deploy: { providerKind: "deploy.vercel" } }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("lifecycle_missing");
    expect(pool.projects.size).toBe(0);
  });

  it("rejects autonomous onboarding derive when the named deploy provider is not linked", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: captureWithLifecycle(),
        owner: "cat-cave",
        autonomy: "auto",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; status: string; providerKind: string; linkAffordance: unknown };
    expect(body.error).toBe("deploy_not_linked");
    expect(body.status).toBe("not_linked");
    expect(body.providerKind).toBe("deploy.vercel");
    expect(body.linkAffordance).toEqual({
      kind: "org_integration_link",
      providerKind: "deploy.vercel",
      orgId: "org_acme",
    });
    expect(pool.projects.size).toBe(0);
  });

  it("rejects onboarding derive when deploy preparation fails after repo-create (no project/graph)", async () => {
    // IDEMPOTENT + ATOMIC ORDER (audit §3.10): the order is REPO-FIRST then deploy, so
    // a deploy-provision failure leaves a re-attachable repo but NO project/graph. The
    // response is still 502 (deploy_provision_failed); a retry re-attaches to the repo
    // (no 409) and re-runs deploy — never double-provisioning a deploy app.
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const vcs = new InMemoryVcsProvider();
    const { app } = appWithRoutes(pool, vcs, {
      async preflightDeploy() {},
      async prepareDeploy() {
        throw new Error("deploy provision failed: provider token expired");
      },
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: captureWithLifecycle(),
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("deploy_provision_failed");
    expect(body.message).toContain("provider token expired");
    // No project/graph was committed (deploy failed before the project row).
    expect(pool.projects.size).toBe(0);
    expect(pool.specs.size).toBe(0);
    expect(pool.inboxSources).toEqual([]);
    // The repo WAS created (repo-first) — a retry re-attaches to it instead of 409-ing.
    expect(vcs.createdRepositories.length).toBe(1);
  });

  it("creates a real repo and issues inbox source when onboarding derive succeeds", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool, new InMemoryVcsProvider(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: apexCapture(),
        owner: "cat-cave",
        private: true,
        autonomy: "auto",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      projectId: string;
      repository: { fullName: string; repoUrl: string; defaultBranch: string };
      inboxSource: { created: boolean };
    };
    expect(vcsProvider.createdRepositories).toEqual([
      { owner: "cat-cave", name: "apex-url-shortener-v22", private: true },
    ]);
    expect(body.repository).toEqual({
      fullName: "cat-cave/apex-url-shortener-v22",
      repoUrl: "https://github.com/cat-cave/apex-url-shortener-v22",
      defaultBranch: "main",
    });
    expect(pool.projects.get(body.projectId)?.repo_url).toBe("https://github.com/cat-cave/apex-url-shortener-v22");
    expect(pool.specs.size).toBeGreaterThan(0);
    expect(pool.inboxSources).toHaveLength(1);
    expect(body.inboxSource.created).toBe(true);
  });

  it("rejects onboarding derive when repo creation is forbidden without creating the graph", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool, new ForbiddenCreateVcsProvider(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: apexCapture(),
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; requiredPermission: string };
    expect(body.error).toBe("repository_creation_forbidden");
    expect(body.requiredPermission).toBe("administration:write");
    expect(pool.projects.size).toBe(0);
    expect(pool.specs.size).toBe(0);
    expect(pool.inboxSources).toEqual([]);
  });

  it("creates the repo via the org-default static PAT when no GitHub App is installed", async () => {
    const pool = new RoutesPool();
    seedStaticTokenOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool, new InMemoryVcsProvider(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: apexCapture(),
        owner: "cat-cave",
        private: true,
        autonomy: "auto",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    // No App, but a static github_token org default IS configured → repo created.
    expect(res.status).toBe(201);
    expect(vcsProvider.createdRepositories).toEqual([
      { owner: "cat-cave", name: "apex-url-shortener-v22", private: true },
    ]);
    expect(pool.specs.size).toBeGreaterThan(0);
  });

  it("rejects onboarding derive without ANY GitHub credential (no App, no static token)", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool, new InMemoryVcsProvider(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: apexCapture(),
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("github_credential_missing");
    expect(vcsProvider.createdRepositories).toEqual([]);
    expect(pool.projects.size).toBe(0);
    expect(pool.specs.size).toBe(0);
    expect(pool.inboxSources).toEqual([]);
  });

  it("HALTS LOUD (template_required 409) on a no-match when no just-in-time creation is possible — never a from-scratch project scaffold", async () => {
    // The deleted bypass would have scaffolded the project from-scratch on an empty
    // template registry. The doctrine instead HALTS: with the creation seam disabled
    // and an empty fixture registry, the no-match is a fail-closed needs_attention.
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool, new InMemoryVcsProvider(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
      // Disable the just-in-time creation seam → a no-match cannot create a template.
      createTemplateForNoMatch: undefined,
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: apexCapture(),
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; stack: string };
    expect(body.error).toBe("template_required");
    expect(body.stack).toBe("ts/pnpm");
    // No project / repo leaked through the fail-closed halt (it preceded creation).
    expect(pool.projects.size).toBe(0);
    expect(pool.specs.size).toBe(0);
    expect(vcsProvider.createdRepositories).toEqual([]);
  });

  it("rejects direct greenfield project creation without deploy config before creating a repo", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "apex-url-shortener", owner: "cat-cave", greenfield: true }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("deploy_provider_missing");
    expect(pool.projects.size).toBe(0);
    expect(vcsProvider.createdRepositories).toEqual([]);
  });

  it("rejects direct greenfield project creation when deploy provider is not linked before creating a repo", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "apex-url-shortener",
        owner: "cat-cave",
        greenfield: true,
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; status: string; providerKind: string };
    expect(body.error).toBe("deploy_not_linked");
    expect(body.status).toBe("not_linked");
    expect(body.providerKind).toBe("deploy.vercel");
    expect(pool.projects.size).toBe(0);
    expect(vcsProvider.createdRepositories).toEqual([]);
  });

  it("rejects direct greenfield project creation when linked deploy provider fails after repo-create", async () => {
    // IDEMPOTENT + ATOMIC ORDER (audit §3.10): repo-first then deploy. A deploy failure
    // leaves a re-attachable repo but NO project; the response is still 502. A retry
    // re-attaches to the repo (no 409) and re-runs deploy (no second deploy app).
    const pool = new LinkedDeployRoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, vcsProvider } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "apex-url-shortener",
        owner: "cat-cave",
        greenfield: true,
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("deploy_provision_failed");
    // No project committed (deploy failed before the project row)…
    expect(pool.projects.size).toBe(0);
    // …but the repo WAS created (repo-first) — a retry re-attaches to it, no 409.
    expect(vcsProvider.createdRepositories.length).toBe(1);
  });
});
