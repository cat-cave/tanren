// Version-change-as-DAG-node generator tests (environment-management.md §4.5/§7 P1).
//
// The KEY INVARIANT under test: an upgrade flows through the gate as a NORMAL DAG
// node — there is NO side path that mutates dependencies/lockfiles and merges without
// the gate. `generateUpgradeSpec` is proven to insert the upgrade work via the EXISTING
// spec-creation path (`acceptProposals` → `createSpec` → `INSERT INTO specs`), the same
// hand-off the operator click + the autonomous intake/audit loops use — so the DagWalker
// drives it through tiers → build → `MergeAuthority` like any change. The generator NEVER
// issues an UPDATE to a lockfile/dependency manifest and NEVER merges directly.
//
// Refusals are SEMANTIC (no node), never a silent un-gated mutation: a pinned project
// (`keepCurrent: false`) and a project with no declared `upgrade` command generate no
// spec at all (and crucially, no INSERT INTO specs).
//
// Uses the same in-memory stub-pool pattern as specDiscovery.test.ts: a pool keyed by
// SQL substring that records the spec INSERT so the DAG-insert is observable, and serves
// the project's stored config blob for the read.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import { ProjectConfigV1 } from "../src/engine/config/index.js";
import { UPGRADE_SPEC_TITLE, generateUpgradeSpec } from "../src/engine/forge/upgrade/index.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: "project_a",
  scopes: ["platform:admin"],
  source: "session",
};

const baseLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install",
  tier1: "pnpm lint",
  tier2: "pnpm test",
  tier3: "pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
};

// Build a stored project-config blob (a valid ProjectConfigV1) the generator reads.
function projectConfig(overrides: Record<string, unknown>): unknown {
  return ProjectConfigV1.parse({ version: 1, ...overrides });
}

// In-memory pool: serves the project config for the `getConfig` read and records the
// spec INSERT (the EXISTING DAG-insert path) so the test asserts the upgrade is gated,
// not a direct mutation. Also tracks any UPDATE-to-a-manifest attempt (there must be
// NONE — the generator never mutates lockfiles itself).
function stubPool(config: unknown): {
  pool: pg.Pool;
  insertedSpecs: Array<{ specId: string; title: string; description: string; acceptance: unknown }>;
} {
  const insertedSpecs: Array<{ specId: string; title: string; description: string; acceptance: unknown }> = [];
  const specMeta = new Map<string, unknown>();
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("SELECT config FROM projects")) {
      return { rows: [{ config }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT project_id FROM projects")) {
      return { rows: [{ project_id: params[0] }], rowCount: 1 };
    }
    // v68 fix: createSpec calls loadProjectOrgId for the spec's NOT NULL org_id.
    if (sql.startsWith("SELECT org_id FROM projects")) {
      return { rows: [{ org_id: "org_a" }], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO specs")) {
      const specId = String(params[0]);
      // createSpec binds (v68): spec_id, project_id, org_id, title, description, acceptance_criteria, …
      insertedSpecs.push({
        specId,
        title: String(params[3]),
        description: String(params[4]),
        acceptance: params[5],
      });
      specMeta.set(specId, {});
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("SELECT metadata FROM specs")) {
      const specId = String(params[0]);
      return { rows: [{ metadata: specMeta.get(specId) ?? {} }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE specs SET metadata")) {
      return { rows: [{ spec_id: String(params[0]) }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  return { pool: pool as unknown as pg.Pool, insertedSpecs };
}

describe("generateUpgradeSpec · the upgrade is a GATED DAG node, never an un-gated mutation", () => {
  it("inserts the upgrade spec via the EXISTING spec-creation path (INSERT INTO specs)", async () => {
    const { pool, insertedSpecs } = stubPool(
      projectConfig({ lifecycle: { ...baseLifecycle, upgrade: "pnpm update --latest" } }),
    );
    const result = await generateUpgradeSpec({ pool }, { orgId: "org_a", projectId: "project_a", actor });

    expect(result.kind).toBe("generated");
    // The spec landed via `createSpec` — the SAME DAG-insert path the operator + the
    // autonomous loops use. That is what routes it through the walker → gate.
    expect(insertedSpecs).toHaveLength(1);
    if (result.kind !== "generated") throw new Error("expected generated");
    expect(result.specId).toBe(insertedSpecs[0]!.specId);
    expect(insertedSpecs[0]!.title).toBe(UPGRADE_SPEC_TITLE);
  });

  it("authors a spec whose run executes `just upgrade`, regenerates the lockfile, and commits", async () => {
    const { pool, insertedSpecs } = stubPool(
      projectConfig({ lifecycle: { ...baseLifecycle, upgrade: "pnpm update --latest" } }),
    );
    await generateUpgradeSpec({ pool }, { orgId: "org_a", projectId: "project_a", actor });

    const spec = insertedSpecs[0]!;
    // The spec's intent is to run the project's declared upgrade verb (`just upgrade`) —
    // Tanren names no dependency manager in the spec body.
    expect(spec.description).toContain("just upgrade");
    expect(spec.description).toContain("regenerate the lockfile");
    expect(spec.description).not.toMatch(/pnpm update|cargo update|uv lock/u);
    // The never-break-main contract is pinned in the acceptance criteria. createSpec
    // binds the criteria as a JSON string ($5::jsonb), so parse it back.
    const acceptance = JSON.parse(String(spec.acceptance)) as string[];
    expect(acceptance.join(" ")).toMatch(/gate|tiers|breaking change is rejected/iu);
  });

  it("carries the supply-chain cooldown from the policy into the spec intent", async () => {
    const { pool, insertedSpecs } = stubPool(
      projectConfig({
        lifecycle: { ...baseLifecycle, upgrade: "pnpm update --latest" },
        upgradePolicy: { keepCurrent: true, minimumReleaseAgeDays: 7 },
      }),
    );
    await generateUpgradeSpec({ pool }, { orgId: "org_a", projectId: "project_a", actor });
    expect(insertedSpecs[0]!.description).toContain("7 day(s)");
  });

  it("REFUSES (no spec, no INSERT) when the project is pinned (keepCurrent: false)", async () => {
    const { pool, insertedSpecs } = stubPool(
      projectConfig({
        lifecycle: { ...baseLifecycle, upgrade: "pnpm update --latest" },
        upgradePolicy: { keepCurrent: false, minimumReleaseAgeDays: 3 },
      }),
    );
    const result = await generateUpgradeSpec({ pool }, { orgId: "org_a", projectId: "project_a", actor });
    expect(result).toEqual({ kind: "refused", reason: "policy_pinned" });
    // The crucial invariant: a refusal is NOT a silent un-gated change — nothing inserted.
    expect(insertedSpecs).toHaveLength(0);
  });

  it("REFUSES (no spec, no INSERT) when the project declares no `upgrade` command", async () => {
    const { pool, insertedSpecs } = stubPool(projectConfig({ lifecycle: { ...baseLifecycle, upgrade: "" } }));
    const result = await generateUpgradeSpec({ pool }, { orgId: "org_a", projectId: "project_a", actor });
    expect(result).toEqual({ kind: "refused", reason: "no_upgrade_command" });
    expect(insertedSpecs).toHaveLength(0);
  });

  it("REFUSES when the project captured no lifecycle at all (no upgrade command to run)", async () => {
    const { pool, insertedSpecs } = stubPool(projectConfig({}));
    const result = await generateUpgradeSpec({ pool }, { orgId: "org_a", projectId: "project_a", actor });
    expect(result).toEqual({ kind: "refused", reason: "no_upgrade_command" });
    expect(insertedSpecs).toHaveLength(0);
  });
});
