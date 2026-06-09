// URL canonicalization: the GitHub App install URL + the orchestrator public
// base URL each resolve to ONE canonical name, and the install URL is surfaced on
// `/auth/providers` so the dashboard reads it from the orchestrator (one source of
// truth) instead of a second dashboard-only env name.
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { IdentityProvider } from "../src/auth/identityProvider.js";
import type { IdentityProviderId } from "../src/auth/schemas.js";
import type { IdentityStore } from "../src/auth/identityStore.js";
import { createAuthRoutes } from "../src/routes/auth/index.js";

// A throwaway provider so the route mounts (we only exercise GET /providers).
const fakeProvider = {
  id: "local_dev" as const,
  buildAuthorizeUrl: () => "http://example/authorize",
  exchangeCode: async () => ({ subject: "s", login: "l", orgs: [] }),
} as unknown as IdentityProvider;

function mount(githubAppInstallUrl?: string) {
  const app = new Hono();
  const providers = new Map<IdentityProviderId, IdentityProvider>([["local_dev", fakeProvider]]);
  app.route(
    "/auth",
    createAuthRoutes({
      providers,
      store: {} as unknown as IdentityStore,
      publicBaseUrl: "http://localhost:3100",
      ...(githubAppInstallUrl !== undefined && { githubAppInstallUrl }),
    }),
  );
  return app;
}

describe("URL canonicalization — GitHub App install URL via /auth/providers", () => {
  it("echoes the canonical install URL on /auth/providers when configured", async () => {
    const app = mount("https://github.com/apps/tanren/installations/new");
    const res = await app.request("/auth/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { githubAppInstallUrl?: string };
    // ONE value: the install URL the dashboard reads from the orchestrator.
    expect(body.githubAppInstallUrl).toBe("https://github.com/apps/tanren/installations/new");
  });

  it("omits the install URL when unconfigured (no second env name to drift)", async () => {
    const app = mount();
    const res = await app.request("/auth/providers");
    const body = (await res.json()) as { githubAppInstallUrl?: string };
    expect(body.githubAppInstallUrl).toBeUndefined();
  });
});
