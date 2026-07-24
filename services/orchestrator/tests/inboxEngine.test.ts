// Candidate-inbox engine behavior tests (mutation ratchet).
//
// Pins the ingest pipeline's source-selection + status mapping, the
// accept->discovery hand-off's not-found / not-placeable / specId-fallback
// branches, and the fold/dismiss/closeDuplicate status transitions + their
// not-found errors. Drives the real engine over a SQL-substring stub pool
// (mirroring candidateInbox.test.ts) and asserts observed candidate state, not
// spies.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import {
  CandidateNotFoundError,
  CandidateNotPlaceableError,
  acceptCandidate,
  closeDuplicateCandidate,
  createGitHubIssuesConnector,
  dismissCandidate,
  foldCandidate,
  ingestSource,
  type InboxEngineDeps,
  type InboxSource,
  type SourceConnector,
} from "../src/engine/forge/inbox/index.js";
import { createDeterministicTriageAnswerer } from "./fixtures/forge/deterministicTriageAnswerer.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: "project_a",
  scopes: ["platform:admin"],
  source: "session",
};

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

const auditSource: InboxSource = {
  ...issuesSource,
  id: "src_audit",
  kind: "scheduled_audit",
  name: "scheduled audits",
  autoRoute: true,
};

function stubPool(): {
  pool: pg.Pool;
  candidates: Map<string, Record<string, unknown>>;
  specs: Map<string, unknown>;
} {
  const candidates = new Map<string, Record<string, unknown>>();
  const byExternal = new Map<string, string>();
  const specs = new Map<string, unknown>();
  const sources = new Map<string, InboxSource>([
    [issuesSource.id, issuesSource],
    [auditSource.id, auditSource],
  ]);
  const candidateRow = (id: string) => {
    const c = candidates.get(id)!;
    const src = sources.get(c.source_id as string)!;
    return { ...c, source_name: src.name, source_kind: src.kind };
  };
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT spec_id, title, status FROM specs")) return { rows: [], rowCount: 0 };
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
    // v68 fix: createSpec now loads org_id off projects (NOT NULL).
    if (sql.startsWith("SELECT org_id FROM projects")) return { rows: [{ org_id: "org_test" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO specs")) {
      specs.set(String(params[0]), { metadata: {} });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT metadata FROM specs")) {
      const row = specs.get(String(params[0]));
      return row === undefined ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE specs SET metadata")) {
      specs.set(String(params[0]), { metadata: JSON.parse(String(params[1])) });
      return { rows: [{ spec_id: params[0] }], rowCount: 1 };
    }
    if (sql.includes("FROM spec_dependencies") || sql.startsWith("INSERT INTO spec_dependencies")) {
      return { rows: [], rowCount: 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, candidates, specs };
}

function depsFor(connectors: ReadonlyMap<string, SourceConnector>, pool: pg.Pool): InboxEngineDeps {
  // The deterministic triage fixture stands in for the real provider answerer.
  return { pool, connectors, answerer: createDeterministicTriageAnswerer() };
}

const oneItemConnector = (kind: SourceConnector["kind"]): SourceConnector => ({
  kind,
  fetch: async (source) => [
    { externalId: "x-1", title: "csv export", body: "b", severity: "info", projectId: source.projectId },
  ],
});

describe("ingestSource — source selection + status mapping", () => {
  it("returns no candidates for a disabled source without touching the connector", async () => {
    let called = false;
    const connector: SourceConnector = {
      kind: "issues",
      fetch: async () => {
        called = true;
        return [];
      },
    };
    const { pool, candidates } = stubPool();
    const out = await ingestSource(depsFor(new Map([["issues", connector]]), pool), {
      ...issuesSource,
      enabled: false,
    });
    expect(out.candidates).toHaveLength(0);
    expect(called).toBe(false);
    expect(candidates.size).toBe(0);
  });

  it("rejects malformed provider data before candidate creation", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/github/org/org_a/default", value: "token" });
    const connector = createGitHubIssuesConnector({
      secrets,
      defaultStaticRef: "credential/github/org/org_a/default",
      githubHttp: {
        async request() {
          return {
            status: 200,
            body: [
              { number: 1, title: "valid", labels: [] },
              { number: 2, title: "malformed PR marker", labels: [], pull_request: "not an object" },
            ],
          };
        },
      },
    });
    const { pool, candidates } = stubPool();

    await expect(ingestSource(depsFor(new Map([["issues", connector]]), pool), issuesSource)).rejects.toThrow(
      "Invalid input",
    );
    expect(candidates.size).toBe(0);
  });

  it("returns no candidates when no connector is registered for the source kind", async () => {
    const { pool } = stubPool();
    const out = await ingestSource(depsFor(new Map(), pool), issuesSource);
    expect(out.candidates).toHaveLength(0);
  });

  it("persists an external source's candidate as triaged (needs_call verdict)", async () => {
    const { pool } = stubPool();
    const out = await ingestSource(depsFor(new Map([["issues", oneItemConnector("issues")]]), pool), issuesSource);
    expect(out.candidates[0]!.status).toBe("triaged");
    expect(out.candidates[0]!.triage?.verdict).toBe("needs_call");
  });

  it("promotes an auto-routable system source's candidate to auto_routed", async () => {
    const { pool } = stubPool();
    const out = await ingestSource(
      depsFor(new Map([["scheduled_audit", oneItemConnector("scheduled_audit")]]), pool),
      auditSource,
    );
    expect(out.candidates[0]!.status).toBe("auto_routed");
    expect(out.candidates[0]!.triage?.verdict).toBe("auto_routable");
  });
});

describe("accept -> discovery hand-off", () => {
  async function ingestOne(deps: InboxEngineDeps): Promise<string> {
    const { candidates } = await ingestSource(deps, issuesSource);
    return candidates[0]!.id;
  }

  const acceptInput = (candidateId: string) => ({
    candidateId,
    orgId: "org_a",
    proposals: [
      {
        proposalId: "p1",
        title: "add csv export",
        description: "button + endpoint",
        acceptanceCriteria: ["exports csv"],
        dependsOn: [],
        priority: "P1" as const,
        estLabel: "2h",
      },
    ],
    placementKind: "jump_backlog" as const,
    placementLabel: "jump the p1 backlog",
    actor,
  });

  it("creates a spec, resolves the candidate to accepted, and stamps the new spec id", async () => {
    const { pool, specs } = stubPool();
    const deps = depsFor(new Map([["issues", oneItemConnector("issues")]]), pool);
    const candidateId = await ingestOne(deps);
    const result = await acceptCandidate(deps, acceptInput(candidateId));
    expect(result.candidate.status).toBe("accepted");
    expect(result.specId).toMatch(/^spec_/u);
    expect(result.candidate.resolvedSpecId).toBe(result.specId);
    expect(specs.size).toBe(1);
  });

  it("throws CandidateNotFoundError for an unknown candidate id", async () => {
    const { pool } = stubPool();
    const deps = depsFor(new Map(), pool);
    await expect(acceptCandidate(deps, acceptInput("cand_missing"))).rejects.toBeInstanceOf(CandidateNotFoundError);
  });

  it("throws CandidateNotPlaceableError when the candidate has no project", async () => {
    const { pool } = stubPool();
    const deps = depsFor(new Map([["issues", oneItemConnector("issues")]]), pool);
    // ingest a candidate whose item carries a null projectId.
    const nullProjectConnector: SourceConnector = {
      kind: "issues",
      fetch: async () => [{ externalId: "np-1", title: "x", body: "", severity: "info", projectId: null }],
    };
    const { candidates } = await ingestSource(depsFor(new Map([["issues", nullProjectConnector]]), pool), {
      ...issuesSource,
      projectId: null,
    });
    await expect(acceptCandidate(deps, acceptInput(candidates[0]!.id))).rejects.toBeInstanceOf(
      CandidateNotPlaceableError,
    );
  });
});

describe("fold / dismiss / close-duplicate transitions", () => {
  async function ingestOne(): Promise<{ deps: InboxEngineDeps; id: string }> {
    const { pool } = stubPool();
    const deps = depsFor(new Map([["issues", oneItemConnector("issues")]]), pool);
    const { candidates } = await ingestSource(deps, issuesSource);
    return { deps, id: candidates[0]!.id };
  }

  it("fold transitions the candidate to folded", async () => {
    const { deps, id } = await ingestOne();
    expect((await foldCandidate(deps, id)).status).toBe("folded");
  });

  it("dismiss transitions the candidate to dismissed", async () => {
    const { deps, id } = await ingestOne();
    expect((await dismissCandidate(deps, id)).status).toBe("dismissed");
  });

  it("close-duplicate transitions the candidate to closed_duplicate", async () => {
    const { deps, id } = await ingestOne();
    expect((await closeDuplicateCandidate(deps, id)).status).toBe("closed_duplicate");
  });

  it("each transition throws CandidateNotFoundError for an unknown id", async () => {
    const { pool } = stubPool();
    const deps = depsFor(new Map(), pool);
    await expect(foldCandidate(deps, "cand_x")).rejects.toBeInstanceOf(CandidateNotFoundError);
    await expect(dismissCandidate(deps, "cand_x")).rejects.toBeInstanceOf(CandidateNotFoundError);
    await expect(closeDuplicateCandidate(deps, "cand_x")).rejects.toBeInstanceOf(CandidateNotFoundError);
  });
});
