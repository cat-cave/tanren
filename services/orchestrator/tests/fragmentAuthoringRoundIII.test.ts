// Round-III coordinated F2 restructure (fix/f2-round-iii-coordinated-restructure).
//
// 8 findings addressed as ONE coordinated flow — the tests here pin each new
// invariant so a future refactor that regresses to the prior shape fails loud:
//
//   H1 — batch-compose retract DELETES the persisted row (was: emit-only).
//   H4 — batch-compose retract never emits `succeeded` for an id it then
//        marks `failed` (was: both events for the same id).
//   H7 — batch-compose retract emits with the REAL per-fragment attempts
//        count (was: hardcoded `attempts: 1`).
//   M1 — python/go/rust runtime derivation halts at validate with a clean
//        `unsupported_runtime_language` reason (was: cryptic
//        `library.require: no fragment registered for id "runtime-python-uv"`
//        thrown deep in the composer).
//   M2 — a persist throw whose fallback `events.emit` ALSO throws does not
//        propagate upward (was: Fix 4's stated "continue authoring remaining
//        specs" contract violated).
//   M3 — the writer prompt is HONEST about the persisted-contract shape
//        (option B: declare verbatim, composer persists the required value).
//   M4 — an empty apply() body is rejected with a specific reason (was:
//        silently accepted as validated).
//   M6 — the batch `skipped` arm is explicitly handled as a failure
//        (was: silent fall-through in the caller).
//
// Kept in a separate file so the existing loop-budget/full-library/attempt-
// observability suites stay narrowly scoped to their own contracts.

import { describe, expect, it } from "vitest";
import {
  buildFragmentAuthoring,
  buildFragmentAuthorerPrompt,
  drivePostAuthoringOutcome,
  type FragmentAuthoringEvents,
  type FragmentAuthorer,
  type FragmentPersistence,
  type FragmentSpec,
  loadFragmentLibrary,
  parseFragmentBody,
  validateFragmentBody,
} from "../src/engine/templates/index.js";
import type { CaptureLifecycle } from "../src/engine/forge/interview/index.js";
import { buildFakeFragmentAuthorer } from "./fixtures/fragmentAuthoring.js";

function lifecycle(): CaptureLifecycle {
  return {
    stack: "ts/pnpm",
    bootstrap: "pnpm install",
    tier1: "pnpm test",
    tier2: "pnpm test",
    tier3: "pnpm test",
    build: "pnpm build",
    deploy: "fly deploy",
    upgrade: "",
    toolchain: [],
  };
}

function spec(kind: FragmentSpec["kind"], label: string): FragmentSpec {
  return { kind, label, id: `${kind}-${label}`, requiredContract: {} };
}

function recordingEvents(): { events: FragmentAuthoringEvents; calls: unknown[] } {
  const calls: unknown[] = [];
  const events: FragmentAuthoringEvents = {
    async emit(event) {
      calls.push(event);
    },
  };
  return { events, calls };
}

function inMemoryPersistence(): {
  persistence: FragmentPersistence;
  created: unknown[];
  deleted: string[];
} {
  const created: unknown[] = [];
  const deleted: string[] = [];
  const persistence: FragmentPersistence = {
    async createValidated(input) {
      created.push(input);
      return { fragmentId: `${input.orgId}:${input.spec.id}:1.0.0` };
    },
    async deleteById(fragmentId) {
      deleted.push(fragmentId);
    },
  };
  return { persistence, created, deleted };
}

const testActor = {
  userId: "u",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"] as const,
  source: "session" as const,
};

// A node-only-addon authorer: writes a docs marker + declares a lodash dep.
// The implicit dependsOn derives `runtime-node-pnpm`; against a python
// lifecycle the batch compose rejects. Hoisted to module scope so oxlint's
// consistent-function-scoping rule stays happy across every H1/H4/H7 test.
const nodeOnlyAddonAuthorer: FragmentAuthorer = async (input) => {
  const s = input.spec;
  const body = [
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    `export const fragment: Fragment = {`,
    `  id: "${s.id}",`,
    `  version: "1.0.0",`,
    `  kind: "${s.kind}",`,
    `  contract: ${JSON.stringify(s.requiredContract)},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    `    vfs.write("docs/${s.id}.md", "hi");`,
    `    vfs.addPackageJsonDep("lodash", "^4.17.0");`,
    `  },`,
    `};`,
    `export default fragment;`,
  ].join("\n");
  return { bodyTs: body };
};

// An empty-body authorer — `apply()` contains no ops. M4 rejects at validate.
const emptyBodyAuthorer: FragmentAuthorer = async (input) => {
  const s = input.spec;
  const body = [
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    `export const fragment: Fragment = {`,
    `  id: "${s.id}",`,
    `  version: "1.0.0",`,
    `  kind: "${s.kind}",`,
    `  contract: ${JSON.stringify(s.requiredContract)},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    `  },`,
    `};`,
    `export default fragment;`,
  ].join("\n");
  return { bodyTs: body };
};

/** Narrowing helper: assert failure + return the reason as a plain string so
 * tests read as unconditional expects (oxlint's vitest/no-conditional-expect). */
function failureReason(result: { kind: "ok" } | { kind: "failed"; reason: string }): string {
  expect(result.kind).toBe("failed");
  return result.kind === "failed" ? result.reason : "";
}

// ── H1 — batch-compose retract DELETES the persisted rows ─────────────────────

describe("Round-III H1 — batch retract deletes every persisted row", () => {
  it("deletes ALL freshly-authored fragmentIds when the batch compose fails", async () => {
    // Two node-only addons pass their per-fragment smokes but the CAPTURED
    // runtime is python — the batch compose rejects because the augmented
    // library has no runtime-python. Both rows must be deleted from
    // persistence so the org's fragments table stays free of the batch-
    // rejected content (prior bug: the emit fired but the rows survived,
    // contaminating the next authoring run for the same org).
    const { events } = recordingEvents();
    const { persistence, created, deleted } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: nodeOnlyAddonAuthorer, persistence, events });
    const pythonLifecycle: CaptureLifecycle = {
      ...lifecycle(),
      stack: "python + fly",
      deploy: "fly deploy",
    };
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "first"), spec("addon", "second")],
      lifecycle: pythonLifecycle,
    });
    // Both were persisted, both were retracted — set-equal check because the
    // outcome handler emits per authored item in the sequential order.
    expect(created).toHaveLength(2);
    expect(new Set(deleted)).toEqual(new Set(["org_a:addon-first:1.0.0", "org_a:addon-second:1.0.0"]));
    // Both surface as failed with the batch reason.
    expect(new Set(result.failedIds)).toEqual(new Set(["addon-first", "addon-second"]));
  });
});

// ── H4 — no succeeded-then-failed for the same id ─────────────────────────────

describe("Round-III H4 — the batch retract path emits `failed` but never `succeeded`", () => {
  it("emits failed exactly once per authored id + never emits succeeded for a retracted id", async () => {
    const { events, calls } = recordingEvents();
    const { persistence } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: nodeOnlyAddonAuthorer, persistence, events });
    const pythonLifecycle: CaptureLifecycle = {
      ...lifecycle(),
      stack: "python + fly",
      deploy: "fly deploy",
    };
    await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "one")],
      lifecycle: pythonLifecycle,
    });
    const succeeded = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.succeeded");
    const failed = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as {
      fragmentId: string;
    }[];
    // Prior bug: both succeeded + failed for `addon-one`. Now: failed only.
    expect(succeeded).toHaveLength(0);
    expect(failed.map((f) => f.fragmentId)).toEqual(["addon-one"]);
  });
});

// ── H7 — retract emits the REAL per-fragment attempts count ───────────────────

describe("Round-III H7 — the retract-failed event carries the real per-fragment attempts count", () => {
  it("emits the observed attempts count (not the prior hardcoded `attempts: 1`)", async () => {
    // The authorer converges on attempt 3 — two body rejections, then a
    // conforming body. The per-fragment smokes pass; the batch compose
    // fails (python runtime, node-only body). The `failed` event's
    // `attempts` field must be 3, not 1.
    let call = 0;
    const flakyThenGood: FragmentAuthorer = async (input) => {
      call += 1;
      const s = input.spec;
      if (call < 3) return { bodyTs: `not a valid fragment module — iter ${call}` };
      const body = [
        `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
        `export const fragment: Fragment = {`,
        `  id: "${s.id}",`,
        `  version: "1.0.0",`,
        `  kind: "${s.kind}",`,
        `  contract: ${JSON.stringify(s.requiredContract)},`,
        `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
        `    vfs.write("docs/${s.id}.md", "hi");`,
        `    vfs.addPackageJsonDep("lodash", "^4.17.0");`,
        `  },`,
        `};`,
        `export default fragment;`,
      ].join("\n");
      return { bodyTs: body };
    };
    const { events, calls } = recordingEvents();
    const { persistence } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: flakyThenGood, persistence, events });
    const pythonLifecycle: CaptureLifecycle = {
      ...lifecycle(),
      stack: "python + fly",
      deploy: "fly deploy",
    };
    await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "flaky-then-good")],
      lifecycle: pythonLifecycle,
    });
    const failed = calls.find((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as
      | { attempts: number; reason: string }
      | undefined;
    expect(failed).toBeDefined();
    // The REAL attempts count — 3 (two flaky + one converging).
    expect(failed?.attempts).toBe(3);
    expect(failed?.reason).toContain("batch_compose_failed:");
  });
});

// ── M1 — python/go/rust runtime derivation halts with a clean reason ─────────

describe("Round-III M1 — validate rejects an unshipped derived runtime BEFORE the smoke composes", () => {
  it("rejects a non-runtime fragment that writes pyproject.toml with unsupported_runtime_language", async () => {
    // A pathological addon that writes a pyproject.toml — the implicit
    // dependsOn derives `runtime-python-uv`, which the bundled library
    // does not ship. The prior smoke deferred the failure to a cryptic
    // `library.require` throw inside the composer. Now we halt at validate.
    const body = [
      `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
      `export const fragment: Fragment = {`,
      `  id: "addon-python-tool",`,
      `  version: "1.0.0",`,
      `  kind: "addon",`,
      `  contract: {},`,
      `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
      `    vfs.write("pyproject.toml", "[project]\\nname = \\"x\\"\\nversion = \\"0.0.0\\"\\n");`,
      `  },`,
      `};`,
      `export default fragment;`,
    ].join("\n");
    const reason = failureReason(
      await validateFragmentBody({
        spec: spec("addon", "python-tool"),
        bodyTs: body,
      }),
    );
    expect(reason).toContain("unsupported_runtime_language");
    expect(reason).toContain("runtime-python-uv");
    // The reason enumerates the shipped runtimes.
    expect(reason).toContain("runtime-node-pnpm");
  });
});

// ── M2 — DB-down persist throw + event emit throw does not propagate ──────────

describe("Round-III M2 — a throwing events.emit does not propagate through the run", () => {
  it("continues authoring remaining specs even when both persist AND emit throw", async () => {
    // Simulate a DB outage: the persist throws (unique-index / connection
    // reset) AND the fallback `events.emit` ALSO throws (same DB pool).
    // The outer loop must swallow the emit throw (Round-III M2 fix) and
    // continue to the next spec — Fix 4's contract ("do not throw upward")
    // now holds even in the DB-down case.
    const throwingPersistence: FragmentPersistence = {
      async createValidated() {
        throw new Error("DB is DOWN — createValidated");
      },
      async deleteById() {
        /* not reached in this test */
      },
    };
    const throwingEvents: FragmentAuthoringEvents = {
      async emit() {
        throw new Error("DB is DOWN — event emit");
      },
    };
    const runner = buildFragmentAuthoring({
      authorer: buildFakeFragmentAuthorer(),
      persistence: throwingPersistence,
      events: throwingEvents,
    });
    // Prior behavior (Fix 4 alone): the first spec's persist throw would
    // emit `failed`, but the emit ALSO threw, so the throw propagated
    // upward — the run terminated before the second spec was tried.
    // Now: the emit-throw is swallowed, the second spec still runs.
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "first"), spec("addon", "second")],
      lifecycle: lifecycle(),
    });
    // Both specs surfaced as failed (both hit the persist throw) — the run
    // did NOT throw upward on the first emit failure.
    expect(new Set(result.failedIds)).toEqual(new Set(["addon-first", "addon-second"]));
    expect(result.failureReasons["addon-first"]).toContain("persistence_failed:");
    expect(result.failureReasons["addon-second"]).toContain("persistence_failed:");
  });
});

// ── M3 — the writer prompt is honest about the persisted-contract shape ──────

describe("Round-III M3 — the writer prompt tells the writer to declare the contract VERBATIM", () => {
  it("names 'VERBATIM' and warns the composer persists the required contract", () => {
    const prompt = buildFragmentAuthorerPrompt({
      spec: {
        kind: "runtime",
        label: "node-pnpm",
        id: "runtime-node-pnpm",
        requiredContract: { testRunner: "vitest", reportPath: "reports/junit.xml" },
      },
      lifecycle: lifecycle(),
    });
    // The prompt embeds the required-contract JSON verbatim so the writer's
    // body can paste it in unchanged.
    expect(prompt).toContain(`"testRunner":"vitest"`);
    // The prompt is EXPLICIT about the contract being fixed at persistence
    // time — the honest declaration Option B chose over silent override.
    expect(prompt).toMatch(/VERBATIM/u);
    expect(prompt).toMatch(/composer|persist/iu);
  });
});

// ── M4 — an empty apply() body is rejected with a specific reason ────────────

describe("Round-III M4 — empty apply() body is a hard reject", () => {
  it("parseFragmentBody returns [] on an empty apply block, and validate halts", async () => {
    const emptyBody = [
      `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
      `export const fragment: Fragment = {`,
      `  id: "addon-empty",`,
      `  version: "1.0.0",`,
      `  kind: "addon",`,
      `  contract: {},`,
      `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
      `    // no ops`,
      `  },`,
      `};`,
      `export default fragment;`,
    ].join("\n");
    // Sanity: the parser accepts the empty body but returns no ops.
    expect(parseFragmentBody(emptyBody)).toEqual([]);
    const reason = failureReason(
      await validateFragmentBody({
        spec: spec("addon", "empty"),
        bodyTs: emptyBody,
      }),
    );
    expect(reason).toContain("empty apply() body");
    // The reason names the accepted vocabulary so the writer's next
    // attempt has direction.
    expect(reason).toContain("vfs.write");
  });

  it("does not persist a fragment with an empty body end-to-end through buildFragmentAuthoring", async () => {
    const { events } = recordingEvents();
    const { persistence, created, deleted } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: emptyBodyAuthorer, persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "noop")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual(["addon-noop"]);
    expect(created).toEqual([]);
    expect(deleted).toEqual([]);
    expect(result.failureReasons["addon-noop"]).toContain("empty apply() body");
  });
});

// ── M6 — batch `skipped` is explicitly treated as a failure ──────────────────

describe("Round-III M6 — batch `skipped` retracts + emits failed (no silent commit)", () => {
  it("treats a skipped batch compose the same as a failure", async () => {
    // We drive `drivePostAuthoringOutcome` directly with an
    // unresolvable-lifecycle-shaped input so `runPostAuthoringBatchCompose`
    // returns `{ kind: "skipped" }`. The outcome handler must retract each
    // authored row + emit failed, not silently commit.
    const { events, calls } = recordingEvents();
    const { persistence, deleted } = inMemoryPersistence();
    // An empty stack triggers UnresolvableLifecycleError → skipped.
    const brokenLifecycle: CaptureLifecycle = { ...lifecycle(), stack: "" };
    const library = loadFragmentLibrary();
    const outcome = await drivePostAuthoringOutcome({
      orgId: "org_a",
      lifecycle: brokenLifecycle,
      library,
      authored: [
        {
          spec: spec("addon", "orphan"),
          source: {
            fragmentId: "org_a:addon-orphan:1.0.0",
            kind: "addon",
            label: "orphan",
            version: "1.0.0",
            bodyTs: "irrelevant",
            contract: {},
            dependsOn: [],
          },
          attempts: 4,
          persistedFragmentId: "org_a:addon-orphan:1.0.0",
        },
      ],
      persistence,
      events,
    });
    // Retract fired + failed emitted with the skipped reason + real attempts.
    expect(deleted).toEqual(["org_a:addon-orphan:1.0.0"]);
    expect(outcome.retractedIds).toEqual(["addon-orphan"]);
    const failed = calls.find((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as
      | { reason: string; attempts: number }
      | undefined;
    expect(failed).toBeDefined();
    expect(failed?.reason).toContain("batch_compose_skipped");
    expect(failed?.attempts).toBe(4);
    // No succeeded event — the skipped case does NOT silently commit.
    const succeeded = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.succeeded");
    expect(succeeded).toHaveLength(0);
  });
});
