// P1d autonomous intake behavior tests (autonomy-engine.md §1d).
//
// Proves the four pieces of the autonomous-intake contract end-to-end over the
// real engine code (a SQL-substring stub pool, mirroring inboxEngine.test.ts):
//   1. a webhook event → triage → auto_routable → a spec INSERTED INTO THE DAG
//      carrying the model's priority + dependsOn (P1b), candidate resolved.
//   2. a non-routable webhook event → the candidate rests in the inbox.
//   3. the poll fallback ingests a source on its interval (and skips a
//      webhook-driven source — push is authoritative).
//   4. a webhook with a missing/bad signature is rejected (no intake).

import type pg from "pg";
import { describe, expect, it } from "vitest";
import {
  intakeItem,
  mapGithubIssueWebhook,
  verifyGithubSignature,
  intakeAutoRouteDeps,
  IntakePoller,
  isPollableSource,
} from "../src/engine/forge/intake/index.js";
import { createHmac } from "node:crypto";
import type {
  CandidateTriage,
  InboxSource,
  SourceConnector,
  TriageAnswerer,
  TriageRoutableSpec,
} from "../src/engine/forge/inbox/index.js";

const issuesSource: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "",
  config: { owner: "cat-cave", repo: "app" },
  enabled: true,
  autoRoute: false,
};

// A triage answerer that returns a fixed verdict — the model stand-in (tests
// never hit a provider). When `routableSpec` is given, the verdict is
// auto_routable carrying that spec.
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

// Map a source object to its persisted row shape (the poller reads sources back).
function sourceRow(s: InboxSource): Record<string, unknown> {
  return {
    id: s.id,
    org_id: s.orgId,
    project_id: s.projectId,
    kind: s.kind,
    name: s.name,
    detail: s.detail,
    config: s.config,
    enabled: s.enabled ? "true" : "false",
    auto_route: s.autoRoute ? "true" : "false",
  };
}

// A stub pool capturing the spec INSERT (priority + depends_on) so the test
// asserts the DAG insert carried the model's ordering signals.
function stubPool(opts: { existingSpecIds?: string[] } = {}): {
  pool: pg.Pool;
  candidates: Map<string, Record<string, unknown>>;
  specInserts: Array<{ specId: string; priority: string; dependsOn: string[]; title: string }>;
} {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const specInserts: Array<{ specId: string; priority: string; dependsOn: string[]; title: string }> = [];
  const existing = new Set(opts.existingSpecIds ?? []);
  const candidateRow = (id: string) => {
    const c = candidates.get(id)!;
    return { ...c, source_name: issuesSource.name, source_kind: issuesSource.kind };
  };
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT DISTINCT org_id FROM inbox_sources")) {
      return { rows: [{ org_id: issuesSource.orgId }], rowCount: 1 };
    }
    if (sql.includes("FROM inbox_sources WHERE org_id = $1")) {
      return { rows: [sourceRow(issuesSource)], rowCount: 1 };
    }
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return {
        rows: [...existing].map((id) => ({ spec_id: id, title: id, status: "open" })),
        rowCount: existing.size,
      };
    }
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) {
      const wanted = (params[1] as string[]) ?? [];
      return { rows: wanted.filter((id) => existing.has(id)).map((id) => ({ spec_id: id })), rowCount: wanted.length };
    }
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
    if (sql.startsWith("SELECT c.id, c.source_id") && sql.includes("WHERE c.id = $1")) {
      const c = candidates.get(String(params[0]));
      return c === undefined ? { rows: [], rowCount: 0 } : { rows: [candidateRow(String(params[0]))], rowCount: 1 };
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
      specInserts.push({
        specId: String(params[0]),
        title: String(params[2]),
        dependsOn: (params[5] as string[]) ?? [],
        priority: String(params[7]),
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT metadata FROM specs")) return { rows: [{ metadata: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE specs SET metadata")) return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, candidates, specInserts };
}

// A minimal GitHub `issues` opened webhook payload.
function issuePayload(number: number, title: string, labels: string[] = []): unknown {
  return {
    action: "opened",
    issue: { number, title, body: "details", labels },
    repository: { owner: { login: "cat-cave" }, name: "app" },
  };
}

describe("webhook intake — auto_routable → spec in the DAG", () => {
  it("inserts a spec carrying the model's priority + dependsOn and resolves the candidate", async () => {
    const { pool, specInserts } = stubPool({ existingSpecIds: ["spec_dep1"] });
    const routableSpec: TriageRoutableSpec = {
      title: "add per-link analytics",
      description: "count clicks per short link",
      acceptanceCriteria: ["clicks counted", "exposed via api"],
      dependsOn: ["spec_dep1"],
      priority: "P1",
    };
    const mapped = mapGithubIssueWebhook(issuePayload(7, "add per-link analytics"), issuesSource.projectId);
    expect(mapped.kind).toBe("ingest");
    if (mapped.kind !== "ingest") throw new Error("unreachable");

    const outcome = await intakeItem(
      { pool, answerer: fixedTriage("auto_routable", routableSpec), autoRoute: intakeAutoRouteDeps() },
      issuesSource,
      mapped.item,
    );

    expect(outcome.kind).toBe("auto_routed");
    if (outcome.kind !== "auto_routed") throw new Error("unreachable");
    expect(outcome.candidate.status).toBe("accepted");
    expect(outcome.specId).toMatch(/^spec_/u);
    expect(outcome.candidate.resolvedSpecId).toBe(outcome.specId);
    // The DAG insert carried the model's priority + dependency edge (P1b).
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.priority).toBe("P1");
    expect(specInserts[0]!.dependsOn).toEqual(["spec_dep1"]);
    expect(specInserts[0]!.title).toBe("add per-link analytics");
  });
});

describe("webhook intake — non-routable → inbox", () => {
  it("lands a needs_call candidate in the inbox without inserting a spec", async () => {
    const { pool, specInserts } = stubPool();
    const mapped = mapGithubIssueWebhook(issuePayload(8, "vague idea"), issuesSource.projectId);
    if (mapped.kind !== "ingest") throw new Error("unreachable");
    const outcome = await intakeItem(
      { pool, answerer: fixedTriage("needs_call", null), autoRoute: intakeAutoRouteDeps() },
      issuesSource,
      mapped.item,
    );
    expect(outcome.kind).toBe("inboxed");
    if (outcome.kind !== "inboxed") throw new Error("unreachable");
    expect(outcome.candidate.status).toBe("triaged");
    expect(specInserts).toHaveLength(0);
  });
});

describe("poll fallback", () => {
  const oneIssueConnector: SourceConnector = {
    kind: "issues",
    fetch: async (source) => [
      {
        externalId: "gh-cat-cave/app#9",
        title: "polled issue",
        body: "b",
        severity: "info",
        projectId: source.projectId,
      },
    ],
  };

  it("ingests a source on its interval and auto-routes through the DAG", async () => {
    const { pool, specInserts } = stubPool();
    const routableSpec: TriageRoutableSpec = {
      title: "polled feature",
      description: "from the poller",
      acceptanceCriteria: ["works"],
      dependsOn: [],
      priority: "P2",
    };
    let nowMs = 1_000_000;
    const poller = new IntakePoller(
      {
        pool,
        connectors: new Map([["issues", oneIssueConnector]]),
        answererFactory: () => fixedTriage("auto_routable", routableSpec),
        autoRoute: intakeAutoRouteDeps(),
        now: () => nowMs,
      },
      // tick interval irrelevant — we call tick() directly.
      60_000,
    );
    // First tick: the source has never been polled → due → ingests + auto-routes.
    const first = await poller.tick();
    expect(first).toHaveLength(1);
    expect(first[0]!.candidates[0]!.status).toBe("accepted");
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.priority).toBe("P2");

    // Immediately after, the source is NOT due (interval not elapsed) → skipped.
    const second = await poller.tick();
    expect(second).toHaveLength(0);

    // After the interval elapses, it is due again.
    nowMs += 6 * 60_000;
    const third = await poller.tick();
    expect(third).toHaveLength(1);
  });

  it("skips a webhook-driven source (push is authoritative)", () => {
    const connectors = new Map<string, SourceConnector>([["issues", oneIssueConnector]]);
    const webhookDriven: InboxSource = {
      ...issuesSource,
      config: { ...issuesSource.config, webhookSecretRef: "wh/src_gh" },
    };
    expect(isPollableSource(issuesSource, connectors)).toBe(true);
    expect(isPollableSource(webhookDriven, connectors)).toBe(false);
  });
});

describe("webhook signature verification (mandatory — §1d)", () => {
  const secret = "top-secret-webhook-key";
  const body = JSON.stringify(issuePayload(10, "signed issue"));
  const goodSig = `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

  it("accepts a correctly-signed body", () => {
    expect(verifyGithubSignature({ rawBody: body, signatureHeader: goodSig, secret }).ok).toBe(true);
  });

  it("rejects a missing signature header", () => {
    const check = verifyGithubSignature({ rawBody: body, signatureHeader: undefined, secret });
    expect(check.ok).toBe(false);
  });

  it("rejects a tampered body (signature mismatch)", () => {
    const check = verifyGithubSignature({ rawBody: `${body} tampered`, signatureHeader: goodSig, secret });
    expect(check.ok).toBe(false);
  });

  it("rejects when no secret is configured for the source (no unauthenticated intake)", () => {
    const check = verifyGithubSignature({ rawBody: body, signatureHeader: goodSig, secret: "" });
    expect(check.ok).toBe(false);
  });
});
