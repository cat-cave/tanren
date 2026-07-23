import { describe, expect, it } from "vitest";
import { emptyCapture } from "../src/engine/forge/interview/index.js";
import { FakeRepoCreateHttp } from "./conformance/fakes/fakeRepoCreateHttp.js";
import { RoutesPool } from "./helpers/routesPool.js";
import {
  apexCapture,
  appWithGreenfieldRoutes as appWithRoutes,
  captureWithLifecycle,
  LinkedDeployRoutesPool,
  preparedDeploy,
  seedGithubAppOrg,
  seedStaticTokenOrg,
} from "./helpers/greenfieldRoutes.js";

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

  it("rejects onboarding derive on an incomplete capture (409 interview_incomplete, missing lifecycle — no Node default)", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool);

    // An empty capture is INCOMPLETE — the rv-21 completion gate rejects it with a typed
    // 409 (missing areas include `lifecycle`) BEFORE any project is created; never a
    // silent Node default, never a partial derive off a half-captured vision.
    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ capture: emptyCapture(), owner: "cat-cave", deploy: { providerKind: "deploy.vercel" } }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; missing: string[] };
    expect(body.error).toBe("interview_incomplete");
    expect(body.missing).toContain("lifecycle");
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

  it("rejects onboarding derive when deploy preparation fails after project shell (no entity graph)", async () => {
    // Project shell is required before authorizeOperation; deploy provision failure
    // still returns 502 and must not leave a completed entity graph/specs.
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const githubHttp = new FakeRepoCreateHttp();
    const { app } = appWithRoutes(pool, githubHttp, {
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
        deploy: { providerKind: "deploy.vercel", connectionId: "connection_1", grantId: "grant_1" },
      }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("deploy_provision_failed");
    expect(body.message).toContain("provider token expired");
    // Project shell may exist (required for authorizeOperation); entity graph must not.
    expect(pool.specs.size).toBe(0);
    expect(pool.inboxSources).toEqual([]);
    // The repo WAS created (repo-first) — a retry re-attaches to it instead of 409-ing.
    expect(githubHttp.createdRepositories.length).toBe(1);
  });

  it("creates a real repo and issues inbox source when onboarding derive succeeds", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, githubHttp } = appWithRoutes(pool, new FakeRepoCreateHttp(), {
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
    expect(githubHttp.createdRepositories).toEqual([
      {
        owner: "cat-cave",
        name: "apex-url-shortener-v22",
        private: true,
        ownershipMarker: expect.stringMatching(/^https:\/\/tanren\.dev\/derivations\/[0-9a-f]{64}$/u),
      },
    ]);
    expect(body.repository).toEqual({
      fullName: "cat-cave/apex-url-shortener-v22",
      repoUrl: "https://github.com/cat-cave/apex-url-shortener-v22",
      defaultBranch: "main",
    });
    expect(pool.projects.get(body.projectId)?.repo_url).toBe("https://github.com/cat-cave/apex-url-shortener-v22.git");
    expect(pool.specs.size).toBeGreaterThan(0);
    expect(pool.inboxSources).toHaveLength(1);
    expect(body.inboxSource.created).toBe(true);
  });

  it("rejects onboarding derive when repo creation is forbidden without creating the graph", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app } = appWithRoutes(pool, new FakeRepoCreateHttp("forbidden"), {
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
    expect(pool.projects.size).toBe(1);
    expect([...pool.projects.values()][0]?.lifecycle).toBe("deriving");
    expect(pool.specs.size).toBe(0);
    expect(pool.inboxSources).toEqual([]);
  });

  it("creates the repo via the org-default static PAT when no GitHub App is installed", async () => {
    const pool = new RoutesPool();
    seedStaticTokenOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, githubHttp } = appWithRoutes(pool, new FakeRepoCreateHttp(), {
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
    expect(githubHttp.createdRepositories).toEqual([
      {
        owner: "cat-cave",
        name: "apex-url-shortener-v22",
        private: true,
        ownershipMarker: expect.stringMatching(/^https:\/\/tanren\.dev\/derivations\/[0-9a-f]{64}$/u),
      },
    ]);
    expect(pool.specs.size).toBeGreaterThan(0);
  });

  it("rejects onboarding derive without ANY GitHub credential (no App, no static token)", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, githubHttp } = appWithRoutes(pool, new FakeRepoCreateHttp(), {
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
    expect(githubHttp.createdRepositories).toEqual([]);
    expect(pool.projects.size).toBe(1);
    expect([...pool.projects.values()][0]?.lifecycle).toBe("deriving");
    expect(pool.specs.size).toBe(0);
    expect(pool.inboxSources).toEqual([]);
  });

  it("PROPAGATES a resolveToken INFRA failure as a 500 — never mislabeled github_credential_missing", async () => {
    const pool = new RoutesPool();
    seedStaticTokenOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const githubHttp = new FakeRepoCreateHttp();
    const { app } = appWithRoutes(
      pool,
      githubHttp,
      {
        async preflightDeploy() {},
        async prepareDeploy() {
          return preparedDeploy();
        },
      },
      // Force a token-resolution INFRA failure (the static secret read throws).
      true,
    );

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capture: apexCapture(),
        owner: "cat-cave",
        autonomy: "auto",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    // A static token IS bound (the missing-credential gap is cleared), so the
    // resolveToken throw is genuine infra — a 500, NOT a 400 "you didn't bind a
    // credential". The repo is never created.
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toBe("github_credential_missing");
    expect(body.error).toBe("interview_derive_failed");
    expect(githubHttp.createdRepositories).toEqual([]);
  });

  it("HALTS LOUD (fragment_authoring_failed 409) on a missing fragment when no authoring seam is wired — never a from-scratch scaffold", async () => {
    // Doctrine collapse (docs/roadmap/templating-system.md): when
    // `selectFragmentConfig` returns a missing-fragments decision and there is
    // NO `runFragmentAuthoring` seam wired, the derive halts loud with
    // `fragment_authoring_failed`. There is no silent fall-through to
    // from-scratch authoring.
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, githubHttp } = appWithRoutes(pool, new FakeRepoCreateHttp(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
      // No runFragmentAuthoring seam wired → a missing-fragments decision halts loud.
    });

    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // A stack the bundled library has no runtime for (the open-world
        // tokenization derives `runtime-russian-fanfiction-tools` which has no
        // bundled fragment).
        capture: {
          ...apexCapture(),
          lifecycle: { ...apexCapture().lifecycle, stack: "russian-fanfiction-tools + fly" },
        },
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: string;
      failedIds: string[];
      failureReasons: Record<string, string>;
    };
    expect(body.error).toBe("fragment_authoring_failed");
    expect(body.failedIds.length).toBeGreaterThan(0);
    // v66 fix — the body always carries a `failureReasons` map (the property
    // exists even on the no-seam halt path, where it is empty). This shape is
    // load-bearing for operator self-diagnosis.
    expect(body.failureReasons).toBeDefined();
    expect(typeof body.failureReasons).toBe("object");
    // No project / repo leaked through the fail-closed halt (it preceded creation).
    expect(pool.projects.size).toBe(0);
    expect(pool.specs.size).toBe(0);
    expect(githubHttp.createdRepositories).toEqual([]);
  });

  it("rejects direct greenfield project creation without deploy config before creating a repo", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, githubHttp } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "apex-url-shortener", owner: "cat-cave", greenfield: true }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("deploy_provider_missing");
    expect(pool.projects.size).toBe(0);
    expect(githubHttp.createdRepositories).toEqual([]);
  });

  it("rejects direct greenfield project creation when deploy provider is not linked before creating a repo", async () => {
    const pool = new RoutesPool();
    pool.seedOrg({ id: "org_acme" });
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, githubHttp } = appWithRoutes(pool);

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
    expect(githubHttp.createdRepositories).toEqual([]);
  });

  it("rejects direct greenfield project creation without exact deploy account selection", async () => {
    // Sole-candidate guessing is deleted: even a linked sole account requires
    // connectionId+grantId before any provider I/O.
    const pool = new LinkedDeployRoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, githubHttp } = appWithRoutes(pool);

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
    const body = (await res.json()) as { error: string; status: string };
    expect(body.error).toBe("deploy_selection_required");
    expect(body.status).toBe("selection_required");
    expect(pool.projects.size).toBe(0);
    expect(githubHttp.createdRepositories.length).toBe(0);
  });

  it("rejects direct greenfield project creation when linked deploy provider fails after selection", async () => {
    // Project shell lands first; authorizeOperation + provision fails with 502.
    // Exact connectionId+grantId required (no sole-candidate guess).
    const pool = new LinkedDeployRoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const { app, githubHttp } = appWithRoutes(pool);

    const res = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "apex-url-shortener",
        owner: "cat-cave",
        greenfield: true,
        deploy: {
          providerKind: "deploy.vercel",
          connectionId: "connection_1",
          grantId: "grant_1",
        },
      }),
    });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("deploy_provision_failed");
    // Repo + project shell may exist; deploy target is not attached.
    expect(githubHttp.createdRepositories.length).toBe(1);
  });
});
