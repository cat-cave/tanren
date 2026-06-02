// P1d — the GitHub issues WEBHOOK RECEIVER route (autonomy-engine.md §1d).
//
// Drives the real Hono route end-to-end over a stub pool + a fake secret store:
//   • a correctly-signed `issues` event whose triage is auto_routable → 200 with
//     `auto_routed` + a new spec id (the candidate became a DAG spec).
//   • a non-routable event → 200 `inboxed` (the candidate rests in the inbox).
//   • a missing/bad signature → 401, with NO ingest (signature is mandatory).

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { createIssueWebhookRoutes } from "../src/routes/githubWebhooks/issues.js";
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
  config: { owner: "cat-cave", repo: "app", webhookSecretRef: "wh/src_gh" },
  enabled: true,
  autoRoute: false,
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

function stubPool(): { pool: pg.Pool; specCount: () => number } {
  let specInserts = 0;
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
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
  };
  const candidateRow = (id: string) => ({ ...candidates.get(id)!, source_name: source.name, source_kind: source.kind });
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.includes("FROM inbox_sources WHERE id = $1")) {
      return params[0] === source.id ? { rows: [sourceRow], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const cid = byExternal.get(key) ?? id;
      candidates.set(cid, {
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status,
        triage: JSON.parse(triage),
        resolved_spec_id: null,
      });
      byExternal.set(key, cid);
      return { rows: [candidateRow(cid)], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE candidates c SET status")) {
      const [cid, status, specId] = params as (string | null)[];
      const c = candidates.get(String(cid));
      if (c === undefined) return { rows: [], rowCount: 0 };
      c.status = status;
      c.resolved_spec_id = specId;
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
  return { pool: pool as unknown as pg.Pool, specCount: () => specInserts };
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body, "utf8").digest("hex")}`;
}

function issuesBody(number: number, title: string): string {
  return JSON.stringify({
    action: "opened",
    issue: { number, title, body: "details", labels: [] },
    repository: { owner: { login: "cat-cave" }, name: "app" },
  });
}

async function buildApp(answerer: TriageAnswerer, pool: pg.Pool) {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: "wh/src_gh", value: WEBHOOK_SECRET });
  return createIssueWebhookRoutes({ pool, secrets, answererFactory: () => answerer });
}

describe("issues webhook route (P1d)", () => {
  it("auto-routes a signed, routable issue into the DAG", async () => {
    const pool = stubPool();
    const routableSpec: TriageRoutableSpec = {
      title: "add analytics",
      description: "count clicks",
      acceptanceCriteria: ["counted"],
      dependsOn: [],
      priority: "P1",
    };
    const app = await buildApp(fixedTriage("auto_routable", routableSpec), pool.pool);
    const body = issuesBody(1, "add analytics");
    const res = await app.request(`/github/webhooks/issues/${source.id}`, {
      method: "POST",
      headers: { "x-github-event": "issues", "x-hub-signature-256": sign(body), "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { outcome: string; specId?: string };
    expect(json.outcome).toBe("auto_routed");
    expect(json.specId).toMatch(/^spec_/u);
    expect(pool.specCount()).toBe(1);
  });

  it("inboxes a signed, non-routable issue (no spec)", async () => {
    const pool = stubPool();
    const app = await buildApp(fixedTriage("needs_call", null), pool.pool);
    const body = issuesBody(2, "vague");
    const res = await app.request(`/github/webhooks/issues/${source.id}`, {
      method: "POST",
      headers: { "x-github-event": "issues", "x-hub-signature-256": sign(body), "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect((await res.json()).outcome).toBe("inboxed");
    expect(pool.specCount()).toBe(0);
  });

  it("rejects an unsigned webhook with 401 and ingests nothing", async () => {
    const pool = stubPool();
    const app = await buildApp(fixedTriage("auto_routable", null), pool.pool);
    const body = issuesBody(3, "unsigned");
    const res = await app.request(`/github/webhooks/issues/${source.id}`, {
      method: "POST",
      headers: { "x-github-event": "issues", "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("signature_rejected");
    expect(pool.specCount()).toBe(0);
  });

  it("rejects a tampered body with 401", async () => {
    const pool = stubPool();
    const app = await buildApp(fixedTriage("needs_call", null), pool.pool);
    const body = issuesBody(4, "tampered");
    const res = await app.request(`/github/webhooks/issues/${source.id}`, {
      method: "POST",
      headers: {
        "x-github-event": "issues",
        "x-hub-signature-256": sign("different body"),
        "content-type": "application/json",
      },
      body,
    });
    expect(res.status).toBe(401);
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
});
