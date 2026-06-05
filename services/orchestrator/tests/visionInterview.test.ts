// greenfield-onboarding engine tests.
//
// Exercises the interview round loop (with a MOCKED answerer — no provider is
// contacted — and the deterministic scripted fallback), the capture merge, and
// the derivation path (project + personas + behaviors + milestones + specs all
// created through the existing entity stores). The pool is a lightweight
// in-memory stub keyed by SQL substring, mirroring the discovery engine-test
// pattern. No migration is required — every row lands in an existing table.

/* eslint-disable unicorn/no-thenable */
// `then` is BDD Given/When/Then vocabulary in the capture/behavior fixtures.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  mergeCapture,
  runRound,
  type InterviewAnswerer,
  type InterviewCapture,
} from "../src/engine/forge/interview/index.js";
import { createDeterministicInterviewAnswerer } from "./fixtures/forge/deterministicInterviewAnswerer.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

// In-memory pool tracking inserts so the derive path's create calls are
// observable. Keyed by SQL substring like the discovery test stub.
interface StubState {
  projects: Set<string>;
  specs: Map<string, { dependsOn: string[] }>;
  personas: number;
  // The metadata jsonb persisted per persona INSERT (where the derive persists
  // the persona `surface`, there being no `surface` column).
  personaMetadata: Array<Record<string, unknown>>;
  behaviors: number;
  milestones: number;
  specMilestones: number;
  specBehaviors: number;
}

function stubPool(): {
  pool: pg.Pool;
  state: StubState;
  // FINDING #1: the persisted project config blob, captured per projectId from the
  // `INSERT INTO projects` call (config is the 7th column → params[6], JSON text).
  configs: Map<string, Record<string, unknown>>;
} {
  const state: StubState = {
    projects: new Set(),
    specs: new Map(),
    personas: 0,
    personaMetadata: [],
    behaviors: 0,
    milestones: 0,
    specMilestones: 0,
    specBehaviors: 0,
  };
  const configs = new Map<string, Record<string, unknown>>();
  const personaIds = new Set<string>();
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/gu, " ").trim();
    if (sql.startsWith("INSERT INTO projects")) {
      state.projects.add(String(params[0]));
      const rawConfig = params[6];
      if (typeof rawConfig === "string") {
        configs.set(String(params[0]), JSON.parse(rawConfig) as Record<string, unknown>);
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO project_members")) return { rows: [], rowCount: 1 };
    if (sql.startsWith("SELECT project_id FROM projects")) {
      return state.projects.has(String(params[0]))
        ? { rows: [{ project_id: params[0] }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    // ensureProjectAccess membership lookup → always allow (platform admin).
    if (sql.includes("FROM project_members")) return { rows: [{ role: "admin" }], rowCount: 1 };
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) {
      // dependency existence check: params[1] is the id array.
      const ids = (params[1] as string[]) ?? [];
      const present = ids.filter((id) => state.specs.has(id)).map((id) => ({ spec_id: id }));
      return { rows: present, rowCount: present.length };
    }
    if (sql.startsWith("INSERT INTO specs")) {
      const specId = String(params[0]);
      const dependsOn = (params[5] as string[]) ?? [];
      state.specs.set(specId, { dependsOn });
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO personas")) {
      state.personas += 1;
      personaIds.add(String(params[0]));
      // The metadata jsonb is the 7th column (params[6], JSON text) — capture it so
      // a test can assert the persona `surface` is persisted there (no `surface` column).
      const rawMeta = params[6];
      const metadata = typeof rawMeta === "string" ? (JSON.parse(rawMeta) as Record<string, unknown>) : {};
      state.personaMetadata.push(metadata);
      return {
        rows: [
          {
            id: params[0],
            scope: params[1],
            org_id: params[2],
            project_id: params[3],
            name: params[4],
            description: params[5],
            metadata,
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    // PersonaStore.get (authz for behavior create) → return the persona row.
    if (sql.startsWith("SELECT id, scope, org_id, project_id, name, description")) {
      return {
        rows: [
          {
            id: params[0],
            scope: "project",
            org_id: "org_a",
            project_id: "p",
            name: "n",
            description: "d",
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("INSERT INTO behaviors")) {
      state.behaviors += 1;
      return {
        rows: [
          {
            id: params[0],
            persona_id: params[1],
            title: params[2],
            given: params[3],
            when: params[4],
            then: params[5],
            description: params[6],
            metadata: {},
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("INSERT INTO milestones")) {
      state.milestones += 1;
      return {
        rows: [
          {
            id: params[0],
            project_id: params[1],
            label: params[2],
            name: params[3],
            description: params[4],
            order_index: params[5],
            eta: params[6],
            status: params[7],
            created_at: new Date(),
            updated_at: new Date(),
          },
        ],
        rowCount: 1,
      };
    }
    if (sql.startsWith("DELETE FROM spec_milestones")) return { rows: [], rowCount: 0 };
    if (sql.startsWith("INSERT INTO spec_milestones")) {
      state.specMilestones += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO spec_behaviors")) {
      state.specBehaviors += 1;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    pool: { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
    state,
    configs,
  };
}

describe("runRound · interview round loop", () => {
  it("uses a mocked answerer and merges the returned capture delta", async () => {
    const { pool } = stubPool();
    let seenRound = 0;
    const answerer: InterviewAnswerer = {
      async ask(ctx) {
        seenRound = ctx.round;
        return {
          say: "who uses this?",
          captureDelta: {
            personas: [{ name: "ops manager", description: "runs orders", surface: "desktop" }],
          },
          suggestions: [],
          complete: false,
        };
      },
    };
    const result = await runRound(
      { pool, answerer },
      { round: 2, answer: "a supply chain tool", capture: emptyCapture() },
    );
    expect(seenRound).toBe(2);
    expect(result.say).toBe("who uses this?");
    expect(result.capture.personas).toHaveLength(1);
    expect(result.complete).toBe(false);
  });

  it("deterministic answerer accumulates the full capture across rounds and completes", async () => {
    const { pool } = stubPool();
    const answerer = createDeterministicInterviewAnswerer();
    let capture = emptyCapture();
    let complete = false;
    let round = 1;
    // Drive rounds until the script flips complete (bounded so a regression
    // cannot loop forever).
    for (; round <= 20 && !complete; round += 1) {
      const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
      capture = result.capture;
      complete = result.complete;
    }
    expect(complete).toBe(true);
    expect(capture.identity?.slug).toBe("supply-chain-os");
    expect(capture.personas.length).toBeGreaterThanOrEqual(3);
    expect(capture.behaviors.length).toBeGreaterThanOrEqual(5);
    expect(capture.interfaces.length).toBeGreaterThanOrEqual(2);
    expect(capture.rulesets.length).toBeGreaterThanOrEqual(3);
  });
});

describe("mergeCapture · monotonic union", () => {
  it("de-dupes personas/behaviors by key and last-write-wins on identity", () => {
    const base = mergeCapture(emptyCapture(), {
      identity: { slug: "a", pitch: "first", repoHint: "" },
      personas: [{ name: "ops", description: "x", surface: "" }],
    });
    const merged = mergeCapture(base, {
      identity: { slug: "a", pitch: "refined", repoHint: "" },
      personas: [
        { name: "ops", description: "y", surface: "desktop" },
        { name: "cfo", description: "z", surface: "" },
      ],
    });
    expect(merged.identity?.pitch).toBe("refined");
    expect(merged.personas).toHaveLength(2);
    expect(merged.personas.find((p) => p.name === "ops")?.surface).toBe("desktop");
  });
});

describe("deriveFromCapture · creates the product graph (no migration)", () => {
  it("derives project + personas + behaviors + milestones + specs through existing stores", async () => {
    const { pool, state } = stubPool();
    const answerer = createDeterministicInterviewAnswerer();
    let capture: InterviewCapture = emptyCapture();
    let complete = false;
    for (let round = 1; round <= 20 && !complete; round += 1) {
      const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
      capture = result.capture;
      complete = result.complete;
    }

    const derived = await deriveFromCapture({ pool }, { orgId: "org_a", capture, actor });

    expect(state.projects.size).toBe(1);
    expect(derived.projectName).toBe("supply-chain-os");
    // 3 personas, 7 behaviors, 3 scaffold + per-interface (schema + behaviors) specs.
    expect(derived.personaIds).toHaveLength(3);
    expect(derived.behaviorIds.length).toBeGreaterThanOrEqual(5);
    // M1 scaffold + one milestone per interface (>= 2 interfaces).
    expect(derived.milestoneIds.length).toBeGreaterThanOrEqual(3);
    // Every behavior spec is linked to a milestone + tied to its behavior.
    expect(state.specMilestones).toBe(derived.specIds.length);
    expect(state.specBehaviors).toBe(derived.behaviorIds.length);
    // FINDING #3: the foundation is a serialized CHAIN, not 3 parallel roots. Only
    // the first scaffold spec (monorepo) is a root with no deps; `build` depends on
    // it and `ci` depends on `build`, so 2 of the 3 scaffold specs now carry a dep.
    // Every later (interface/behavior) spec depends on the scaffold too.
    const rootlessScaffolds = 1;
    const hasDeps = [...state.specs.values()].filter((s) => s.dependsOn.length > 0).length;
    expect(hasDeps).toBe(derived.specIds.length - rootlessScaffolds);
  });

  it("FINDING #3: derives a serialized scaffold CHAIN (build→scaffold, ci→build), not 3 roots", async () => {
    const { pool, state } = stubPool();
    const answerer = createDeterministicInterviewAnswerer();
    let capture: InterviewCapture = emptyCapture();
    let complete = false;
    for (let round = 1; round <= 20 && !complete; round += 1) {
      const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
      capture = result.capture;
      complete = result.complete;
    }
    const derived = await deriveFromCapture({ pool }, { orgId: "org_a", capture, actor });

    // The scaffold specs are created first, in order: monorepo, build, ci.
    const [scaffoldId, buildId, ciId] = derived.specIds;
    const scaffold = state.specs.get(scaffoldId);
    const build = state.specs.get(buildId);
    const ci = state.specs.get(ciId);
    // monorepo scaffold is the SOLE root (no deps); build depends ONLY on scaffold;
    // ci depends ONLY on build — a chain, not 3 empty-dep roots.
    expect(scaffold?.dependsOn).toEqual([]);
    expect(build?.dependsOn).toEqual([scaffoldId]);
    expect(ci?.dependsOn).toEqual([buildId]);
    // Exactly ONE foundation spec is a root (would have been 3 before the fix).
    const scaffoldRoots = [scaffold, build, ci].filter((s) => (s?.dependsOn.length ?? 0) === 0).length;
    expect(scaffoldRoots).toBe(1);
  });

  it('FINDING #1: autonomy:"auto" creates an autonomous project config (no follow-up PATCH)', async () => {
    const { pool, configs } = stubPool();
    const answerer = createDeterministicInterviewAnswerer();
    let capture: InterviewCapture = emptyCapture();
    let complete = false;
    for (let round = 1; round <= 20 && !complete; round += 1) {
      const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
      capture = result.capture;
      complete = result.complete;
    }
    const derived = await deriveFromCapture({ pool }, { orgId: "org_a", capture, actor, autonomy: "auto" });

    const config = configs.get(derived.projectId);
    expect(config).toBeDefined();
    expect(config?.reviewPolicy).toBe("auto");
    expect(config?.mergeIntegration).toBe("native_queue");
    // The autonomous greenfield config is LENIENT (functional-but-weak apex
    // doctrine): the in-loop gate's lint/typecheck are advisory so an imperfect
    // first pass lands + improves via the issue loop instead of stalling.
    expect(config?.governancePosture).toBe("lenient");
    // The interview path always builds off an empty repo ⇒ greenfield (drives the
    // non-frozen in-loop deps-ensure).
    expect(config?.greenfield).toBe(true);
  });

  it("FINDING #1: omitting autonomy keeps the safe schema defaults (human / not_configured)", async () => {
    const { pool, configs } = stubPool();
    const answerer = createDeterministicInterviewAnswerer();
    let capture: InterviewCapture = emptyCapture();
    let complete = false;
    for (let round = 1; round <= 20 && !complete; round += 1) {
      const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
      capture = result.capture;
      complete = result.complete;
    }
    const derived = await deriveFromCapture({ pool }, { orgId: "org_a", capture, actor });

    const config = configs.get(derived.projectId);
    expect(config).toBeDefined();
    expect(config?.reviewPolicy).toBe("human");
    expect(config?.mergeIntegration).toBe("not_configured");
    // Even the human tier is greenfield (interview builds off an empty repo) — the
    // safe review/merge defaults hold, but greenfield drives the non-frozen ensure.
    expect(config?.greenfield).toBe(true);
  });

  it("persists the PRODUCT VISION (design-DNA + identity pitch on config; persona surface on metadata) — no migration", async () => {
    const { pool, configs, state } = stubPool();
    const answerer = createDeterministicInterviewAnswerer();
    let capture: InterviewCapture = emptyCapture();
    let complete = false;
    for (let round = 1; round <= 20 && !complete; round += 1) {
      const result = await runRound({ pool, answerer }, { round, answer: "ok", capture });
      capture = result.capture;
      complete = result.complete;
    }
    const derived = await deriveFromCapture({ pool }, { orgId: "org_a", capture, actor });

    // Design-DNA + identity pitch land on `projects.config.productVision` (the
    // existing jsonb blob — no new table). The interview captured both.
    const config = configs.get(derived.projectId);
    const vision = config?.productVision as { pitch?: string; designDna?: string } | undefined;
    expect(vision).toBeDefined();
    expect(vision?.designDna).toBe("industrial");
    expect(vision?.pitch).toContain("supply chain operations");
    // The persona SURFACE is persisted on the persona `metadata` jsonb (no column).
    const surfaces = state.personaMetadata.map((m) => m["surface"]).filter((s) => s !== undefined);
    expect(surfaces).toContain("desktop");
    expect(surfaces).toContain("handheld");
  });
});
