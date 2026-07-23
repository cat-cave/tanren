// #1238 — rendered + action assertions for the "Connect AI provider" surface on
// the credentials screen: connecting a provider must call the orchestrator's
// ai-provider route with `makeDefault`, flipping providerMode → byok so a run
// resolves to it; and the NEGATIVE CONTROL — no run-default provider surfaces a
// LOUD warning, not a silent managed fallback. Mirrors the greenfield/discovery
// render pattern: stub the pg pool + mock the orchestrator via global fetch.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

// Stateful ai-provider fixture: starts managed/no-default; a connect POST records
// the body and flips the org to byok with the connected provider as the default,
// so a subsequent read proves "the run then resolves to it".
interface FixtureState {
  connected: boolean;
  lastConnectBody?: Record<string, unknown>;
}

function mockOrchestrator(state: FixtureState): void {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/auth/me"))
      return new Response(JSON.stringify({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" }), { status: 200 });
    if (url.endsWith("/orgs")) return new Response(JSON.stringify({ orgs: [ORG] }), { status: 200 });
    if (/\/orgs\/[^/]+\/projects$/u.test(url)) return new Response(JSON.stringify({ projects: [] }), { status: 200 });
    if (/\/orgs\/[^/]+\/credentials$/u.test(url) && method === "GET")
      return new Response(JSON.stringify({ credentials: [] }), { status: 200 });
    if (url.endsWith("/credentials/me") && method === "GET")
      return new Response(JSON.stringify({ credentials: [] }), { status: 200 });
    // The ai-provider connect (POST) + list (GET).
    if (/\/orgs\/[^/]+\/ai-provider$/u.test(url) && method === "POST") {
      state.lastConnectBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      state.connected = true;
      const makeDefault = state.lastConnectBody["makeDefault"] !== false;
      return new Response(
        JSON.stringify({
          provider: state.lastConnectBody["provider"],
          ref: "credential/anthropic/org/org_acme/default",
          classifiedAs: "per_token/anthropic",
          isDefault: makeDefault,
        }),
        { status: 201 },
      );
    }
    if (/\/orgs\/[^/]+\/ai-provider$/u.test(url) && method === "GET") {
      const body = state.connected
        ? {
            providerMode: "byok",
            providers: [
              {
                provider: "anthropic",
                ref: "credential/anthropic/org/org_acme/default",
                classifiedAs: "per_token/anthropic",
                isDefault: true,
              },
            ],
          }
        : { providerMode: "managed", providers: [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TANREN_REQUIRE_AUTH;
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("#1238 · connect AI provider surface", () => {
  it("negative control: no run-default provider surfaces a LOUD warning, not a silent fallback", async () => {
    mockOrchestrator({ connected: false });
    const app = await build();
    const html = await (await app.request("/onboarding/credentials")).text();
    expect(html).toContain('data-screen="ai-provider"');
    expect(html).toContain("data-ai-provider-no-default");
    expect(html).toMatch(/no run-default ai provider/iu);
    // The connect form is present so the operator can fix it.
    expect(html).toContain("data-ai-provider-connect");
    expect(html).toContain('data-testid="ai-provider-make-default"');
  });

  it("connecting a provider calls the ai-provider route with makeDefault; the run then resolves to it", async () => {
    const state: FixtureState = { connected: false };
    mockOrchestrator(state);
    const app = await build();

    const res = await app.request("/onboarding/ai-provider/connect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ provider: "anthropic", apiKey: "sk-live-xyz", makeDefault: "true" }),
    });
    // Proxied write redirects back to the credentials screen.
    expect(res.status).toBe(303);
    // The orchestrator received the connect call with makeDefault + provider,
    // NOT the raw secret being echoed anywhere.
    expect(state.lastConnectBody?.provider).toBe("anthropic");
    expect(state.lastConnectBody?.makeDefault).toBe(true);
    expect(state.lastConnectBody?.apiKey).toBe("sk-live-xyz");

    // After connect, the org is byok with the provider as the run default — the
    // credentials screen now shows the resolved run-default (fixture proof).
    const html = await (await app.request("/onboarding/credentials")).text();
    expect(html).toContain("data-ai-provider-default");
    expect(html).toMatch(/run default/iu);
    expect(html).not.toContain("data-ai-provider-no-default");
    // The write-only secret value is never rendered back.
    expect(html).not.toContain("sk-live-xyz");
  });

  it("rejects a connect with no secret (no doomed empty-key call)", async () => {
    const state: FixtureState = { connected: false };
    mockOrchestrator(state);
    const app = await build();
    const res = await app.request("/onboarding/ai-provider/connect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ provider: "anthropic", makeDefault: "true" }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toMatch(/api%20key|api key/iu);
    expect(state.lastConnectBody).toBeUndefined();
  });
});
