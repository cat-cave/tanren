// Greenfield create — atomicity + idempotency (audit §3.10). The greenfield/derive
// provisioning (deploy app + repo + project + entity graph) must be IDEMPOTENT under
// retry and never coerce an unsafe LLM-authored slug into a bad repo/host name:
//   - a retried derive re-attaches to the existing project (no second repo, no second
//     deploy app, no 409, same project id);
//   - an unsafe-but-normalizable slug becomes a hostname-safe repo name;
//   - a slug with no hostname-safe content is rejected, never shipped.

import { describe, expect, it } from "vitest";
import { InMemoryVcsProvider } from "./conformance/fakes/inMemoryVcsProvider.js";
import { RoutesPool } from "./helpers/routesPool.js";
import { apexCapture, appWithGreenfieldRoutes, preparedDeploy, seedGithubAppOrg } from "./helpers/greenfieldRoutes.js";

const JSON_HEADERS = { "content-type": "application/json" };

describe("greenfield create — atomicity + idempotency (audit §3.10)", () => {
  it("a retried onboarding derive is IDEMPOTENT — re-attaches to the project, no second repo or deploy app", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const vcs = new InMemoryVcsProvider();
    let deployProvisions = 0;
    const { app } = appWithGreenfieldRoutes(pool, vcs, {
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
    expect(vcs.createdRepositories).toHaveLength(1);
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
    expect(vcs.createdRepositories).toHaveLength(1);
    expect(deployProvisions).toBe(1);
    expect(pool.projects.size).toBe(1);
  });

  it("NORMALIZES an unsafe (LLM-authored) slug into a hostname-safe repo name", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const vcs = new InMemoryVcsProvider();
    const { app } = appWithGreenfieldRoutes(pool, vcs, {
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
        capture: { ...apexCapture(), identity: { slug: "My Cool App!!!", pitch: "A short link service.", repoHint: "" } },
        owner: "cat-cave",
        deploy: { providerKind: "deploy.vercel" },
      }),
    });
    expect(res.status).toBe(201);
    // The repo was created under the NORMALIZED slug (no spaces/uppercase/punctuation).
    expect(vcs.createdRepositories).toEqual([{ owner: "cat-cave", name: "my-cool-app", private: true }]);
  });

  it("REJECTS a slug with no hostname-safe content (never ships an empty/invalid repo name)", async () => {
    const pool = new RoutesPool();
    seedGithubAppOrg(pool);
    pool.seedMembership("org_acme", "user_alice", "admin");
    const vcs = new InMemoryVcsProvider();
    const { app } = appWithGreenfieldRoutes(pool, vcs, {
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
    expect(vcs.createdRepositories).toEqual([]);
    expect(pool.projects.size).toBe(0);
  });
});
