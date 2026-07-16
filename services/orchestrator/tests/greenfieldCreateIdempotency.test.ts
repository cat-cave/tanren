// Greenfield create — atomicity + idempotency (audit §3.10). The greenfield/derive
// provisioning (deploy app + repo + project + entity graph) must be IDEMPOTENT under
// retry and never coerce an unsafe LLM-authored slug into a bad repo/host name:
//   - a retried derive re-attaches to the existing project (no second repo, no second
//     deploy app, no 409, same project id);
//   - an unsafe-but-normalizable slug becomes a hostname-safe repo name;
//   - a slug with no hostname-safe content is rejected, never shipped.

import { describe, expect, it } from "vitest";
import { FakeRepoCreateHttp } from "./conformance/fakes/fakeRepoCreateHttp.js";
import { RoutesPool } from "./helpers/routesPool.js";
import { apexCapture, appWithGreenfieldRoutes, preparedDeploy, seedGithubAppOrg } from "./helpers/greenfieldRoutes.js";

const JSON_HEADERS = { "content-type": "application/json" };

describe("greenfield create — atomicity + idempotency (audit §3.10)", () => {
  it("retries a failed direct-greenfield deploy from the deriving receipt without duplicate repo effects", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const githubHttp = new FakeRepoCreateHttp();
    let deployAttempts = 0;
    const { app } = appWithGreenfieldRoutes(pool, githubHttp, {
      async preflightDeploy() {},
      async prepareDeploy() {
        deployAttempts += 1;
        if (deployAttempts === 1) throw new Error("provider temporarily unavailable");
        return preparedDeploy();
      },
    });
    const body = JSON.stringify({
      name: "receipt-retry",
      owner: "cat-cave",
      greenfield: true,
      deploy: { providerKind: "deploy.vercel", connectionId: "connection_1", grantId: "grant_1" },
    });

    const failed = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(failed.status).toBe(502);
    const shell = [...pool.projects.values()][0];
    expect(shell?.lifecycle).toBe("deriving");

    const resumed = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(resumed.status).toBe(200);
    expect((await resumed.json()) as unknown).toMatchObject({ lifecycle: "active", idempotentReplay: true });
    expect(githubHttp.createdRepositories).toHaveLength(1);
    expect(deployAttempts).toBe(2);
    expect(shell?.lifecycle).toBe("active");
    const operation = [...pool.projectDerivations.values()][0];
    expect(operation).toMatchObject({ status: "succeeded", phase: "activate" });
  });

  it("never grafts a fingerprint retry onto a different project bound to the canonical repo", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    let deployAttempts = 0;
    const { app, githubHttp } = appWithGreenfieldRoutes(pool, new FakeRepoCreateHttp(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        deployAttempts += 1;
        throw new Error("hold derivation after repository receipt");
      },
    });
    const body = JSON.stringify({
      name: "binding-guard",
      owner: "cat-cave",
      greenfield: true,
      deploy: { providerKind: "deploy.vercel" },
    });
    const first = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(first.status).toBe(502);
    const original = [...pool.projects.values()][0]!;
    const canonicalRepoUrl = original.repo_url;
    original.repo_url = "https://github.com/cat-cave/moved-binding";
    pool.seedProject({
      project_id: "project_other_binding",
      org_id: "org_acme",
      name: "binding-guard",
      repo_url: canonicalRepoUrl,
      config: { version: 1, greenfield: true },
      lifecycle: "deriving",
    });

    const retry = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });

    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      error: "greenfield_derivation_conflict",
      reason: "repo_bound_without_derivation",
    });
    expect(deployAttempts).toBe(1);
    expect(githubHttp.createdRepositories).toHaveLength(1);
    expect([...pool.projectDerivations.values()][0]?.project_id).toBe(original.project_id);
  });

  it("reconciles a lost GitHub create response only through the exact ownership marker", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const githubHttp = new FakeRepoCreateHttp("response_lost");
    const { app } = appWithGreenfieldRoutes(pool, githubHttp, {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
    });

    const response = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "lost-create-response",
        owner: "cat-cave",
        greenfield: true,
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(response.status).toBe(201);
    expect(githubHttp.createdRepositories).toEqual([
      expect.objectContaining({
        owner: "cat-cave",
        name: "lost-create-response",
        ownershipMarker: expect.stringMatching(/^https:\/\/tanren\.dev\/derivations\/[0-9a-f]{64}$/u),
      }),
    ]);
    expect([...pool.projects.values()][0]?.lifecycle).toBe("active");
  });

  it("does not activate until bootstrap is complete and reuses the deploy receipt on retry", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    let deployAttempts = 0;
    let bootstrapAttempts = 0;
    const { app, githubHttp } = appWithGreenfieldRoutes(pool, new FakeRepoCreateHttp(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        deployAttempts += 1;
        return preparedDeploy();
      },
      async bootstrapProject(input) {
        bootstrapAttempts += 1;
        if (bootstrapAttempts === 1) {
          return { errors: [{ seed: "auditCatalog", message: "postgres unavailable" }] };
        }
        return pool.seedDerivationBootstrap(input.orgId, input.projectId);
      },
    });
    const body = JSON.stringify({
      name: "bootstrap-retry",
      owner: "cat-cave",
      greenfield: true,
      deploy: { providerKind: "deploy.vercel", connectionId: "connection_1", grantId: "grant_1" },
    });

    const failed = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(failed.status).toBe(503);
    const shell = [...pool.projects.values()][0];
    expect(shell?.lifecycle).toBe("deriving");

    const resumed = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(resumed.status).toBe(200);
    expect(shell?.lifecycle).toBe("active");
    expect(deployAttempts).toBe(1);
    expect(bootstrapAttempts).toBe(2);
    expect(githubHttp.createdRepositories).toHaveLength(1);
  });

  it("rejects an unrelated same-name repo even when it is bare and never reaches deploy", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    let deployEffects = 0;
    const { app } = appWithGreenfieldRoutes(pool, new FakeRepoCreateHttp("exists", true), {
      async preflightDeploy() {},
      async prepareDeploy() {
        deployEffects += 1;
        return preparedDeploy();
      },
    });

    const response = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "occupied",
        owner: "cat-cave",
        greenfield: true,
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "repository_already_exists" });
    expect([...pool.projects.values()][0]?.lifecycle).toBe("deriving");
    expect(deployEffects).toBe(0);
  });

  it("rejects a same-org deriving project that is not this exact greenfield shell", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    pool.seedProject({
      project_id: "project_wrong_shell",
      org_id: "org_acme",
      name: "another-project",
      repo_url: "https://github.com/cat-cave/claimed",
      config: { version: 1, greenfield: true },
      lifecycle: "deriving",
    });
    const { app, githubHttp } = appWithGreenfieldRoutes(pool, new FakeRepoCreateHttp(), {
      async preflightDeploy() {},
      async prepareDeploy() {
        throw new Error("wrong shell must not reach deploy");
      },
    });

    const response = await app.request("/orgs/org_acme/projects/greenfield", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "claimed",
        owner: "cat-cave",
        greenfield: true,
        deploy: { providerKind: "deploy.vercel" },
      }),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "greenfield_derivation_conflict",
      reason: "repo_bound_without_derivation",
    });
    expect(githubHttp.createdRepositories).toHaveLength(0);
    expect(pool.projectDerivations.size).toBe(0);
  });

  it("a retried onboarding derive is IDEMPOTENT — re-attaches to the project, no second repo or deploy app", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const githubHttp = new FakeRepoCreateHttp();
    let deployProvisions = 0;
    const { app } = appWithGreenfieldRoutes(pool, githubHttp, {
      async preflightDeploy() {},
      async prepareDeploy() {
        deployProvisions += 1;
        return preparedDeploy();
      },
    });
    const body = JSON.stringify({
      capture: apexCapture(),
      owner: "cat-cave",
      private: true,
      autonomy: "auto",
      deploy: { providerKind: "deploy.vercel" },
    });

    // First derive: creates the repo + provisions deploy + the project graph.
    const first = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { projectId: string };
    expect(githubHttp.createdRepositories).toHaveLength(1);
    expect(deployProvisions).toBe(1);
    expect(pool.projects.size).toBe(1);

    // RETRY with the SAME owner/slug: the derive re-attaches to the existing project
    // (idempotency probe by repo URL) — NO second repo-create, NO second deploy app,
    // NO 409, and the SAME project id.
    const retry = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: JSON_HEADERS,
      body,
    });
    expect(retry.status).toBe(201);
    const retryBody = (await retry.json()) as { projectId: string };
    expect(retryBody.projectId).toBe(firstBody.projectId);
    // not 2 — no double repo-create, no double deploy-app provision, single project.
    expect(githubHttp.createdRepositories).toHaveLength(1);
    expect(deployProvisions).toBe(1);
    expect(pool.projects.size).toBe(1);
  });

  it("NORMALIZES an unsafe (LLM-authored) slug into a hostname-safe repo name", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const githubHttp = new FakeRepoCreateHttp();
    const { app } = appWithGreenfieldRoutes(pool, githubHttp, {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
    });
    // The interview captured an unsafe slug ("My Cool App!!!") — the capture schema
    // NORMALIZES it to a hostname-safe DNS label before it ever names a repo.
    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        capture: {
          ...apexCapture(),
          identity: { slug: "My Cool App!!!", pitch: "A short link service.", repoHint: "" },
        },
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });
    expect(res.status).toBe(201);
    // The repo was created under the NORMALIZED slug (no spaces/uppercase/punctuation).
    expect(githubHttp.createdRepositories).toEqual([
      {
        owner: "cat-cave",
        name: "my-cool-app",
        private: true,
        ownershipMarker: expect.stringMatching(/^https:\/\/tanren\.dev\/derivations\/[0-9a-f]{64}$/u),
      },
    ]);
  });

  it("REJECTS a slug with no hostname-safe content (never ships an empty/invalid repo name)", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const githubHttp = new FakeRepoCreateHttp();
    const { app } = appWithGreenfieldRoutes(pool, githubHttp, {
      async preflightDeploy() {},
      async prepareDeploy() {
        return preparedDeploy();
      },
    });
    // A slug that is ALL punctuation normalizes to "" — rejected at the capture
    // boundary (400 invalid_derive), never coerced into a bad repo/host name.
    const res = await app.request("/orgs/org_acme/onboarding/interview/derive", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        capture: { ...apexCapture(), identity: { slug: "!!!@@@###", pitch: "x", repoHint: "" } },
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });
    expect(res.status).toBe(400);
    expect(githubHttp.createdRepositories).toEqual([]);
    expect(pool.projects.size).toBe(0);
  });
});
