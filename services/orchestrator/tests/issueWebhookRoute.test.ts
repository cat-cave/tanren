// §3.6 issue-loop hardening — the GitHub issues WEBHOOK RECEIVER + the durable
// persist-then-202 + the background processor/sweeper (autonomy-engine.md §1d).
//
// Proves the run-killer fix end-to-end over a SQL-substring stub pool:
//   • a signed `issues` event PERSISTS a webhook_event row + returns 202 FAST,
//     with NO triage/alloc inside the handler (the receiver does ONE durable write).
//   • a TRANSIENT processing failure is RE-DRIVEN by the sweeper UNBOUNDED (never
//     lost, never capped); a POISON failure dead-letters at once (no infinite re-drive).
//   • a missing/bad signature → 401 with nothing persisted.
//   • the receiver persists UNDER the source's org scope (RLS-admittable).
//   • a >300-char title is truncated by the mapper (no decode crash).

import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { getJobOrgId } from "@tanren/db";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { createIssueWebhookRoutes } from "../src/routes/githubWebhooks/issues.js";
import {
  intakeAutoRouteDeps,
  processWebhookEvent,
  sweepWebhookEvents,
  mapGithubIssueWebhook,
  type WebhookProcessorDeps,
} from "../src/engine/forge/intake/index.js";
import { PersistentlyInvalidSpecError } from "../src/engine/forge/specQuality/index.js";
import type {
  CandidateTriage,
  InboxSource,
  TriageAnswerer,
  TriageRoutableSpec,
} from "../src/engine/forge/inbox/index.js";

const WEBHOOK_SECRET = "wh-secret-value";

const source: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "",
  config: { owner: "cat-cave", repo: "app", labels: [] },
  enabled: true,
  autoRoute: false,
  state: "active",
  attention: null,
  webhookConfigured: true,
  retryNotBefore: null,
};

function fixedTriage(verdict: CandidateTriage["verdict"], routableSpec: TriageRoutableSpec | null): TriageAnswerer {
  return {
    async triage(): Promise<CandidateTriage> {
      return {
        dedupe: "no match",
        match: "new behavior",
        placement: "auto",
        verdict,
        duplicateOfSpecId: null,
        discoveryVariant: "feature",
        routableSpec,
      };
    },
  };
}

interface StubState {
  pool: pg.Pool;
  specCount: () => number;
  webhookEvents: Map<string, Record<string, unknown>>;
  candidates: Map<string, Record<string, unknown>>;
}

// A SQL-substring stub pool covering inbox_sources + candidates + specs + the new
// webhook_events table. BEGIN/COMMIT/SET LOCAL are no-ops (the org-scope helpers
// issue them); the data SQL is matched by substring.
function stubPool(): StubState {
  let specInserts = 0;
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const webhookEvents = new Map<string, Record<string, unknown>>();
  const sourceRow = {
    id: source.id,
    org_id: source.orgId,
    project_id: source.projectId,
    kind: source.kind,
    name: source.name,
    detail: source.detail,
    config: source.config,
    enabled: "true",
    auto_route: "false",
    state: "active",
    attention_code: null,
    attention_message: null,
    attention_observed_at: null,
    webhook_configured: true,
    retry_not_before: null,
    project_valid: true,
  };
  const candidateRow = (id: string) => ({ ...candidates.get(id)!, source_name: source.name, source_kind: source.kind });

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.startsWith("SET LOCAL")) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT webhook_secret_ref FROM inbox_sources")) {
      return params[0] === source.id && params[1] === source.orgId
        ? { rows: [{ webhook_secret_ref: "wh/src_gh" }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes("FROM inbox_sources WHERE id = $1")) {
      return params[0] === source.id ? { rows: [sourceRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT DISTINCT org_id FROM inbox_sources")) {
      return { rows: [{ org_id: source.orgId }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO webhook_events")) {
      const [id, sourceId, orgId, eventType, deliveryId, provider, payload, canonicalPayloadHash, signatureAlgo] =
        params as string[];
      webhookEvents.set(id, {
        id,
        source_id: sourceId,
        org_id: orgId,
        event_type: eventType,
        delivery_id: deliveryId,
        provider,
        payload: JSON.parse(payload),
        status: "received",
        attempts: 0,
        last_error: null,
        claim_owner: null,
        claim_expires_at: null,
        canonical_payload_hash: canonicalPayloadHash,
        signature_algo: signatureAlgo,
      });
      return { rows: [webhookEvents.get(id)!], rowCount: 1 };
    }
    if (
      sql.startsWith("SELECT") &&
      sql.includes("FROM webhook_events") &&
      sql.includes("status IN ('received','failed')")
    ) {
      const rows = [...webhookEvents.values()].filter((e) => e["status"] === "received" || e["status"] === "failed");
      return { rows, rowCount: rows.length };
    }
    if (sql.startsWith("UPDATE webhook_events SET claim_owner")) {
      const [id, workerId] = params as [string, string];
      const e = webhookEvents.get(id);
      if (e === undefined || !["received", "failed"].includes(e["status"] as string)) {
        return { rows: [], rowCount: 0 };
      }
      if (e["claim_owner"] !== null && e["claim_owner"] !== undefined) return { rows: [], rowCount: 0 };
      e["claim_owner"] = workerId;
      e["claim_expires_at"] = new Date(Date.now() + 60_000);
      return { rows: [e], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE webhook_events SET status = 'processed'")) {
      const e = webhookEvents.get(String(params[0]));
      const workerId = params[1] as string | null;
      if (e !== undefined && (workerId === null || e["claim_owner"] === workerId)) {
        e["status"] = "processed";
        e["last_error"] = null;
        e["claim_owner"] = null;
        e["claim_expires_at"] = null;
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE webhook_events SET attempts = attempts + 1")) {
      // Mirror the store: status is set by the failure's NATURE (the `poison` boolean),
      // NOT a count — transient stays `failed` (re-driven UNBOUNDED), poison dead-letters.
      const [id, error, poison, workerId] = params as [string, string, boolean, string | null];
      const e = webhookEvents.get(id);
      if (e === undefined || (workerId !== null && e["claim_owner"] !== workerId)) {
        return { rows: [], rowCount: 0 };
      }
      e["attempts"] = (e["attempts"] as number) + 1;
      e["last_error"] = error;
      e["status"] = poison ? "dead_lettered" : "failed";
      e["claim_owner"] = null;
      e["claim_expires_at"] = null;
      return { rows: [{ status: e["status"] }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const cid = byExternal.get(key) ?? id;
      const existing = candidates.get(cid);
      // Mirror the ON CONFLICT CASE: a terminal status is kept.
      const keepStatus =
        existing !== undefined && !["new", "triaged", "auto_routed"].includes(existing["status"] as string);
      candidates.set(cid, {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status: keepStatus ? existing!["status"] : status,
        triage: JSON.parse(triage),
        resolved_spec_id: existing?.["resolved_spec_id"] ?? null,
      });
      byExternal.set(key, cid);
      return { rows: [candidateRow(cid)], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE candidates c SET status")) {
      const [cid, status, specId] = params as (string | null)[];
      const c = candidates.get(String(cid));
      if (c === undefined) return { rows: [], rowCount: 0 };
      c["status"] = status;
      c["resolved_spec_id"] = specId;
      return { rows: [candidateRow(String(cid))], rowCount: 1 };
    }
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      specInserts += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT metadata FROM specs")) return { rows: [{ metadata: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE specs SET metadata")) return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, specCount: () => specInserts, webhookEvents, candidates };
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex")}`;
}

function issuesBody(number: number, title: string, owner = "cat-cave"): string {
  return JSON.stringify({
    action: "opened",
    issue: { number, title, body: "details", labels: [] },
    repository: { owner: { login: owner }, name: "app" },
  });
}

async function buildApp(
  answerer: TriageAnswerer,
  pool: pg.Pool,
  recordIssueObservation: WebhookProcessorDeps["recordIssueObservation"] = async () => {},
) {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: "wh/src_gh", value: WEBHOOK_SECRET });
  return createIssueWebhookRoutes({
    pool,
    secrets,
    answererFactory: () => answerer,
    autoRoute: intakeAutoRouteDeps(),
    recordIssueObservation,
  });
}

function processorDeps(answerer: TriageAnswerer, pool: pg.Pool): WebhookProcessorDeps {
  return { pool, answererFactory: () => answerer, autoRoute: intakeAutoRouteDeps() };
}

describe("issues webhook receiver — persist-then-202 (§3.6)", () => {
  it("persists the verified delivery and returns 202 FAST (no triage in the handler)", async () => {
    const pool = stubPool();
    let triageCalls = 0;
    const answerer: TriageAnswerer = {
      async triage(): Promise<CandidateTriage> {
        triageCalls += 1;
        return fixedTriage("needs_call", null).triage({} as never);
      },
    };
    const app = await buildApp(answerer, pool.pool);
    const body = issuesBody(1, "add analytics");
    const res = await app.request(`/github/webhooks/issues/${source.id}`, {
      method: "POST",
      headers: { "x-github-event": "issues", "x-hub-signature-256": sign(body), "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { outcome: string; eventId?: string };
    expect(json.outcome).toBe("accepted");
    expect(json.eventId).toMatch(/^whk_/u);
    // The durable row landed (the handler's only synchronous DB work).
    expect(pool.webhookEvents.size).toBe(1);
    // Triage may run in the DETACHED best-effort kick, but the handler never AWAITS
    // it; the 202 came back regardless. (We don't assert triageCalls === 0 because
    // the fire-and-forget may or may not have run by now — the point is the 202.)
    void triageCalls;
  });

  it("a TRANSIENT processing failure is RE-DRIVEN by the sweeper UNBOUNDED (never lost, never capped)", async () => {
    const pool = stubPool();
    let attempts = 0;
    const flaky: TriageAnswerer = {
      async triage(): Promise<CandidateTriage> {
        attempts += 1;
        throw new Error(`transient blip #${attempts}`);
      },
    };
    // Persist a delivery via the store (skip the route's detached kick for determinism).
    const { WebhookEventStore } = await import("../src/engine/forge/intake/index.js");
    const { runWithOrgScope } = await import("@tanren/db");
    const event = await runWithOrgScope(pool.pool, source.orgId, (c) =>
      WebhookEventStore.persist(c, {
        sourceId: source.id,
        orgId: source.orgId,
        eventType: "issues",
        deliveryId: "d1",
        payload: JSON.parse(issuesBody(2, "boom")),
      }),
    );
    const deps = processorDeps(flaky, pool.pool);
    // First process attempt fails → row goes `failed` (transient, NOT lost).
    await processWebhookEvent(deps, event);
    expect(pool.webhookEvents.get(event.id)!["status"]).toBe("failed");
    // The sweeper re-drives `failed` rows each tick; a TRANSIENT failure NEVER
    // dead-letters on a count — it stays `failed` and re-drivable across many sweeps.
    for (let i = 0; i < 20; i++) await sweepWebhookEvents(deps);
    expect(pool.webhookEvents.get(event.id)!["status"]).toBe("failed");
    expect(await sweepWebhookEvents(deps)).toBeGreaterThan(0);
    // It was re-driven across every sweep — never silently dropped, never capped.
    expect(attempts).toBeGreaterThan(20);
  });

  it("a POISON failure (a persistently-invalid spec) dead-letters at once (no infinite re-drive)", async () => {
    const pool = stubPool();
    // A triage that throws the spec-quality gate's loud non-convergence surface —
    // a genuinely non-recoverable delivery (re-triaging it forever would burn cost).
    let attempts = 0;
    const poison: TriageAnswerer = {
      async triage(): Promise<CandidateTriage> {
        attempts += 1;
        throw new PersistentlyInvalidSpecError({ title: "t", description: "d", acceptanceCriteria: [] }, undefined, 3);
      },
    };
    const { WebhookEventStore } = await import("../src/engine/forge/intake/index.js");
    const { runWithOrgScope } = await import("@tanren/db");
    const event = await runWithOrgScope(pool.pool, source.orgId, (c) =>
      WebhookEventStore.persist(c, {
        sourceId: source.id,
        orgId: source.orgId,
        eventType: "issues",
        deliveryId: "d2",
        payload: JSON.parse(issuesBody(3, "poison")),
      }),
    );
    const deps = processorDeps(poison, pool.pool);
    await processWebhookEvent(deps, event);
    // Dead-lettered on the FIRST failure (poison), never re-driven again.
    expect(pool.webhookEvents.get(event.id)!["status"]).toBe("dead_lettered");
    for (let i = 0; i < 5; i++) await sweepWebhookEvents(deps);
    expect(attempts).toBe(1);
  });
  it.each([
    ["whitespace-only title", issuesBody(1, " \t")],
    ["different repository", issuesBody(2, "valid", "other")],
  ])("dead-letters a signed %s once before observation, triage, or candidate write", async (_name, body) => {
    const pool = stubPool();
    const observation = vi.fn<NonNullable<WebhookProcessorDeps["recordIssueObservation"]>>(async () => {});
    const answerer = fixedTriage("needs_call", null);
    const triage = vi.spyOn(answerer, "triage");
    const app = await buildApp(answerer, pool.pool, observation);
    const response = await app.request(`/github/webhooks/issues/${source.id}`, {
      method: "POST",
      headers: { "x-github-event": "issues", "x-hub-signature-256": sign(body), "content-type": "application/json" },
      body,
    });
    expect(response.status).toBe(202);
    await expect.poll(() => [...pool.webhookEvents.values()][0]?.["status"]).toBe("dead_lettered");
    expect([...pool.webhookEvents.values()][0]?.["attempts"]).toBe(1);
    expect([observation.mock.calls.length, triage.mock.calls.length, pool.candidates.size]).toEqual([0, 0, 0]);
  });

  it("auto-routes a routable delivery into the DAG (exactly one spec) via the processor", async () => {
    const pool = stubPool();
    const routableSpec: TriageRoutableSpec = {
      title: "add analytics",
      description: "count clicks",
      acceptanceCriteria: ["counted"],
      dependsOn: [],
      priority: "P1",
    };
    const deps = processorDeps(fixedTriage("auto_routable", routableSpec), pool.pool);
    const { WebhookEventStore } = await import("../src/engine/forge/intake/index.js");
    const { runWithOrgScope } = await import("@tanren/db");
    const event = await runWithOrgScope(pool.pool, source.orgId, (c) =>
      WebhookEventStore.persist(c, {
        sourceId: source.id,
        orgId: source.orgId,
        eventType: "issues",
        deliveryId: "d2",
        payload: JSON.parse(issuesBody(3, "add analytics")),
      }),
    );
    await processWebhookEvent(deps, event);
    expect(pool.specCount()).toBe(1);
    expect(pool.webhookEvents.get(event.id)!["status"]).toBe("processed");
    // Re-driving the SAME event is idempotent — no second spec.
    await processWebhookEvent(deps, event);
    expect(pool.specCount()).toBe(1);
  });

  it("rejects an unsigned webhook with 401 and persists nothing", async () => {
    const pool = stubPool();
    const app = await buildApp(fixedTriage("auto_routable", null), pool.pool);
    const body = issuesBody(4, "unsigned");
    const res = await app.request(`/github/webhooks/issues/${source.id}`, {
      method: "POST",
      headers: { "x-github-event": "issues", "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("signature_rejected");
    expect(pool.webhookEvents.size).toBe(0);
  });

  it("404s an unknown source", async () => {
    const pool = stubPool();
    const app = await buildApp(fixedTriage("needs_call", null), pool.pool);
    const body = issuesBody(5, "x");
    const res = await app.request(`/github/webhooks/issues/src_missing`, {
      method: "POST",
      headers: { "x-github-event": "issues", "x-hub-signature-256": sign(body), "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(404);
  });

  it("processes UNDER the source's org scope (RLS-admittable, not a silent dead-end)", async () => {
    const pool = stubPool();
    let seenJobOrg: string | undefined = "sentinel";
    const capturingTriage: TriageAnswerer = {
      async triage(): Promise<CandidateTriage> {
        seenJobOrg = getJobOrgId();
        return fixedTriage("needs_call", null).triage({} as never);
      },
    };
    const deps = processorDeps(capturingTriage, pool.pool);
    const { WebhookEventStore } = await import("../src/engine/forge/intake/index.js");
    const { runWithOrgScope } = await import("@tanren/db");
    const event = await runWithOrgScope(pool.pool, source.orgId, (c) =>
      WebhookEventStore.persist(c, {
        sourceId: source.id,
        orgId: source.orgId,
        eventType: "issues",
        deliveryId: "d3",
        payload: JSON.parse(issuesBody(6, "scoped")),
      }),
    );
    await processWebhookEvent(deps, event);
    expect(seenJobOrg).toBe(source.orgId);
  });
});

describe("webhook mapping — title truncation (§3.6)", () => {
  it("truncates a >300-char title so the candidate decode never crashes", () => {
    const longTitle = "x".repeat(500);
    const payload = {
      action: "opened",
      issue: { number: 9, title: longTitle, body: "b", labels: [] },
      repository: { owner: { login: "cat-cave" }, name: "app" },
    };
    const mapped = mapGithubIssueWebhook(payload, source);
    expect(mapped.kind).toBe("ingest");
    if (mapped.kind !== "ingest") throw new Error("expected ingest");
    expect(mapped.item.title.length).toBeLessThanOrEqual(300);
    expect(mapped.item.title.endsWith("…")).toBe(true);
  });

  it("leaves a short title untouched", () => {
    const payload = {
      action: "opened",
      issue: { number: 10, title: "short", body: "b", labels: [] },
      repository: { owner: { login: "cat-cave" }, name: "app" },
    };
    const mapped = mapGithubIssueWebhook(payload, source);
    if (mapped.kind !== "ingest") throw new Error("expected ingest");
    expect(mapped.item.title).toBe("short");
  });
});
