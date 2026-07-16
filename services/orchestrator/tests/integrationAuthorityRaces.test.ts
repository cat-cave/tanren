import { Hono } from "hono";
import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { IntegrationSecretCleanupReaper } from "../src/engine/integrations/integrationSecretCleanupReaper.js";
import { GenerationAddressedIntegrationSecretStore } from "../src/engine/integrations/integrationSecretStoreImpl.js";
import type { IntegrationQueryClient } from "../src/engine/repositories/integrationQuery.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { createIntegrationRoutes, type IntegrationRouteDatabase } from "../src/routes/integrations/index.js";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { IntegrationMemoryDb } from "./helpers/integrationMemoryDb.js";

const admin: ActorContext = {
  userId: "user_admin",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

class RaceDatabase implements IntegrationRouteDatabase {
  readonly events = new FakeEventStore();
  readonly memory = new IntegrationMemoryDb();

  withOrgScope<T>(orgId: string, work: (client: IntegrationQueryClient) => Promise<T>): Promise<T> {
    return work(this.memory.clientForOrg(orgId));
  }
}

function raceHarness(fetchImpl: typeof fetch, persisted?: { database: RaceDatabase; base: InMemorySecretStore }) {
  const database = persisted?.database ?? new RaceDatabase();
  const base = persisted?.base ?? new InMemorySecretStore();
  const app = new Hono<ActorContextEnv>();
  app.use("*", async (context, next) => {
    context.set("actor", admin);
    return next();
  });
  app.route(
    "/orgs",
    createIntegrationRoutes({
      database,
      secrets: base,
      integrationSecrets: new GenerationAddressedIntegrationSecretStore(base),
      fetchImpl,
    }),
  );
  return { app, database, base };
}

function link(app: Hono<ActorContextEnv>, idempotencyKey: string) {
  return app.request("/orgs/org_acme/integrations/slack", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "xoxb-same-bytes", idempotencyKey }),
  });
}

function verifiedSlack(): Response {
  return Response.json(
    { ok: true, team_id: "team-race", team: "Race Team", user_id: "bot-race" },
    { headers: { "x-oauth-scopes": "chat:write,channels:read" } },
  );
}

describe("integration authority verifier races", () => {
  it("keeps route construction timer-free and starts only one owned reaper interval", async () => {
    const routeStart = vi.spyOn(IntegrationSecretCleanupReaper.prototype, "start");
    const secrets = new InMemorySecretStore();
    createIntegrationRoutes({ pool: {} as pg.Pool, secrets });
    createIntegrationRoutes({ pool: {} as pg.Pool, secrets });
    expect(routeStart).not.toHaveBeenCalled();
    routeStart.mockRestore();

    vi.useFakeTimers();
    try {
      const reaper = new IntegrationSecretCleanupReaper({ pool: {} as pg.Pool, secrets, intervalMs: 100 });
      const tick = vi.spyOn(reaper, "tick").mockResolvedValue(0);
      reaper.start();
      reaper.start();
      expect(reaper.isRunning).toBe(true);
      await vi.advanceTimersByTimeAsync(250);
      expect(tick).toHaveBeenCalledTimes(2);
      await reaper.stop();
      expect(reaper.isRunning).toBe(false);
      await vi.advanceTimersByTimeAsync(250);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves staged bytes and durable state across provider Retry-After, then resumes", async () => {
    let available = false;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      available ? verifiedSlack() : new Response("rate limited", { status: 429, headers: { "retry-after": "17" } }),
    ) as unknown as typeof fetch;
    const { app, database, base } = raceHarness(fetchImpl);

    const unavailable = await link(app, "retryable");
    expect(await unavailable.json()).toMatchObject({
      status: "provider_unavailable",
      reason: "slack_http_429",
      retryAfter: "17",
    });
    const pending = database.memory.operations[0]!;
    expect(pending).toMatchObject({ stage: "credential_staged", status: "in_progress" });
    expect(await base.get(pending.staged_secret_handle!)).toBeDefined();

    available = true;
    const restarted = raceHarness(fetchImpl, { database, base });
    expect(restarted.app).not.toBe(app);
    const resumed = await link(restarted.app, "retryable");
    expect(await resumed.json()).toMatchObject({ status: "completed", providerPrincipalId: "team-race" });
    expect(database.memory.operations[0]).toMatchObject({ stage: "completed", status: "completed" });
    expect(database.memory.connections).toHaveLength(1);
  });

  it("a delayed invalid duplicate cannot fail or clean up an operation reserved by its peer", async () => {
    let calls = 0;
    let signalStarted!: () => void;
    let releaseInvalid!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const invalidGate = new Promise<void>((resolve) => {
      releaseInvalid = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        signalStarted();
        await invalidGate;
        return new Response("unauthorized", { status: 401 });
      }
      return verifiedSlack();
    }) as unknown as typeof fetch;
    const { app, database, base } = raceHarness(fetchImpl);

    const delayedInvalid = link(app, "same-key-race");
    await started;
    const winner = await link(app, "same-key-race");
    expect(await winner.json()).toMatchObject({ status: "completed", providerPrincipalId: "team-race" });
    releaseInvalid();
    const converged = await delayedInvalid;
    expect(await converged.json()).toMatchObject({ status: "completed", providerPrincipalId: "team-race" });

    expect(database.memory.operations).toHaveLength(1);
    expect(database.memory.operations[0]).toMatchObject({ stage: "completed", status: "completed" });
    expect(database.memory.connections).toHaveLength(1);
    expect(database.memory.authGenerations).toHaveLength(1);
    expect(await base.get(database.memory.authGenerations[0]!.credential_ref)).toMatchObject({
      value: "xoxb-same-bytes",
    });
  });
});
