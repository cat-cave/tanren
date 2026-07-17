import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_events",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};
const PROJECT = {
  projectId: "project_events",
  name: "events fixture",
  repoUrl: "https://example.com/events.git",
  defaultBranch: "main",
  runnerImage: null,
  allocator: "local_docker",
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/auth/me")) {
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "csrf", expiresAt: "2030-01-01" }), {
        status: 200,
      });
    }
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (url.endsWith(`/orgs/${ORG.id}/projects`)) {
      return new Response(JSON.stringify({ projects: [PROJECT] }), { status: 200 });
    }
    if (url.includes(`/orgs/${ORG.id}/projects/${PROJECT.projectId}/integration-events`)) {
      return new Response(
        JSON.stringify({
          projectId: PROJECT.projectId,
          events: [
            {
              id: "7",
              ts: "2026-07-16T12:00:00.000Z",
              projectId: PROJECT.projectId,
              eventType: "integration.resource.provisioned",
              payload: {
                requirementId: "provisioning:project_events:errors",
                providerKind: "sentry",
                externalResourceId: "events-fixture",
                ownership: "created",
              },
              redactedPaths: [],
            },
          ],
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("integration events screen", () => {
  it("renders the frozen provisioning event returned by the orchestrator", async () => {
    const app = await createApp({ pool: stubPool(), skipMigrate: true });
    const response = await app.request(`/projects/${PROJECT.projectId}/integration-events`);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain("Integration events");
    expect(html).toContain("integration.resource.provisioned");
    expect(html).toContain("events-fixture");
  });
});
