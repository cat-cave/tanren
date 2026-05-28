import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createBrownfieldRoutes } from "../src/routes/brownfield/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

class RecordingGitHubClient implements GitHubHttpClient {
  readonly calls: GitHubHttpRequest[] = [];
  constructor(private readonly handler: (req: GitHubHttpRequest) => GitHubHttpResponse) {}
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.calls.push(input);
    return this.handler(input);
  }
}

const alice: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session"
};

function buildHarness(actor: ActorContext, http: GitHubHttpClient) {
  const pool = new RoutesPool();
  const secrets = new InMemorySecretStore();
  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {
          return undefined;
        },
        async loadSession() {
          return undefined;
        },
        async resolveActorContext() {
          return actor;
        }
      } as never,
      localDevActor: actor
    })
  );
  app.route("/orgs", createBrownfieldRoutes({ pool: pool.asPgPool(), secrets, githubHttp: http }));
  return { app, pool, secrets };
}

describe("brownfield link endpoint", () => {
  it("reads target-repo files via the GitHub API and writes nothing", async () => {
    const http = new RecordingGitHubClient((req) => {
      if (req.path === "/repos/cat-cave/fixture") {
        return { status: 200, body: { name: "fixture" } };
      }
      if (req.path.endsWith("/.github%2Fworkflows%2Ftanren-ci.yml") || req.path.endsWith("tanren-ci.yml")) {
        return {
          status: 200,
          body: {
            encoding: "base64",
            size: 7,
            content: Buffer.from("ci: yes\n").toString("base64")
          }
        };
      }
      return { status: 404, body: undefined };
    });
    const { app, pool, secrets } = buildHarness(alice, http);
    pool.seedProject({ project_id: "project_1", org_id: "org_acme" });
    await secrets.put({ ref: "credential/github/default", value: "ghp_test" });

    const response = await app.request("/orgs/org_acme/projects/project_1/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/cat-cave/fixture" })
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      projectId: string;
      writesPerformed: number;
      detectedFiles: Array<{ path: string; present: boolean }>;
    };
    expect(body.projectId).toBe("project_1");
    expect(body.writesPerformed).toBe(0);
    expect(body.detectedFiles.some((file) => file.path.includes("tanren-ci.yml") && file.present)).toBe(true);
    expect(http.calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("returns 404 when the GitHub App cannot see the repository", async () => {
    const http = new RecordingGitHubClient(() => ({ status: 404, body: undefined }));
    const { app, pool, secrets } = buildHarness(alice, http);
    pool.seedProject({ project_id: "project_1", org_id: "org_acme" });
    await secrets.put({ ref: "credential/github/default", value: "ghp_test" });

    const response = await app.request("/orgs/org_acme/projects/project_1/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/cat-cave/missing" })
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("repo_not_reachable");
  });

  it("rejects cross-org project link with 403", async () => {
    const http = new RecordingGitHubClient(() => ({ status: 200, body: {} }));
    const { app, pool } = buildHarness(alice, http);
    pool.seedProject({ project_id: "project_other", org_id: "org_other" });

    const response = await app.request("/orgs/org_acme/projects/project_other/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/cat-cave/x" })
    });
    expect(response.status).toBe(403);
  });

  it("returns 400 when no github credential is configured", async () => {
    const http = new RecordingGitHubClient(() => ({ status: 200, body: {} }));
    const { app, pool } = buildHarness(alice, http);
    pool.seedProject({ project_id: "project_1", org_id: "org_acme" });

    const response = await app.request("/orgs/org_acme/projects/project_1/link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/cat-cave/x" })
    });
    expect(response.status).toBe(400);
  });
});
