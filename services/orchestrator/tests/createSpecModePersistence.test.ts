// Audit finding #1 (v65 ship-blocker) — round-trip proof: the `mode` field on
// CreateSpecInput is THREADED through `createSpec` into the `INSERT INTO specs`
// statement (positional parameter $9). Asserts the SQL params so a regression that
// drops the field on the way to the DB (silently coercing every spec to the
// `from_scratch` default) is caught — the v64-style class of contradictions where
// the writer's standing instructions fight the spec text.
//
// Pairs with `deriveScaffoldSpecsMode.test.ts` (the upstream defs carry the field)
// + `subtaskWriterPromptMode.test.ts` (the writer prompt branches on it) + the
// checker/auditor prompt-mode tests (the answerers branch on it too) — together
// they prove the END-TO-END plumbing the v65 fix delivered: every foundation spec
// is created with `mode='specialize_seed'` in the DB.

import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/index.js";
import { createSpec, type CreateSpecInput } from "../src/engine/workflow/projectSpec.js";
import { scaffoldSpecsFor } from "../src/engine/forge/interview/deriveScaffoldSpecs.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/types.js";
import type { SeededTemplate } from "../src/engine/templates/fragments/materialize.js";

/**
 * A tiny in-memory pool covering the `createSpec` path (mirrors the shape
 * `authProjectScoping.test.ts` uses). Records the INSERT params so the test can
 * assert the spec mode landed in position $9.
 */
class CapturingPool {
  readonly projects = new Map<string, { projectId: string; orgId: string | null }>();
  readonly memberships: Array<{ projectId: string; userId: string; role: string }> = [];
  readonly specInserts: Array<{ sql: string; params: unknown[] }> = [];

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const trimmed = sql.trim();
    if (trimmed.startsWith("SELECT project_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return {
        rows: project === undefined ? [] : [{ project_id: project.projectId }],
        rowCount: project === undefined ? 0 : 1,
      };
    }
    if (trimmed.startsWith("SELECT org_id FROM projects WHERE project_id = $1")) {
      const project = this.projects.get(String(params[0]));
      return {
        rows: project === undefined ? [] : [{ org_id: project.orgId }],
        rowCount: project === undefined ? 0 : 1,
      };
    }
    if (trimmed.startsWith("SELECT role FROM project_members")) {
      const projectId = String(params[0]);
      const userId = String(params[1]);
      const row = this.memberships.find((m) => m.projectId === projectId && m.userId === userId);
      return {
        rows: row === undefined ? [] : [{ role: row.role }],
        rowCount: row === undefined ? 0 : 1,
      };
    }
    if (trimmed.startsWith("SELECT spec_id FROM specs WHERE project_id = $1 AND spec_id = ANY")) {
      return { rows: [], rowCount: 0 };
    }
    if (trimmed.startsWith("INSERT INTO specs")) {
      this.specInserts.push({ sql: trimmed, params });
      return { rows: [], rowCount: 1 };
    }
    // SELECT pg_notify (notifyDagChanged) + anything else: no-op.
    return { rows: [], rowCount: 0 };
  }

  async connect() {
    return this;
  }
  release() {}
  asPgPool() {
    return this as never;
  }
}

const ACTOR: ActorContext = {
  userId: "user_a",
  orgId: "org_1",
  projectId: null,
  scopes: ["org:member", "project:member"],
  source: "session",
};

function newPool(): CapturingPool {
  const pool = new CapturingPool();
  pool.projects.set("project_v65", { projectId: "project_v65", orgId: "org_1" });
  pool.memberships.push({ projectId: "project_v65", userId: "user_a", role: "member" });
  return pool;
}

function baseInput(mode?: CreateSpecInput["mode"]): CreateSpecInput {
  return {
    projectId: "project_v65",
    title: "build",
    description: "Wire the project's build via the conventional `just build`",
    acceptanceCriteria: ["given the scaffolded repo, when `just build` runs, then it produces the artifact"],
    ...(mode !== undefined && { mode }),
  };
}

describe("createSpec — `mode` ROUND-TRIP through INSERT INTO specs (audit finding #1, v65 ship-blocker)", () => {
  // `mode='specialize_seed'` lands in the INSERT's positional $9 — the column the
  // SpecMode CHECK constraint is over. Without this, derive's `scaffold`/`build`/
  // `deploy` defs carrying `mode: "specialize_seed"` would still arrive at the DB
  // as `from_scratch` (the default), reproducing v64's writer-prompt contradiction
  // for build/deploy one rung downstream from scaffold.
  it("a CreateSpecInput with mode='specialize_seed' INSERTs `specialize_seed` as param $9", async () => {
    const pool = newPool();
    await createSpec(pool.asPgPool(), baseInput("specialize_seed"), ACTOR);
    expect(pool.specInserts).toHaveLength(1);
    const insert = pool.specInserts[0]!;
    // The INSERT names `mode` as the last column — positional $9 (after spec_id,
    // project_id, title, description, acceptance_criteria, depends_on, status, priority).
    expect(insert.sql).toContain("mode");
    expect(insert.params[8]).toBe("specialize_seed");
  });

  // Omitting the field defaults to `from_scratch` — the brownfield/legacy backward-
  // compat the SpecMode default exists for. A regression that flipped the default
  // would silently move every existing brownfield spec into seeded mode.
  it("a CreateSpecInput with no mode defaults to 'from_scratch' (the brownfield/legacy default)", async () => {
    const pool = newPool();
    await createSpec(pool.asPgPool(), baseInput(), ACTOR);
    expect(pool.specInserts).toHaveLength(1);
    expect(pool.specInserts[0]!.params[8]).toBe("from_scratch");
  });

  // The end-to-end proof: drive `scaffoldSpecsFor()`'s real output through `createSpec`,
  // assert all THREE foundation specs (`scaffold`, `build`, `deploy`) land in the DB
  // with `mode='specialize_seed'`. This is the audit finding's actual surface — v65
  // would have cleared `scaffold` and ground on `build`/`deploy` without this fix.
  it("every foundation spec (scaffold + build + deploy) lands in the DB with mode='specialize_seed'", async () => {
    const pool = newPool();
    const lifecycle: CaptureLifecycle = {
      stack: "node-typescript",
      bootstrap: "pnpm install --frozen-lockfile",
      tier1: "pnpm lint && pnpm typecheck",
      tier2: "pnpm test",
      tier3: "pnpm test:e2e",
      build: "pnpm build",
      deploy: "vercel deploy --prod",
      upgrade: "pnpm update --latest",
      toolchain: [],
    };
    const seed: SeededTemplate = {
      templateRef: "tanren://composed/seed@abc12345",
      validatedAt: "2026-06-26T00:00:00.000Z",
    };
    const defs = scaffoldSpecsFor(lifecycle, seed);
    for (const def of defs) {
      await createSpec(
        pool.asPgPool(),
        {
          projectId: "project_v65",
          title: def.title,
          description: def.description,
          acceptanceCriteria: def.acceptanceCriteria ?? [],
          ...(def.mode !== undefined && { mode: def.mode }),
        },
        ACTOR,
      );
    }
    // All three foundation specs ride `specialize_seed`. The titles + $9 modes:
    const rows = pool.specInserts.map((i) => ({ title: i.params[2], mode: i.params[8] }));
    expect(rows).toEqual([
      { title: "scaffold", mode: "specialize_seed" },
      { title: "build", mode: "specialize_seed" },
      { title: "deploy", mode: "specialize_seed" },
    ]);
  });
});
