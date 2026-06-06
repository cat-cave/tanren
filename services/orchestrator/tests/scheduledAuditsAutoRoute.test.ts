// Scheduled-audits → DAG auto-route behavior tests (the gap this PR closes).
//
// Proves that a scheduled audit run with a REAL (faked) answerer producing
// findings auto-routes each finding INTO THE DAG as a spec — not parking it in
// the inbox — and that this is idempotent (a re-run resolves the same candidate
// without a duplicate spec), and that a genuinely-empty audit is a clean pass
// (no spurious spec). Also exercises the real `createAnswererPassRunner`: it
// composes the read-only repo index + the audit answerer, and LOUD-fails for a
// repo-less job (§8a — never a silent empty pass).
//
// The pool is a SQL-substring stub (mirrors intakeAutonomous.test.ts) capturing
// the candidates + the spec INSERTs so the finding → spec hand-off is observable.

import type pg from "pg";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  AuditsStore,
  createAnswererPassRunner,
  runAuditJob,
  AuditJobNotProjectScopedError,
  type AuditAnswerer,
  type AuditJob,
  type AuditPassRunner,
} from "../src/engine/forge/audits/index.js";
import { createAuditRoutes } from "../src/routes/audits/index.js";
import type { ActorContext } from "../src/auth/schemas.js";
import type { ActorContextEnv } from "../src/middleware/auth.js";
import { intakeAutoRouteDeps } from "../src/engine/forge/intake/index.js";
import type { RepoReader } from "../src/engine/forge/brownfield/index.js";
import type { TriageAnswerer } from "../src/engine/forge/inbox/types.js";
import { createDeterministicTriageAnswerer } from "./fixtures/forge/deterministicTriageAnswerer.js";

// A stub pool tracking audit_jobs + inbox_sources + candidates + spec INSERTs so
// the full audit → auto-route → spec hand-off is observable.
function stubPool(existingSpecs: Array<{ spec_id: string; title: string; status: string }> = []): {
  pool: pg.Pool;
  candidates: Map<string, Record<string, unknown>>;
  specInserts: Array<{ specId: string; title: string; priority: string }>;
} {
  const jobs = new Map<string, Record<string, unknown>>();
  const sources = new Map<string, Record<string, unknown>>();
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const specInserts: Array<{ specId: string; title: string; priority: string }> = [];

  const candidateRow = (id: string) => {
    const c = candidates.get(id)!;
    return { ...c, source_name: "scheduled audits", source_kind: "scheduled_audit" };
  };

  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();

    if (sql.startsWith("INSERT INTO audit_jobs")) {
      const [id, orgId, projectId, kind, name, cadence, targetWindow, answererCli, enabled] = params as (
        | string
        | null
      )[];
      jobs.set(String(id), {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        cadence,
        target_window: targetWindow,
        answerer_cli: answererCli,
        enabled,
        last_run: null,
        findings: { count: 0, severity: "ok", note: "" },
      });
      return { rows: [{ ...jobs.get(String(id))! }], rowCount: 1 };
    }
    if (sql.includes("FROM audit_jobs WHERE id = $1")) {
      const j = jobs.get(String(params[0]));
      return j === undefined ? { rows: [], rowCount: 0 } : { rows: [{ ...j }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE audit_jobs SET last_run")) {
      const j = jobs.get(String(params[0]));
      if (j === undefined) return { rows: [], rowCount: 0 };
      j.last_run = params[1];
      j.findings = JSON.parse(String(params[2]));
      return { rows: [{ ...j }], rowCount: 1 };
    }

    if (sql.includes("FROM inbox_sources WHERE org_id")) {
      const list = [...sources.values()].filter((s) => s.org_id === params[0]);
      return { rows: list, rowCount: list.length };
    }
    if (sql.startsWith("INSERT INTO inbox_sources")) {
      const [id, orgId, projectId, kind, name, detail, , enabled, autoRoute] = params as (string | null)[];
      sources.set(String(id), {
        id,
        org_id: orgId,
        project_id: projectId,
        kind,
        name,
        detail,
        config: {},
        enabled,
        auto_route: autoRoute,
      });
      return { rows: [{ ...sources.get(String(id))! }], rowCount: 1 };
    }

    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) {
      return { rows: existingSpecs, rowCount: existingSpecs.length };
    }
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    if (sql.startsWith("SELECT metadata FROM specs")) return { rows: [{ metadata: {} }], rowCount: 1 };
    if (sql.startsWith("UPDATE specs SET metadata")) return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      specInserts.push({ specId: String(params[0]), title: String(params[2]), priority: String(params[7]) });
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith("INSERT INTO candidates")) {
      const [id, sourceId, orgId, projectId, externalId, title, body, severity, status, triage] = params as string[];
      const key = `${sourceId}::${externalId}`;
      const existingId = byExternal.get(key);
      const cid = existingId ?? id;
      const existing = existingId === undefined ? undefined : candidates.get(existingId);
      const preserveStatus =
        existing !== undefined && !["new", "triaged", "auto_routed"].includes(String(existing.status));
      candidates.set(cid, {
        ...existing,
        id: cid,
        source_id: sourceId,
        org_id: orgId,
        project_id: projectId,
        external_id: externalId,
        title,
        body,
        severity,
        status: preserveStatus ? existing.status : status,
        triage: JSON.parse(triage),
        resolved_spec_id: existing?.resolved_spec_id ?? null,
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
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, candidates, specInserts };
}

const findingRunner = (
  findings: { externalId: string; title: string; body: string; severity: "info" | "warn" | "fail" }[],
): AuditPassRunner => ({ run: async () => ({ findings }) });

describe("runAuditJob → DAG auto-route", () => {
  it("commits each audit finding as a spec in the DAG (not parked in the inbox)", async () => {
    const { pool, candidates, specInserts } = stubPool();
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "perf",
      name: "perf",
      cadence: "nightly",
    });
    const result = await runAuditJob(
      {
        pool,
        passRunner: findingRunner([
          { externalId: "n-plus-1-listUsers", title: "N+1 in listUsers", body: "batch the query", severity: "warn" },
        ]),
        answerer: createDeterministicTriageAnswerer(),
        autoRoute: intakeAutoRouteDeps(),
        now: () => new Date("2026-06-01T03:00:00Z"),
      },
      job,
    );

    // The finding became a SPEC in the DAG, and the candidate resolved `accepted`.
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.title).toBe("N+1 in listUsers");
    expect(specInserts[0]!.priority).toBe("P2");
    const cand = result.candidates[0]!;
    expect(cand.status).toBe("accepted");
    expect(cand.resolvedSpecId).toMatch(/^spec_/u);
    expect(candidates.size).toBe(1);
  });

  it("is idempotent — re-running the same audit does not duplicate the spec", async () => {
    const { pool, candidates, specInserts } = stubPool();
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "security",
      name: "sec",
      cadence: "nightly",
    });
    const deps = {
      pool,
      passRunner: findingRunner([
        { externalId: "injection-login", title: "Injection in login", body: "param it", severity: "fail" },
      ]),
      answerer: createDeterministicTriageAnswerer(),
      autoRoute: intakeAutoRouteDeps(),
    };
    await runAuditJob(deps, job);
    await runAuditJob(deps, job);
    // One candidate (idempotent on (source_id, external_id)). The re-run upserts
    // the same candidate; no second spec is created for the same finding.
    expect(candidates.size).toBe(1);
    expect(specInserts).toHaveLength(1);
  });

  it("grounds audit triage in the project's existing specs", async () => {
    const seenExistingSpecs: Array<{ specId: string; title: string; status: string }> = [];
    const { pool } = stubPool([{ spec_id: "spec_existing", title: "existing audit fix", status: "merged" }]);
    const deterministic = createDeterministicTriageAnswerer();
    const answerer: TriageAnswerer = {
      triage: async (context) => {
        seenExistingSpecs.push(...context.existingSpecs);
        return deterministic.triage(context);
      },
    };
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "security",
      name: "sec",
      cadence: "nightly",
    });

    await runAuditJob(
      {
        pool,
        passRunner: findingRunner([
          { externalId: "existing-audit-fix", title: "Existing audit fix", body: "already fixed", severity: "warn" },
        ]),
        answerer,
      },
      job,
    );

    expect(seenExistingSpecs).toEqual([{ specId: "spec_existing", title: "existing audit fix", status: "merged" }]);
  });

  it("a genuinely-empty audit is a clean pass with no spec", async () => {
    const { pool, specInserts, candidates } = stubPool();
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "deps",
      name: "deps",
      cadence: "nightly",
    });
    const result = await runAuditJob(
      {
        pool,
        passRunner: findingRunner([]),
        answerer: createDeterministicTriageAnswerer(),
        autoRoute: intakeAutoRouteDeps(),
      },
      job,
    );
    expect(specInserts).toHaveLength(0);
    expect(candidates.size).toBe(0);
    expect(result.job.findings.severity).toBe("ok");
    expect(result.job.lastRun).not.toBeNull();
  });
});

// ── The real Answerer-backed pass runner ────────────────────────────────────

const fakeRepoReader: RepoReader = {
  index: async (repoUrl) => ({
    repoUrl,
    filesIndexed: 1,
    files: [{ path: "src/users.ts", size: 100, preview: "for (const u of users) { await db.find(u) }" }],
  }),
};

const fakeAuditAnswerer: AuditAnswerer = {
  audit: async () => ({
    findings: [{ externalId: "n-plus-1", title: "N+1 query", body: "batch it", severity: "warn" }],
  }),
};

// A secret store returning a fake token for the org's default github credential
// ref, so `resolveGithubToken` (static path) resolves without a real provider.
const fakeSecrets = {
  get: async (ref: string) => (ref === "gh/org" ? { value: "ghs_fake" } : undefined),
} as never;

const repoStubQuery = async (text: string): Promise<{ rows: unknown[]; rowCount: number }> => {
  const sql = text.replaceAll(/\s+/gu, " ").trim();
  if (sql.includes("SELECT repo_url, config FROM projects")) {
    return { rows: [{ repo_url: "https://github.com/cat-cave/app", config: {} }], rowCount: 1 };
  }
  if (sql.includes("SELECT config FROM organizations")) {
    // No App installation, an org-default static github credential ref.
    return { rows: [{ config: { version: 1, defaultCredentials: { github_token: "gh/org" } } }], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

function repoStubPool(): pg.Pool {
  return {
    query: repoStubQuery,
    connect: async () => ({ query: repoStubQuery, release() {} }),
  } as unknown as pg.Pool;
}

function passRunnerJob(projectId: string | null): AuditJob {
  return {
    id: "audit_1",
    orgId: "org_a",
    projectId,
    kind: "perf",
    name: "perf",
    cadence: "nightly",
    targetWindow: "",
    answererCli: "",
    enabled: true,
    lastRun: null,
    findings: { count: 0, severity: "ok", note: "" },
  };
}

describe("createAnswererPassRunner", () => {
  it("indexes the repo read-only and returns the answerer's findings", async () => {
    const runner = createAnswererPassRunner({
      pool: repoStubPool(),
      secrets: fakeSecrets,
      githubHttp: {} as never,
      answererFactory: () => fakeAuditAnswerer,
      repoReaderFor: () => fakeRepoReader,
    });
    const result = await runner.run(passRunnerJob("project_a"));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.externalId).toBe("n-plus-1");
    expect(result.findings[0]!.severity).toBe("warn");
  });

  it("LOUD-fails for a repo-less (project-less) job — never a silent empty pass", async () => {
    const runner = createAnswererPassRunner({
      pool: repoStubPool(),
      secrets: fakeSecrets,
      githubHttp: {} as never,
      answererFactory: () => fakeAuditAnswerer,
      repoReaderFor: () => fakeRepoReader,
    });
    await expect(runner.run(passRunnerJob(null))).rejects.toBeInstanceOf(AuditJobNotProjectScopedError);
  });
});

// ── The manual POST …/audits/:jobId/run route ───────────────────────────────

const adminActor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["org:admin"],
  source: "session",
};

describe("POST /:orgId/audits/:jobId/run", () => {
  it("uses the injected pass runner + auto-routes the finding into the DAG", async () => {
    const { pool, candidates, specInserts } = stubPool();
    const job = await AuditsStore.createAuditJob(pool, {
      orgId: "org_a",
      projectId: "project_a",
      kind: "perf",
      name: "perf",
      cadence: "nightly",
    });

    const app = new Hono<ActorContextEnv>();
    app.use("*", async (c, next) => {
      c.set("actor", adminActor);
      await next();
    });
    app.route(
      "/orgs",
      createAuditRoutes({
        pool,
        passRunner: findingRunner([
          { externalId: "slow-render", title: "slow render path", body: "memoize it", severity: "warn" },
        ]),
        answererFactory: () => createDeterministicTriageAnswerer(),
      }),
    );

    const res = await app.request(`/orgs/org_a/audits/${job.id}/run`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { candidates: Array<{ status: string; resolvedSpecId: string | null }> };
    // The finding routed all the way to a spec (status accepted + a spec INSERT).
    expect(body.candidates[0]!.status).toBe("accepted");
    expect(specInserts).toHaveLength(1);
    expect(specInserts[0]!.title).toBe("slow render path");
    expect(candidates.size).toBe(1);
  });
});
