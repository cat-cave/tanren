// Unit tests for the deterministic ENTITY-MERGE FIRST-PASS pure decision
// (engine/workflow/reviewMerge/conflictResolver/entityMergeFirstPass.ts) and its
// integration into the intent-preserving resolver (§3.2). Every seam is a fake — NO real
// sem / jj / runner. They prove:
//
//   - different-entity-same-file → DETERMINISTICALLY auto-resolved (both edits land, the
//     agent Answerer is NEVER invoked) + the `merge.conflict.entity_merged` event fires;
//   - same-entity conflict → DEFER (the agent resolver runs exactly as today);
//   - entity-analysis UNAVAILABLE (sem absent / errored) → DEFER (graceful, never bricks);
//   - a non-modified entity change / overlapping spans / a missing side → DEFER;
//   - a deterministic splice whose RE-GATE fails → DEFER to the agent (never merges a wrong
//     splice).

import { describe, expect, it } from "vitest";
import { FakeEventStore } from "./helpers/fakeEventStore.js";
import { buildIntentPreservingConflictResolver } from "../src/engine/workflow/reviewMerge/conflictResolver/resolver.js";
import { entityMergeFirstPass } from "../src/engine/workflow/reviewMerge/conflictResolver/entityMergeFirstPass.js";
import type {
  ConflictSides,
  EntityDiffResult,
  EntityDiffer,
} from "../src/engine/workflow/reviewMerge/conflictResolver/entityMergeFirstPass.js";
import type { EntityMergeFirstPassHook } from "../src/engine/workflow/reviewMerge/conflictResolver/resolver.js";
import type {
  ConflictAnswererInvoker,
  ConflictProvenanceReader,
  ReGateVerdict,
  ReplanRouter,
  ResolvedTreeReGate,
  SpecIntent,
  WorkspaceConflictApplier,
} from "../src/engine/contracts/conflictResolution.js";
import type { ConflictAnswer } from "../src/engine/answerers/schemas/index.js";
import type { ConflictContext } from "../src/engine/workflow/reviewMerge/index.js";

// ── shared fixtures ──────────────────────────────────────────────────────────

const BASE_FILE = "function alpha() {\n  return 1;\n}\nfunction beta() {\n  return 2;\n}\n";
// ours edits alpha; theirs edits beta — DIFFERENT entities (the deterministic case).
const OURS_FILE = "function alpha() {\n  return 111;\n}\nfunction beta() {\n  return 2;\n}\n";
const THEIRS_FILE = "function alpha() {\n  return 1;\n}\nfunction beta() {\n  return 222;\n}\n";

function fakeSides(map: Record<string, { base: string; ours: string; theirs: string }>): ConflictSides {
  return {
    read: async (paths) =>
      paths
        .filter((p) => map[p] !== undefined)
        .map((p) => ({ path: p, base: map[p].base, ours: map[p].ours, theirs: map[p].theirs })),
  };
}

// Extract the function blocks of a file (name + 1-indexed inclusive span + body) — the
// shape `sem diff --json` keys on. Module-scoped (captures nothing) so it is hoisted once.
function entitiesOf(content: string): Array<{ name: string; start: number; end: number; body: string }> {
  const lines = content.split("\n");
  const out: Array<{ name: string; start: number; end: number; body: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^function (\w+)\(\)/u.exec(lines[i] ?? "");
    if (m === null) {
      i += 1;
      continue;
    }
    const start = i;
    let j = i;
    while (j < lines.length && !(lines[j] ?? "").startsWith("}")) j += 1;
    out.push({ name: m[1] ?? "", start: start + 1, end: j + 1, body: lines.slice(start, j + 1).join("\n") });
    i = j + 1;
  }
  return out;
}

// A differ that entity-diffs by a simple line-block model: it reports an entity per changed
// function block keyed on the function name — exactly the shape `sem diff --json` produces.
function namedEntityDiffer(): EntityDiffer {
  return {
    diff: async ({ path, before, after }): Promise<EntityDiffResult> => {
      const b = entitiesOf(before);
      const a = entitiesOf(after);
      const changes = a
        .filter((af) => {
          const bf = b.find((x) => x.name === af.name);
          return bf !== undefined && bf.body !== af.body;
        })
        .map((af) => {
          const bf = b.find((x) => x.name === af.name);
          return {
            entityId: `${path}::function::${af.name}`,
            changeType: "modified" as const,
            oldStartLine: bf?.start ?? af.start,
            oldEndLine: bf?.end ?? af.end,
            afterContent: af.body,
          };
        });
      return { ok: true, diff: { changes } };
    },
  };
}

const MERGING: SpecIntent = {
  specId: "spec_dep",
  title: "Dependent work",
  description: "edits alpha",
  acceptanceCriteria: ["alpha returns 111"],
};

const CONTEXT: ConflictContext = {
  runId: "run_1",
  prUrl: "https://github.com/o/r/pull/9",
  prNumber: 9,
  baseBranch: "main",
  message: "base-shift rebase conflict",
};

function fakeProvenance(): ConflictProvenanceReader {
  return { read: async () => ({ conflictingSpecId: "spec_base", dagEdge: true }) };
}

function recordingApplier(log: string[]): WorkspaceConflictApplier & {
  applied: Array<{ path: string; content: string }>;
} {
  const applied: Array<{ path: string; content: string }> = [];
  return {
    applied,
    gather: async () => {
      log.push("gather");
      return { files: [{ path: "f.js", conflictedContent: "<<<<<<< ours\n=======\n>>>>>>> theirs\n" }] };
    },
    applyResolution: async (resolved) => {
      log.push("apply");
      applied.push(...resolved.map((f) => ({ path: f.path, content: f.content })));
    },
    publishResolved: async () => {
      log.push("publish");
    },
    abort: async () => {
      log.push("abort");
    },
  };
}

function throwingAnswerer(): ConflictAnswererInvoker {
  return {
    resolve: async () => {
      throw new Error("the agent Answerer must NOT be invoked on a deterministic entity-merge");
    },
  };
}

function recordingAnswerer(answer: ConflictAnswer, log: string[]): ConflictAnswererInvoker {
  return {
    resolve: async () => {
      log.push("answerer");
      return answer;
    },
  };
}

function fakeReGate(verdict: ReGateVerdict): ResolvedTreeReGate {
  return { reGate: async () => verdict };
}

function noopReplan(): ReplanRouter {
  return {
    routeBackToPlanner: async (input) => ({
      kind: "owned",
      receipt: { kind: "planner_replan", specId: input.specId, run: { kind: "already_running", runId: "run_live" } },
    }),
  };
}

function firstPassHook(differ: EntityDiffer, sides: ConflictSides): EntityMergeFirstPassHook {
  return { attempt: ({ conflictedPaths }) => entityMergeFirstPass({ conflictedPaths, sides, differ }) };
}

// ── the pure decision ─────────────────────────────────────────────────────────

describe("entityMergeFirstPass (pure decision)", () => {
  it("splices BOTH edits when the two sides touch DIFFERENT entities", async () => {
    const out = await entityMergeFirstPass({
      conflictedPaths: ["f.js"],
      sides: fakeSides({ "f.js": { base: BASE_FILE, ours: OURS_FILE, theirs: THEIRS_FILE } }),
      differ: namedEntityDiffer(),
    });
    expect(out.resolved).toBe(true);
    if (!out.resolved) return;
    // Both edits land: alpha=111 (ours) AND beta=222 (theirs), no markers.
    expect(out.files[0].content).toContain("return 111;");
    expect(out.files[0].content).toContain("return 222;");
    expect(out.files[0].content).not.toContain("<<<<<<<");
    expect(out.entityIds).toEqual(expect.arrayContaining(["f.js::function::alpha", "f.js::function::beta"]));
  });

  it("DEFERS when both sides edit the SAME entity", async () => {
    const oursAlpha = "function alpha() {\n  return 111;\n}\nfunction beta() {\n  return 2;\n}\n";
    const theirsAlpha = "function alpha() {\n  return 999;\n}\nfunction beta() {\n  return 2;\n}\n";
    const out = await entityMergeFirstPass({
      conflictedPaths: ["f.js"],
      sides: fakeSides({ "f.js": { base: BASE_FILE, ours: oursAlpha, theirs: theirsAlpha } }),
      differ: namedEntityDiffer(),
    });
    expect(out.resolved).toBe(false);
    if (out.resolved) return;
    expect(out.reason).toContain("same entity");
  });

  it("DEFERS gracefully when the entity differ is UNAVAILABLE (sem absent/errored)", async () => {
    const unavailable: EntityDiffer = { diff: async () => ({ ok: false, reason: "producer-unsupported" }) };
    const out = await entityMergeFirstPass({
      conflictedPaths: ["f.js"],
      sides: fakeSides({ "f.js": { base: BASE_FILE, ours: OURS_FILE, theirs: THEIRS_FILE } }),
      differ: unavailable,
    });
    expect(out.resolved).toBe(false);
    if (out.resolved) return;
    expect(out.reason).toContain("producer-unsupported");
  });

  it("DEFERS when a side has a non-modified entity change (add/delete/rename)", async () => {
    const differ: EntityDiffer = {
      diff: async ({ path, after }) =>
        after === OURS_FILE
          ? {
              ok: true,
              diff: {
                changes: [
                  {
                    entityId: `${path}::function::gamma`,
                    changeType: "added",
                    oldStartLine: 1,
                    oldEndLine: 1,
                    afterContent: "x",
                  },
                ],
              },
            }
          : {
              ok: true,
              diff: {
                changes: [
                  {
                    entityId: `${path}::function::beta`,
                    changeType: "modified",
                    oldStartLine: 4,
                    oldEndLine: 6,
                    afterContent: "y",
                  },
                ],
              },
            },
    };
    const out = await entityMergeFirstPass({
      conflictedPaths: ["f.js"],
      sides: fakeSides({ "f.js": { base: BASE_FILE, ours: OURS_FILE, theirs: THEIRS_FILE } }),
      differ,
    });
    expect(out.resolved).toBe(false);
    if (out.resolved) return;
    expect(out.reason).toContain("non-modified");
  });

  it("DEFERS when a conflicted file's sides cannot be read (never a partial merge)", async () => {
    const out = await entityMergeFirstPass({
      conflictedPaths: ["f.js", "g.js"],
      sides: fakeSides({ "f.js": { base: BASE_FILE, ours: OURS_FILE, theirs: THEIRS_FILE } }),
      differ: namedEntityDiffer(),
    });
    expect(out.resolved).toBe(false);
    if (out.resolved) return;
    expect(out.reason).toContain("unreadable");
  });
});

// ── resolver integration ───────────────────────────────────────────────────────

describe("resolver — entity-merge first-pass integration (§3.2)", () => {
  it("a different-entity conflict resolves DETERMINISTICALLY: no agent, entity_merged event", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = recordingApplier(log);
    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance(),
      applier,
      entityFirstPass: firstPassHook(
        namedEntityDiffer(),
        fakeSides({ "f.js": { base: BASE_FILE, ours: OURS_FILE, theirs: THEIRS_FILE } }),
      ),
      answerer: throwingAnswerer(),
      reGate: fakeReGate({ passed: true, reason: "clean" }),
      replan: noopReplan(),
    });

    const result = await resolver(CONTEXT);
    expect(result.resolved).toBe(true);
    // The agent was SKIPPED; the deterministic splice was applied + published.
    expect(log).toEqual(["gather", "apply", "publish"]);
    expect(applier.applied[0].content).toContain("return 111;");
    expect(applier.applied[0].content).toContain("return 222;");
    // A DISTINCT entity-merged event fired (not the agent-resolved event).
    const names = events.events.map((e) => e.eventType);
    expect(names).toContain("merge.conflict.entity_merged");
    expect(names).not.toContain("merge.conflict.resolved");
    const merged = events.events.find((e) => e.eventType === "merge.conflict.entity_merged");
    expect(merged?.payload).toMatchObject({ reGated: true, mergingSpecId: "spec_dep" });
  });

  it("a same-entity conflict FALLS THROUGH to the agent resolver", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = recordingApplier(log);
    const sameEntitySides = fakeSides({
      "f.js": {
        base: BASE_FILE,
        ours: "function alpha() {\n  return 111;\n}\nfunction beta() {\n  return 2;\n}\n",
        theirs: "function alpha() {\n  return 999;\n}\nfunction beta() {\n  return 2;\n}\n",
      },
    });
    const agentAnswer: ConflictAnswer = {
      decision: "resolve",
      reasoning: "agent reconciled the shared entity",
      resolvedFiles: [
        { path: "f.js", content: "function alpha() {\n  return 500;\n}\nfunction beta() {\n  return 2;\n}\n" },
      ],
      replanSpec: null,
    };
    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance(),
      applier,
      entityFirstPass: firstPassHook(namedEntityDiffer(), sameEntitySides),
      answerer: recordingAnswerer(agentAnswer, log),
      reGate: fakeReGate({ passed: true, reason: "clean" }),
      replan: noopReplan(),
    });

    const result = await resolver(CONTEXT);
    expect(result.resolved).toBe(true);
    // The agent ran (the first-pass deferred); the agent-resolved event fired, NOT entity_merged.
    expect(log).toContain("answerer");
    const names = events.events.map((e) => e.eventType);
    expect(names).toContain("merge.conflict.resolved");
    expect(names).not.toContain("merge.conflict.entity_merged");
  });

  it("entity-analysis UNAVAILABLE falls through to the agent (graceful)", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = recordingApplier(log);
    const unavailable: EntityDiffer = { diff: async () => ({ ok: false, reason: "producer-errored" }) };
    const agentAnswer: ConflictAnswer = {
      decision: "resolve",
      reasoning: "agent resolved without sem",
      resolvedFiles: [{ path: "f.js", content: "ok\n" }],
      replanSpec: null,
    };
    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance(),
      applier,
      entityFirstPass: firstPassHook(
        unavailable,
        fakeSides({ "f.js": { base: BASE_FILE, ours: OURS_FILE, theirs: THEIRS_FILE } }),
      ),
      answerer: recordingAnswerer(agentAnswer, log),
      reGate: fakeReGate({ passed: true, reason: "clean" }),
      replan: noopReplan(),
    });

    const result = await resolver(CONTEXT);
    expect(result.resolved).toBe(true);
    expect(log).toContain("answerer");
    expect(events.events.map((e) => e.eventType)).not.toContain("merge.conflict.entity_merged");
  });

  it("a deterministic splice whose RE-GATE FAILS defers to the agent (never merges a wrong splice)", async () => {
    const events = new FakeEventStore();
    const log: string[] = [];
    const applier = recordingApplier(log);
    let reGateCalls = 0;
    const reGate: ResolvedTreeReGate = {
      reGate: async () => {
        reGateCalls += 1;
        // First call = the splice's re-gate (FAIL); second call = the agent's re-gate (pass).
        return reGateCalls === 1
          ? { passed: false, failedStage: "checker", reason: "splice broke a test" }
          : { passed: true, reason: "clean" };
      },
    };
    const agentAnswer: ConflictAnswer = {
      decision: "resolve",
      reasoning: "agent reconciled",
      resolvedFiles: [{ path: "f.js", content: "agent\n" }],
      replanSpec: null,
    };
    const resolver = buildIntentPreservingConflictResolver({
      projectId: "proj_1",
      mergingSpecIntent: MERGING,
      eventStore: events,
      provenance: fakeProvenance(),
      applier,
      entityFirstPass: firstPassHook(
        namedEntityDiffer(),
        fakeSides({ "f.js": { base: BASE_FILE, ours: OURS_FILE, theirs: THEIRS_FILE } }),
      ),
      answerer: recordingAnswerer(agentAnswer, log),
      reGate,
      replan: noopReplan(),
    });

    const result = await resolver(CONTEXT);
    expect(result.resolved).toBe(true);
    // The splice was applied + re-gated (failed) → the agent then ran. NO entity_merged event;
    // NO publish happened on the failed splice (publish only after the agent's clean re-gate).
    expect(log).toContain("answerer");
    expect(events.events.map((e) => e.eventType)).not.toContain("merge.conflict.entity_merged");
    expect(events.events.map((e) => e.eventType)).toContain("merge.conflict.resolved");
  });
});
