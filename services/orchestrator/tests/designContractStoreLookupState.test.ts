// Codex critic #7 — the design-contract store's TYPED-STATE lookup helper
// (`DesignContractStore.getLatestState`). Under the prior silent-fallback shape,
// `getLatest === undefined` collapsed THREE distinguishable outcomes (a legit
// no-contract project, an off-scope RLS block, and a corrupt persisted row) into
// one `undefined` return, so the design ring skipped cleanly in every case. The
// typed lookup makes each outcome explicit:
//
//   - `found`   — the HEAD row parsed cleanly.
//   - `absent`  — zero rows (a real empty state OR an RLS block — the caller's
//     upstream `actor.orgId === null` pre-check catches the primary detectable
//     off-scope shape; unresolvable ambiguities beyond that are legit skips).
//   - `corrupt` — the row was present but `parseDesignContract` failed; the
//     caller MUST throw / emit a blocking finding, never silently skip.
//
// Fake QueryClient — no DB needed. Complements the DB-gated
// `designContractRegistry.integration.test.ts` which round-trips the store DAL.

import { describe, expect, it } from "vitest";
import type pg from "pg";
import { DesignContractCorruptError, DesignContractStore } from "../src/engine/repositories/designContracts.js";
import { parseDesignContract, type DesignContractV1 } from "../src/engine/design/designContract.js";

const ORG = "org_lookup";
const PROJECT = "project_lookup";
const ACTOR = { kind: "operator" as const };

function contractFixture(): DesignContractV1 {
  return parseDesignContract({
    version: 1,
    domain: "saas-web",
    identity: "calm ops console",
    intent: "effortless under load",
    principles: ["no AI-slop"],
    constraints: [],
    personaRefs: ["persona_admin"],
    behaviorRefs: ["behavior_invite"],
    dimensions: [{ key: "tokens", label: "Tokens", intent: "restrained", guidance: "", personaRefs: [] }],
  });
}

// A minimal query client the store reads against. The store's SELECT text
// includes "FROM design_contracts", so we route on that fragment. Pass `null`
// to model the zero-rows case; a non-null row round-trips through the store.
function fakeClient(row: Record<string, unknown> | null): Pick<pg.Pool, "query"> {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(sql: unknown): Promise<any> {
      if (String(sql).includes("FROM design_contracts")) {
        return { rows: row === null ? [] : [row], rowCount: row === null ? 0 : 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

describe("DesignContractStore.getLatestState — typed lookup (Codex critic #7)", () => {
  it("returns { kind: 'found', record } when the HEAD row parses cleanly", async () => {
    const contract = contractFixture();
    const client = fakeClient({
      id: "design_1",
      org_id: ORG,
      project_id: PROJECT,
      version: 3,
      mode: "from_scratch",
      domain: contract.domain,
      contract,
    });
    const state = await DesignContractStore.getLatestState(client, PROJECT, "from_scratch", ACTOR);
    expect(state.kind).toBe("found");
    if (state.kind !== "found") throw new Error("unreachable");
    expect(state.record.version).toBe(3);
    expect(state.record.projectId).toBe(PROJECT);
    expect(state.record.mode).toBe("from_scratch");
    expect(state.record.contract.identity).toBe("calm ops console");
  });

  it("returns { kind: 'absent' } when the SELECT returns zero rows (the legit empty state)", async () => {
    const client = fakeClient(null);
    const state = await DesignContractStore.getLatestState(client, PROJECT, "from_scratch", ACTOR);
    expect(state.kind).toBe("absent");
  });

  it("returns { kind: 'corrupt', error } when the persisted contract fails schema parse (never a silent skip)", async () => {
    // A row whose `contract` jsonb is NOT a valid `DesignContractV1` (missing all
    // required fields). Under the prior shape this threw a raw Error inside
    // `mapRow` from an unrelated call site (`getLatest`); the typed-state helper
    // now surfaces it as an explicit `corrupt` variant the caller MUST branch on.
    const client = fakeClient({
      id: "design_corrupt",
      org_id: ORG,
      project_id: PROJECT,
      version: 1,
      mode: "from_scratch",
      domain: "saas-web",
      contract: { totally: "wrong", shape: 42 },
    });
    const state = await DesignContractStore.getLatestState(client, PROJECT, "from_scratch", ACTOR);
    expect(state.kind).toBe("corrupt");
    if (state.kind !== "corrupt") throw new Error("unreachable");
    expect(state.error).toBeInstanceOf(DesignContractCorruptError);
    expect(state.error.projectId).toBe(PROJECT);
    // The rejected raw payload is preserved for triage.
    expect(state.error.rawValue).toEqual({ totally: "wrong", shape: 42 });
    // The typed error's detail carries the parse failure text — searchable on the timeline.
    expect(state.error.detail).toMatch(/.+/u);
  });

  it("a `corrupt` variant carries a DesignContractCorruptError whose message names the project", async () => {
    const client = fakeClient({
      id: "design_corrupt_named",
      org_id: ORG,
      project_id: PROJECT,
      version: 7,
      mode: "from_scratch",
      domain: "novel",
      contract: null,
    });
    const state = await DesignContractStore.getLatestState(client, PROJECT, "from_scratch", ACTOR);
    expect(state.kind).toBe("corrupt");
    if (state.kind !== "corrupt") throw new Error("unreachable");
    expect(state.error.message).toContain(PROJECT);
    expect(state.error.name).toBe("DesignContractCorruptError");
  });

  // Codex RA1 — the mode dimension is a SQL filter, not just a returned column.
  // Prove the read filters by mode: a fake client that echoes the requested
  // mode param demonstrates the store threads it into the WHERE clause and
  // the returned record carries the mode.
  it("Codex RA1: getLatestState filters by mode — the requested mode is echoed on the record", async () => {
    const contract = contractFixture();
    // A mode-aware fake: returns a row shaped with whatever mode was requested,
    // so a caller asking for `specialize_seed` never sees a `from_scratch` row
    // (mirroring the real store's `WHERE project_id = $1 AND mode = $2` filter).
    const modeAwareClient = {
      async query(sql: unknown, params: readonly unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
        if (String(sql).includes("FROM design_contracts") && String(sql).includes("mode = $2")) {
          const requestedMode = String(params[1]);
          return {
            rows: [
              {
                id: `design_${requestedMode}`,
                org_id: ORG,
                project_id: PROJECT,
                version: 1,
                mode: requestedMode,
                domain: contract.domain,
                contract,
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
      },
    };
    const fs = await DesignContractStore.getLatestState(modeAwareClient, PROJECT, "from_scratch", ACTOR);
    const ss = await DesignContractStore.getLatestState(modeAwareClient, PROJECT, "specialize_seed", ACTOR);
    if (fs.kind !== "found" || ss.kind !== "found") throw new Error("unreachable: expected both found");
    expect(fs.record.mode).toBe("from_scratch");
    expect(ss.record.mode).toBe("specialize_seed");
    // Ids differ ⇒ they are distinct rows the store fetched under distinct mode filters.
    expect(fs.record.id).not.toBe(ss.record.id);
  });

  it("Codex RA1: a persisted mode that falls outside the SpecMode enum is malformed and throws loud", async () => {
    const contract = contractFixture();
    // The DB CHECK rejects an out-of-enum mode on write, so this shape is
    // defense-in-depth: `mapRow` re-parses via the Zod enum and throws loud
    // rather than a silent `as SpecMode` cast that would leak an invalid
    // literal into downstream lookups.
    const client = fakeClient({
      id: "design_bad_mode",
      org_id: ORG,
      project_id: PROJECT,
      version: 1,
      mode: "not-a-real-mode",
      domain: contract.domain,
      contract,
    });
    // getLatestState routes malformed rows through the corrupt classifier — a
    // caller distinguishes "malformed row" from "absent" the same way it
    // handles a broken contract jsonb.
    const state = await DesignContractStore.getLatestState(client, PROJECT, "from_scratch", ACTOR);
    expect(state.kind).toBe("corrupt");
  });
});
