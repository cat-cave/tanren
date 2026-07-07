// Route tests for the operator-facing DEPLOY CONFIRMATION route (Codex H3 Surface 7
// #21). The `POST /orgs/:orgId/projects/:projectId/deploys/:deploymentId/confirm`
// endpoint flips a pending manual_external attestation → confirmed via the
// injected in-memory store + emits `deploy.manual_confirmed`. Auth is org-admin;
// a non-admin actor is denied 403; a missing / cross-org row 404s.

import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import type { AppendEventInput, EventStore } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  InMemoryManualAttestationStore,
  MANUAL_EXTERNAL_PROVIDER_KIND,
} from "../src/engine/deploy/manualExternalDeployAdapter.js";
import { createAuthMiddleware, type ActorContextEnv } from "../src/middleware/auth.js";
import { createDeployRoutes } from "../src/routes/deploys/index.js";
import { RoutesPool } from "./helpers/routesPool.js";

const admin: ActorContext = {
  userId: "user_alice",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member", "org:admin"],
  source: "session",
};

const memberOnly: ActorContext = {
  userId: "user_bob",
  orgId: "org_acme",
  projectId: null,
  scopes: ["org:member"],
  source: "session",
};

interface RecordingEvent {
  eventType: string;
  payload: unknown;
}

class RecordingEventStore implements EventStore {
  readonly appended: RecordingEvent[] = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appended.push({ eventType: input.eventType, payload: input.payload });
  }
}

function buildHarness(boundActor: ActorContext = admin) {
  const pool = new RoutesPool();
  pool.seedOrg({ id: "org_acme" });
  pool.seedMembership("org_acme", boundActor.userId, boundActor.scopes.includes("org:admin") ? "admin" : "member");
  pool.seedProject({ project_id: "proj_1", org_id: "org_acme", config: { version: 1 } });

  const attestations = new InMemoryManualAttestationStore();
  const events = new RecordingEventStore();

  const app = new Hono<ActorContextEnv>();
  app.use(
    "*",
    createAuthMiddleware({
      store: {
        async findApiTokenByRaw() {},
        async loadSession() {},
        async resolveActorContext() {
          return boundActor;
        },
      } as never,
      localDevActor: boundActor,
    }),
  );
  app.route("/orgs", createDeployRoutes({ pool: pool.asPgPool(), attestations, events }));
  return { app, pool, attestations, events };
}

async function postJson(app: Hono<ActorContextEnv>, path: string): Promise<{ status: number; body: any }> {
  const res = await app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

describe("deploy confirmation route", () => {
  it("flips a pending attestation → confirmed + emits `deploy.manual_confirmed` (H3 #21)", async () => {
    const { app, attestations, events } = buildHarness();
    // Seed a pending attestation the confirm route will flip.
    await attestations.record({
      deploymentId: "manual:proj_1@deadbeef",
      orgId: "org_acme",
      projectId: "proj_1",
      appId: "proj_1",
      attestation: {
        url: "https://acme-web.example.com",
        surfaceKind: "web_url",
        source: { repo: "acme/acme-web", ref: "deadbeef" },
      },
    });

    const { status, body } = await postJson(
      app,
      "/orgs/org_acme/projects/proj_1/deploys/manual%3Aproj_1%40deadbeef/confirm",
    );
    expect(status).toBe(200);
    expect(body.state).toBe("confirmed");
    expect(body.confirmedBy).toBe("user_alice");
    expect(body.freshlyConfirmed).toBe(true);
    // Emitted once, with the confirming operator as approvingActor.
    const emit = events.appended.find((e) => e.eventType === "deploy.manual_confirmed");
    expect(emit).toBeDefined();
    const payload = emit?.payload as Record<string, unknown>;
    expect(payload["confirmedBy"]).toBe("user_alice");
    expect(payload["deploymentId"]).toBe("manual:proj_1@deadbeef");
    expect(payload["provider"]).toBe(MANUAL_EXTERNAL_PROVIDER_KIND);
    // A subsequent verify() by the adapter would now see `confirmed` — status
    // reflects this on the persistent row.
    const row = await attestations.read("manual:proj_1@deadbeef");
    expect(row?.state).toBe("confirmed");
  });

  it("re-confirm is idempotent — no duplicate event, no re-written audit trail", async () => {
    const { app, attestations, events } = buildHarness();
    await attestations.record({
      deploymentId: "manual:proj_1@deadbeef",
      orgId: "org_acme",
      projectId: "proj_1",
      appId: "proj_1",
      attestation: {
        url: "https://acme-web.example.com",
        surfaceKind: "web_url",
        source: { repo: "acme/acme-web", ref: "deadbeef" },
      },
    });
    const first = await postJson(app, "/orgs/org_acme/projects/proj_1/deploys/manual%3Aproj_1%40deadbeef/confirm");
    expect(first.status).toBe(200);
    expect(first.body.freshlyConfirmed).toBe(true);
    // A second call with the SAME actor: freshlyConfirmed=false + no duplicate event.
    const second = await postJson(app, "/orgs/org_acme/projects/proj_1/deploys/manual%3Aproj_1%40deadbeef/confirm");
    expect(second.status).toBe(200);
    expect(second.body.freshlyConfirmed).toBe(false);
    expect(second.body.state).toBe("confirmed");
    const confirmEvents = events.appended.filter((e) => e.eventType === "deploy.manual_confirmed");
    expect(confirmEvents).toHaveLength(1);
  });

  it("denies a non-admin actor with 403 (org-admin required)", async () => {
    const { app, attestations } = buildHarness(memberOnly);
    await attestations.record({
      deploymentId: "manual:proj_1@deadbeef",
      orgId: "org_acme",
      projectId: "proj_1",
      appId: "proj_1",
      attestation: {
        url: "https://acme-web.example.com",
        surfaceKind: "web_url",
        source: { repo: "acme/acme-web", ref: "deadbeef" },
      },
    });
    const { status, body } = await postJson(
      app,
      "/orgs/org_acme/projects/proj_1/deploys/manual%3Aproj_1%40deadbeef/confirm",
    );
    expect(status).toBe(403);
    expect(body.error).toBe("org_admin_required");
    // The row is still pending (denial doesn't flip).
    const row = await attestations.read("manual:proj_1@deadbeef");
    expect(row?.state).toBe("pending_manual_confirmation");
  });

  it("404s for an unknown deployment id", async () => {
    const { app } = buildHarness();
    const { status, body } = await postJson(
      app,
      "/orgs/org_acme/projects/proj_1/deploys/manual%3Aproj_1%40never/confirm",
    );
    expect(status).toBe(404);
    expect(body.error).toBe("manual_deploy_attestation_not_found");
  });

  it("404s when the row is on a DIFFERENT project (path/project mismatch)", async () => {
    const { app, attestations } = buildHarness();
    // Record the attestation under `proj_1`, then hit the confirm route
    // addressing `proj_wrong` — the response guard denies the flip.
    await attestations.record({
      deploymentId: "manual:proj_1@deadbeef",
      orgId: "org_acme",
      projectId: "proj_1",
      appId: "proj_1",
      attestation: {
        url: "https://acme-web.example.com",
        surfaceKind: "web_url",
        source: { repo: "acme/acme-web", ref: "deadbeef" },
      },
    });
    const { status, body } = await postJson(
      app,
      "/orgs/org_acme/projects/proj_wrong/deploys/manual%3Aproj_1%40deadbeef/confirm",
    );
    expect(status).toBe(404);
    expect(body.error).toBe("manual_deploy_attestation_not_found");
  });
});
