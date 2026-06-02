// Candidate-inbox store behavior tests (mutation ratchet).
//
// The store is pure SQL + row mapping over a `QueryClient`. These tests drive
// the real store functions through a recording stub client and assert BOTH the
// SQL the store issues (table/columns/params/conflict target) AND the
// `mapSource`/`mapCandidate` normalization it parses back — including the zod
// defaults that fire when a persisted row omits a field (the type-schema
// `.default(...)` mutants only a round-trip kills). No spies; every assertion is
// on an observed value.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { InboxStore, type CreateSourceInput } from "../src/engine/forge/inbox/index.js";
import type { CandidateTriage, IngestedItem, InboxSource } from "../src/engine/forge/inbox/index.js";

// The store methods exercised below; the `Repositories` seam owns the SQL, so the
// tests drive the same `InboxStore.*` surface the routes/engine/poller now use.
const { createSource, getCandidate, getSource, listCandidates, listSources, resolveCandidate, upsertCandidate } =
  InboxStore;

interface Call {
  sql: string;
  params: unknown[];
}

// A recording stub `QueryClient`: each handler is matched by an SQL substring
// and returns the rows the store will map. Records every call for wire-shape
// assertions.
function recorder(handlers: Array<{ match: string; rows: (params: unknown[]) => unknown[] }>): {
  client: pg.Pool;
  calls: Call[];
} {
  const calls: Call[] = [];
  const client = {
    async query(text: string, params: unknown[] = []) {
      const sql = text.replaceAll(/\s+/gu, " ").trim();
      calls.push({ sql, params });
      for (const h of handlers) {
        if (sql.includes(h.match)) {
          const rows = h.rows(params);
          return { rows, rowCount: rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    },
  };
  return { client: client as unknown as pg.Pool, calls };
}

describe("createSource — insert wire shape + mapping", () => {
  it("inserts into inbox_sources with the 9 ordered params and maps the returned row", async () => {
    const input: CreateSourceInput = {
      orgId: "org_a",
      projectId: "project_a",
      kind: "issues",
      name: "github · cat-cave",
      detail: "labelled spec-candidate",
      config: { owner: "cat-cave", repo: "app" },
      enabled: true,
      autoRoute: false,
    };
    const { client, calls } = recorder([
      {
        match: "INSERT INTO inbox_sources",
        rows: (p) => [
          {
            id: p[0],
            org_id: p[1],
            project_id: p[2],
            kind: p[3],
            name: p[4],
            detail: p[5],
            config: JSON.parse(p[6] as string),
            enabled: p[7],
            auto_route: p[8],
          },
        ],
      },
    ]);
    const source = await createSource(client, input);
    const call = calls[0]!;
    expect(call.sql).toContain("INSERT INTO inbox_sources");
    // id is generated with a src_ prefix; org/project/kind/name flow through in order.
    expect(String(call.params[0])).toMatch(/^src_/u);
    expect(call.params.slice(1, 6)).toEqual([
      "org_a",
      "project_a",
      "issues",
      "github · cat-cave",
      "labelled spec-candidate",
    ]);
    expect(JSON.parse(call.params[6] as string)).toEqual({ owner: "cat-cave", repo: "app" });
    // enabled/autoRoute are persisted as the string booleans the row mapper reads.
    expect(call.params[7]).toBe("true");
    expect(call.params[8]).toBe("false");
    expect(source.id).toMatch(/^src_/u);
    expect(source.enabled).toBe(true);
    expect(source.autoRoute).toBe(false);
  });

  it("defaults detail to empty, enabled to true, and autoRoute to false when omitted", async () => {
    const { client, calls } = recorder([
      {
        match: "INSERT INTO inbox_sources",
        rows: (p) => [
          {
            id: p[0],
            org_id: p[1],
            project_id: p[2],
            kind: p[3],
            name: p[4],
            detail: p[5],
            config: JSON.parse(p[6] as string),
            enabled: p[7],
            auto_route: p[8],
          },
        ],
      },
    ]);
    const source = await createSource(client, { orgId: "o", projectId: null, kind: "manual", name: "n" });
    expect(calls[0]!.params[5]).toBe("");
    expect(calls[0]!.params[6]).toBe("{}");
    expect(calls[0]!.params[7]).toBe("true");
    expect(calls[0]!.params[8]).toBe("false");
    expect(source.detail).toBe("");
    expect(source.projectId).toBeNull();
  });

  it("persists enabled=false and autoRoute=true as the matching string booleans", async () => {
    const { client, calls } = recorder([
      {
        match: "INSERT INTO inbox_sources",
        rows: (p) => [
          {
            id: p[0],
            org_id: p[1],
            project_id: p[2],
            kind: p[3],
            name: p[4],
            detail: p[5],
            config: JSON.parse(p[6] as string),
            enabled: p[7],
            auto_route: p[8],
          },
        ],
      },
    ]);
    const source = await createSource(client, {
      orgId: "o",
      projectId: null,
      kind: "system",
      name: "n",
      enabled: false,
      autoRoute: true,
    });
    expect(calls[0]!.params[7]).toBe("false");
    expect(calls[0]!.params[8]).toBe("true");
    expect(source.enabled).toBe(false);
    expect(source.autoRoute).toBe(true);
  });
});

describe("mapSource — string-boolean + null-config normalization", () => {
  it("maps enabled/auto_route string booleans (only 'true' is true) and a null config to {}", async () => {
    const { client } = recorder([
      {
        match: "FROM inbox_sources WHERE id = $1",
        rows: () => [
          {
            id: "src_1",
            org_id: "org_a",
            project_id: null,
            kind: "issues",
            name: "n",
            detail: "d",
            config: null,
            enabled: "false",
            auto_route: "true",
          },
        ],
      },
    ]);
    const source = await getSource(client, "src_1");
    expect(source).toBeDefined();
    expect(source!.enabled).toBe(false);
    expect(source!.autoRoute).toBe(true);
    expect(source!.config).toEqual({});
    expect(source!.projectId).toBeNull();
  });

  it("treats any non-'true' enabled string as false (the === 'true' comparison)", async () => {
    const { client } = recorder([
      {
        match: "FROM inbox_sources WHERE id = $1",
        rows: () => [
          {
            id: "src_2",
            org_id: "o",
            project_id: "p",
            kind: "manual",
            name: "n",
            detail: "",
            config: {},
            // "t" is not the literal "true", so it must map to false.
            enabled: "t",
            auto_route: "false",
          },
        ],
      },
    ]);
    const source = await getSource(client, "src_2");
    expect(source!.enabled).toBe(false);
  });

  it("returns undefined when no source row matches", async () => {
    const { client } = recorder([]);
    expect(await getSource(client, "src_missing")).toBeUndefined();
  });

  it("lists sources ordered by created_at, scoped to the org param", async () => {
    const { client, calls } = recorder([
      {
        match: "FROM inbox_sources WHERE org_id = $1",
        rows: () => [
          {
            id: "s1",
            org_id: "org_a",
            project_id: null,
            kind: "issues",
            name: "a",
            detail: "",
            config: {},
            enabled: "true",
            auto_route: "false",
          },
          {
            id: "s2",
            org_id: "org_a",
            project_id: null,
            kind: "errors",
            name: "b",
            detail: "",
            config: {},
            enabled: "true",
            auto_route: "false",
          },
        ],
      },
    ]);
    const sources = await listSources(client, "org_a");
    expect(calls[0]!.sql).toContain("ORDER BY created_at");
    expect(calls[0]!.params).toEqual(["org_a"]);
    expect(sources.map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});

const source: InboxSource = {
  id: "src_gh",
  orgId: "org_a",
  projectId: "project_a",
  kind: "issues",
  name: "github · cat-cave",
  detail: "",
  config: {},
  enabled: true,
  autoRoute: false,
};

const item: IngestedItem = {
  externalId: "gh-cat-cave/app#7",
  title: "csv export",
  body: "cfo wants csv",
  severity: "warn",
  projectId: "project_a",
};

const triage: CandidateTriage = {
  dedupe: "no match",
  match: "new behavior",
  placement: "your call",
  verdict: "needs_call",
  duplicateOfSpecId: null,
  discoveryVariant: "feature",
};

describe("upsertCandidate — insert/conflict wire shape + mapping", () => {
  it("inserts into candidates with the source/item/triage params and an upsert on (source_id, external_id)", async () => {
    const { client, calls } = recorder([
      {
        match: "INSERT INTO candidates",
        rows: (p) => [
          {
            id: p[0],
            source_id: p[1],
            org_id: p[2],
            project_id: p[3],
            external_id: p[4],
            title: p[5],
            body: p[6],
            severity: p[7],
            status: p[8],
            triage: JSON.parse(p[9] as string),
            resolved_spec_id: null,
            source_name: p[10],
            source_kind: p[11],
          },
        ],
      },
    ]);
    const candidate = await upsertCandidate(client, source, item, triage, "triaged");
    const call = calls[0]!;
    expect(call.sql).toContain("ON CONFLICT (source_id, external_id) DO UPDATE");
    expect(String(call.params[0])).toMatch(/^cand_/u);
    expect(call.params[1]).toBe("src_gh");
    expect(call.params[2]).toBe("org_a");
    expect(call.params[3]).toBe("project_a");
    expect(call.params[4]).toBe("gh-cat-cave/app#7");
    expect(call.params[5]).toBe("csv export");
    expect(call.params[6]).toBe("cfo wants csv");
    expect(call.params[7]).toBe("warn");
    expect(call.params[8]).toBe("triaged");
    expect(JSON.parse(call.params[9] as string)).toMatchObject({ verdict: "needs_call" });
    expect(call.params[10]).toBe("github · cat-cave");
    expect(call.params[11]).toBe("issues");
    expect(candidate.id).toMatch(/^cand_/u);
    expect(candidate.severity).toBe("warn");
    expect(candidate.status).toBe("triaged");
    expect(candidate.triage?.verdict).toBe("needs_call");
    expect(candidate.sourceName).toBe("github · cat-cave");
    expect(candidate.sourceKind).toBe("issues");
  });

  it("serializes a null triage as an empty JSON object and maps it back to a null triage", async () => {
    const { client, calls } = recorder([
      {
        match: "INSERT INTO candidates",
        rows: (p) => [
          {
            id: p[0],
            source_id: p[1],
            org_id: p[2],
            project_id: p[3],
            external_id: p[4],
            title: p[5],
            body: p[6],
            severity: p[7],
            status: p[8],
            triage: JSON.parse(p[9] as string),
            resolved_spec_id: null,
            source_name: p[10],
            source_kind: p[11],
          },
        ],
      },
    ]);
    const candidate = await upsertCandidate(client, source, item, null, "new");
    expect(calls[0]!.params[9]).toBe("{}");
    // an empty-object triage round-trips to a null triage (the hasTriage guard).
    expect(candidate.triage).toBeNull();
    expect(candidate.status).toBe("new");
  });
});

describe("mapCandidate — defaults + join-column normalization", () => {
  it("applies the source_name '' and source_kind 'manual' defaults when the join columns are null", async () => {
    const { client } = recorder([
      {
        match: "WHERE c.id = $1",
        rows: () => [
          {
            id: "cand_1",
            source_id: "src_gh",
            org_id: "org_a",
            project_id: null,
            external_id: "x-1",
            title: "t",
            body: "",
            severity: "info",
            status: "new",
            triage: null,
            resolved_spec_id: null,
            source_name: null,
            source_kind: null,
          },
        ],
      },
    ]);
    const candidate = await getCandidate(client, "cand_1");
    expect(candidate).toBeDefined();
    expect(candidate!.sourceName).toBe("");
    expect(candidate!.sourceKind).toBe("manual");
    expect(candidate!.triage).toBeNull();
    expect(candidate!.resolvedSpecId).toBeNull();
  });

  it("parses a stored triage that omits optional fields, applying the duplicateOfSpecId=null + discoveryVariant=feature defaults", async () => {
    const { client } = recorder([
      {
        match: "WHERE c.id = $1",
        rows: () => [
          {
            id: "cand_2",
            source_id: "src_gh",
            org_id: "org_a",
            project_id: "project_a",
            external_id: "x-2",
            title: "t",
            body: "b",
            severity: "fail",
            status: "triaged",
            // a triage object lacking duplicateOfSpecId + discoveryVariant.
            triage: { dedupe: "d", match: "m", placement: "p", verdict: "needs_call" },
            resolved_spec_id: null,
            source_name: "github",
            source_kind: "issues",
          },
        ],
      },
    ]);
    const candidate = await getCandidate(client, "cand_2");
    expect(candidate!.triage).not.toBeNull();
    expect(candidate!.triage!.duplicateOfSpecId).toBeNull();
    expect(candidate!.triage!.discoveryVariant).toBe("feature");
    expect(candidate!.severity).toBe("fail");
  });

  it("returns undefined when no candidate row matches", async () => {
    const { client } = recorder([]);
    expect(await getCandidate(client, "cand_missing")).toBeUndefined();
  });

  it("lists candidates joined to their source, scoped + ordered newest-first", async () => {
    const { client, calls } = recorder([
      {
        match: "FROM candidates c JOIN inbox_sources s",
        rows: () => [
          {
            id: "cand_a",
            source_id: "src_gh",
            org_id: "org_a",
            project_id: "project_a",
            external_id: "x",
            title: "t",
            body: "",
            severity: "info",
            status: "new",
            triage: null,
            resolved_spec_id: null,
            source_name: "github",
            source_kind: "issues",
          },
        ],
      },
    ]);
    const candidates = await listCandidates(client, "org_a");
    expect(calls[0]!.sql).toContain("ORDER BY c.created_at DESC");
    expect(calls[0]!.params).toEqual(["org_a"]);
    expect(candidates[0]!.id).toBe("cand_a");
  });
});

describe("resolveCandidate — update wire shape", () => {
  it("updates status + resolved_spec_id for the candidate id and maps the joined row", async () => {
    const { client, calls } = recorder([
      {
        match: "UPDATE candidates c SET status",
        rows: (p) => [
          {
            id: p[0],
            source_id: "src_gh",
            org_id: "org_a",
            project_id: "project_a",
            external_id: "x",
            title: "t",
            body: "",
            severity: "info",
            status: p[1],
            triage: null,
            resolved_spec_id: p[2],
            source_name: "github",
            source_kind: "issues",
          },
        ],
      },
    ]);
    const candidate = await resolveCandidate(client, "cand_x", "accepted", "spec_99");
    expect(calls[0]!.params).toEqual(["cand_x", "accepted", "spec_99"]);
    expect(candidate!.status).toBe("accepted");
    expect(candidate!.resolvedSpecId).toBe("spec_99");
  });

  it("returns undefined when the update matches no row", async () => {
    const { client } = recorder([]);
    expect(await resolveCandidate(client, "cand_missing", "folded", null)).toBeUndefined();
  });
});
