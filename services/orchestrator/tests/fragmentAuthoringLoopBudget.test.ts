// Tests for the F2 loop-budget hardening (fix/f2-loop-budget-batch-persist):
//
//   Fix 1 — bounded loop with progress-window comparison (Codex HIGH #3)
//           + per-fragment iteration ceiling safety net.
//   Fix 2 — sanitize authorer-throw signature (Claude HIGH #3).
//   Fix 3 — post-authoring batch compose (Codex HIGH #2).
//   Fix 4 — emit fragment.authoring.failed on persistence throw (Codex MED #2).

import { describe, expect, it } from "vitest";
import {
  buildFragmentAuthoring,
  FRAGMENT_AUTHORING_ITERATION_CEILING,
  FRAGMENT_AUTHORING_SIGNATURE_WINDOW,
  type FragmentAuthoringEvents,
  type FragmentAuthorer,
  type FragmentPersistence,
  type FragmentSpec,
  sanitizeAuthorerErrorSignature,
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

function inMemoryPersistence(): { persistence: FragmentPersistence; created: unknown[] } {
  const created: unknown[] = [];
  const persistence: FragmentPersistence = {
    async createValidated(input) {
      created.push(input);
      return { fragmentId: `${input.orgId}:${input.spec.id}:1.0.0` };
    },
  };
  return { persistence, created };
}

const testActor = {
  userId: "u",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"] as const,
  source: "session" as const,
};

// ─── Fix 1: bounded loop with progress-window comparison ─────────────────────

describe("Fix 1 — alternating-body drift halts inside the signature window", () => {
  it("an authorer alternating between two rejection classes halts at the fixed point", async () => {
    // The writer returns "A" on odd attempts and "B" on even attempts —
    // NEITHER matches the immediately-prior signature (A→B→A→B), so the
    // prior single-prev-signature comparison would loop unbounded. The new
    // window comparison sees "A" reappear in the trailing 8 signatures on
    // attempt 3 ⇒ fixed point + halt.
    let n = 0;
    const alternatingAuthorer: FragmentAuthorer = async () => {
      n += 1;
      // Un-parseable body → validation rejects; the signature is derived
      // from the canonical body + rejection. Odd attempts produce body "A",
      // even attempts produce body "B" — 2 distinct rejection classes.
      return {
        bodyTs: n % 2 === 1 ? "not a valid fragment module — variant A" : "not a valid fragment module — variant B",
      };
    };
    const { events, calls } = recordingEvents();
    const { persistence, created } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: alternatingAuthorer, persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "alternating")],
      lifecycle: lifecycle(),
    });
    // The alternating loop halts — the id is in failedIds, nothing persisted.
    expect(result.failedIds).toEqual(["addon-alternating"]);
    expect(created).toHaveLength(0);
    // Attempts must be well inside the ceiling — the window catches it on the
    // 3rd attempt (attempt 1 pushes A, attempt 2 pushes B, attempt 3's A is
    // in the window ⇒ halt). Assert bounded: at most 4 attempts.
    const attempts = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.attempt");
    expect(attempts.length).toBeLessThanOrEqual(4);
    const failed = calls.find((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as
      | { attempts: number; reason: string }
      | undefined;
    expect(failed).toBeDefined();
    expect(failed?.reason ?? "").not.toContain("iteration_ceiling_exceeded");
    // Sanity: the calls exercise BOTH variants (proving the alternation ran
    // long enough that the single-prev-signature comparison would have missed
    // the fixed point).
    expect(n).toBeGreaterThanOrEqual(3);
  });
});

describe("Fix 1 — iteration ceiling caps runaway signature drift", () => {
  it("an authorer producing a NEW body every attempt (never repeats) halts at the ceiling", async () => {
    // Every attempt is a NEW distinct un-parseable body ⇒ NEW rejection class
    // ⇒ new signature every iteration. The trailing window never triggers a
    // fixed point (each new signature is not in the window). The ceiling
    // catches the runaway. Kill switch is at attempt (CEILING + 1).
    let n = 0;
    const drifterAuthorer: FragmentAuthorer = async () => {
      n += 1;
      // A completely unique un-parseable body — signature never repeats.
      return { bodyTs: `not a valid fragment module — unique drift ${n}` };
    };
    const { events, calls } = recordingEvents();
    const { persistence, created } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: drifterAuthorer, persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "drifter")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual(["addon-drifter"]);
    expect(created).toHaveLength(0);
    // The ceiling caps the authorer invocation count at exactly CEILING (the
    // (CEILING + 1)-th attempt bails BEFORE calling the authorer).
    expect(n).toBe(FRAGMENT_AUTHORING_ITERATION_CEILING);
    const failed = calls.find((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as
      | { attempts: number; reason: string }
      | undefined;
    expect(failed).toBeDefined();
    // Reason names the ceiling class + attempts count.
    expect(failed?.reason).toContain("iteration_ceiling_exceeded");
    expect(failed?.attempts).toBe(FRAGMENT_AUTHORING_ITERATION_CEILING);
  });

  it("ceiling constant is well above the signature window (both bounds have room to serve their failure modes)", () => {
    // Sanity check the constants — the window must be the PRIMARY bound
    // (progress-based); the ceiling is the SAFETY NET (hard integer count).
    // A ceiling too close to the window would mean the ceiling routinely
    // fires before legitimate slow convergence can complete.
    expect(FRAGMENT_AUTHORING_ITERATION_CEILING).toBeGreaterThan(FRAGMENT_AUTHORING_SIGNATURE_WINDOW * 2);
  });
});

// ─── Fix 2: sanitize authorer-threw signature ─────────────────────────────────

describe("Fix 2 — sanitizeAuthorerErrorSignature strips content-variable noise", () => {
  it("strips ISO 8601 timestamps to <TIMESTAMP>", () => {
    const raw = "provider error at 2026-07-07T14:22:41Z from upstream";
    const sanitized = sanitizeAuthorerErrorSignature(raw);
    expect(sanitized).toBe("provider error at <TIMESTAMP> from upstream");
  });

  it("strips fractional-second timestamps with timezone", () => {
    const raw = "logged 2026-07-07T14:22:41.123+00:00 by client";
    const sanitized = sanitizeAuthorerErrorSignature(raw);
    expect(sanitized).toBe("logged <TIMESTAMP> by client");
  });

  it("strips UUIDs / request ids to <UUID>", () => {
    const raw = "request_id 7f3c1a2b-8d4e-4c1f-9a2b-1e2d3c4b5a69 rejected";
    const sanitized = sanitizeAuthorerErrorSignature(raw);
    expect(sanitized).toBe("request_id <UUID> rejected");
  });

  it("strips Retry-After clocks to retry-after:<N>", () => {
    expect(sanitizeAuthorerErrorSignature("Retry-After: 12")).toBe("retry-after:<N>");
    expect(sanitizeAuthorerErrorSignature("please retry after 30 seconds")).toBe("please retry-after:<N>");
    expect(sanitizeAuthorerErrorSignature("retry-after 5s")).toBe("retry-after:<N>");
  });

  it("strips bare millisecond counters to <MS>", () => {
    const raw = "operation took 4200ms and failed";
    const sanitized = sanitizeAuthorerErrorSignature(raw);
    expect(sanitized).toBe("operation took <MS> and failed");
  });

  it("strips Unix timestamps (10-13 digit numbers) to <UNIX_TS>", () => {
    const raw = "epoch 1720000000 exceeded";
    const sanitized = sanitizeAuthorerErrorSignature(raw);
    expect(sanitized).toBe("epoch <UNIX_TS> exceeded");
  });

  it("two cosmetically-different errors from the SAME failure class sanitize to the same string", () => {
    const a =
      "rate limit hit at 2026-07-07T14:22:41Z, request_id abcd1234-5678-90ab-cdef-1234567890ab, retry after 12 seconds";
    const b =
      "rate limit hit at 2026-07-07T15:33:52Z, request_id 11112222-3333-4444-5555-666677778888, retry after 30 seconds";
    expect(sanitizeAuthorerErrorSignature(a)).toBe(sanitizeAuthorerErrorSignature(b));
  });
});

describe("Fix 2 — stuck-provider throwing cosmetically-different errors halts at fixed point", () => {
  it("an authorer throwing rate-limit-shaped errors with different clocks each attempt halts inside the window", async () => {
    // Simulate a stuck rate-limited LLM: throws with the same failure class
    // but different timestamp + request-id + retry-after clock each attempt.
    // Prior to the sanitizer, the raw error message differed every attempt
    // ⇒ new signature every iteration ⇒ unbounded loop until the ceiling.
    // With the sanitizer, all attempts hash to the same signature ⇒ the
    // window catches the fixed point after 1-2 attempts.
    let attempt = 0;
    const stuckProviderAuthorer: FragmentAuthorer = async () => {
      attempt += 1;
      const ts = new Date(1_720_000_000_000 + attempt * 10_000).toISOString();
      const req = `abcd${attempt.toString().padStart(4, "0")}-5678-90ab-cdef-1234567890ab`;
      throw new Error(`rate limit at ${ts}, request_id ${req}, retry after ${attempt} seconds`);
    };
    const { events, calls } = recordingEvents();
    const { persistence } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: stuckProviderAuthorer, persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "stuck-provider")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual(["addon-stuck-provider"]);
    // The window catches the fixed point WELL below the ceiling. Attempts
    // ≤ FRAGMENT_AUTHORING_SIGNATURE_WINDOW + 1 (first attempt pushes the
    // signature; second attempt's identical sanitized signature is in the
    // window ⇒ halt).
    expect(attempt).toBeLessThanOrEqual(FRAGMENT_AUTHORING_SIGNATURE_WINDOW + 1);
    const failed = calls.find((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as
      | { reason: string }
      | undefined;
    expect(failed).toBeDefined();
    // The failure reason surfaces the RAW rejection (not the sanitized one) —
    // an operator debugging sees the real timestamp / request id / clock.
    expect(failed?.reason ?? "").toMatch(/rate limit at 20/u);
  });
});

// ─── Fix 3: post-authoring batch compose ─────────────────────────────────────

// A test authorer that emits a node-only addon (uses `addPackageJsonDep` so
// the implicit dependsOn = [runtime-node-pnpm]). Kept at module scope so
// oxlint's consistent-function-scoping rule is happy (the function captures
// no vars from the describe block).
const nodeAddonAuthorer: FragmentAuthorer = async (input) => {
  const s = input.spec;
  // `lodash` is not declared by any bundled fragment — no version conflict
  // in the full-library smoke, but the `addPackageJsonDep` op still
  // triggers the implicit dependsOn = [runtime-node-pnpm].
  const lines: string[] = [
    `import { type Fragment, type TemplateConfig, type VirtualFileSystem } from "../types.js";`,
    `export const fragment: Fragment = {`,
    `  id: "${s.id}",`,
    `  version: "1.0.0",`,
    `  kind: "${s.kind}",`,
    `  contract: ${JSON.stringify(s.requiredContract)},`,
    `  async apply(vfs: VirtualFileSystem, _config: TemplateConfig): Promise<void> {`,
    `    vfs.write("docs/${s.id}.md", "${s.id}\\n");`,
    `    vfs.addPackageJsonDep("lodash", "^4.17.0");`,
    `  },`,
    `};`,
    `export default fragment;`,
  ];
  return { bodyTs: lines.join("\n") };
};

describe("Fix 3 — post-authoring batch compose catches cross-fragment dependency_runtime_mismatch", () => {
  it("moves ALL freshly-authored fragments to failedIds when the batch compose throws", async () => {
    // Author an addon that declares a NODE-only package.json op (implicit
    // `dependsOn: [runtime-node-pnpm]` — from `implicitDependsOn.ts`). The
    // captured lifecycle stack is python → the derived TemplateConfig has
    // runtime=python. The augmented library has the freshly-authored addon
    // but NOT `runtime-python`. When the batch compose runs against the
    // derived config, `composeTemplate`'s `library.require("runtime-python")`
    // throws — the batch compose catches this + moves the authored spec to
    // failedIds with `batch_compose_failed:`.
    //
    // Note: the ISOLATED + FULL-LIBRARY smokes both build their configs off
    // the AUTHORED spec's kind (defaulting to node-pnpm for a non-runtime
    // spec), so they PASS on their own. This failure only emerges against
    // the CAPTURED runtime — exactly what the batch compose adds.
    // (The `nodeAddonAuthorer` is hoisted to module scope for oxlint.)
    const { events, calls } = recordingEvents();
    const { persistence, created } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: nodeAddonAuthorer, persistence, events });
    // The lifecycle uses a python stack → derived config has runtime=python.
    const pythonLifecycle: CaptureLifecycle = {
      ...lifecycle(),
      stack: "python + fly",
      deploy: "fly deploy",
    };
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "node-tool")],
      lifecycle: pythonLifecycle,
    });
    // Per-fragment smokes passed — the addon was authored + persisted.
    expect(created).toHaveLength(1);
    // But the batch compose rejects: no runtime-python in the library. The
    // addon is moved to failedIds with the batch-compose reason.
    expect(result.failedIds).toEqual(["addon-node-tool"]);
    expect(result.failureReasons["addon-node-tool"]).toContain("batch_compose_failed:");
    // Terminal failed event emitted for the involved spec.
    const failedEvents = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as {
      fragmentId: string;
      reason: string;
    }[];
    expect(failedEvents.map((e) => e.fragmentId)).toEqual(["addon-node-tool"]);
    expect(failedEvents[0]?.reason).toContain("batch_compose_failed:");
    // The stream ALSO shows the per-fragment succeeded event (the fragment
    // did author + persist) — the batch compose is a POST-authoring gate that
    // retracts the success. An observer sees both events + the retraction,
    // which is the correct observability contract (the per-fragment path
    // truly did succeed; the batch caught a cross-fragment issue after).
    const succeeded = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.succeeded");
    expect(succeeded).toHaveLength(1);
  });

  it("succeeds when the batch compose passes (fake authorer against a node-pnpm lifecycle)", async () => {
    // A sanity check that the batch compose does NOT reject a legitimate run:
    // the deterministic fake authorer produces node-only bodies compatible with
    // the node-pnpm lifecycle, so the batch compose passes + the fragments
    // stay in the augmented library.
    const { events, calls } = recordingEvents();
    const { persistence, created } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: buildFakeFragmentAuthorer(), persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "one"), spec("addon", "two")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([]);
    expect(created).toHaveLength(2);
    // No failed events at all.
    const failedEvents = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.failed");
    expect(failedEvents).toHaveLength(0);
  });
});

// ─── Fix 4: emit failed on persistence throw ─────────────────────────────────

describe("Fix 4 — persistence throw emits fragment.authoring.failed + does not throw upward", () => {
  it("a persistence throw moves the fragment to failedIds + emits terminal failed event", async () => {
    // The persistence seam throws on a unique-index collision (a concurrent
    // authoring run for the same org+kind+label+version already claimed the
    // row). Prior behavior: the event stream showed "attempt converged" with
    // no terminal failure event because the throw bubbled up before the
    // succeeded event fired. The fix wraps the persist in try/catch, emits
    // failed with reason "persistence_failed: <err.message>", and moves the
    // spec to failedIds.
    const { events, calls } = recordingEvents();
    const throwingPersistence: FragmentPersistence = {
      async createValidated() {
        throw new Error("unique constraint violation: fragments_org_kind_label_version_key");
      },
    };
    const runner = buildFragmentAuthoring({
      authorer: buildFakeFragmentAuthorer(),
      persistence: throwingPersistence,
      events,
    });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "colliding")],
      lifecycle: lifecycle(),
    });
    // The spec surfaced as failed — the runner did NOT throw upward.
    expect(result.failedIds).toEqual(["addon-colliding"]);
    expect(result.failureReasons["addon-colliding"]).toContain("persistence_failed:");
    expect(result.failureReasons["addon-colliding"]).toContain("unique constraint violation");
    // The event stream carries the terminal failed event with the persistence reason.
    const failed = calls.find((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as
      | { reason: string; attempts: number }
      | undefined;
    expect(failed).toBeDefined();
    expect(failed?.reason).toContain("persistence_failed:");
    // The converged attempt event STILL emitted (before persist tried), so the
    // stream shows: attempt(converged) → failed. This is the correct order:
    // the loop DID converge, then persistence rejected the atomic insert.
    const attempts = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.attempt") as {
      decision: string;
    }[];
    expect(attempts.some((a) => a.decision === "converged")).toBe(true);
    // No succeeded event — the run terminalizes as failed.
    const succeeded = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.succeeded");
    expect(succeeded).toHaveLength(0);
  });

  it("subsequent specs in the same authoring run still process after a persistence throw", async () => {
    // A persistence throw on the FIRST spec must NOT short-circuit authoring
    // the REST of the missing list — the outer loop's per-spec accumulator
    // captures the failure + continues.
    let call = 0;
    const persistenceThrowsFirstThenOk: FragmentPersistence = {
      async createValidated(input) {
        call += 1;
        if (call === 1) throw new Error("first-call collision");
        return { fragmentId: `${input.orgId}:${input.spec.id}:1.0.0` };
      },
    };
    const { events, calls } = recordingEvents();
    const runner = buildFragmentAuthoring({
      authorer: buildFakeFragmentAuthorer(),
      persistence: persistenceThrowsFirstThenOk,
      events,
    });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "first"), spec("addon", "second")],
      lifecycle: lifecycle(),
    });
    // First spec failed, second spec succeeded.
    expect(result.failedIds).toEqual(["addon-first"]);
    expect(result.failureReasons["addon-first"]).toContain("persistence_failed:");
    // The augmented library carries the successful second fragment.
    expect(result.library.has("addon-second")).toBe(true);
    // Terminal events for both: failed(first) + succeeded(second).
    const kinds = calls.map((c) => (c as { kind: string }).kind);
    expect(kinds.filter((k) => k === "fragment.authoring.failed")).toHaveLength(1);
    expect(kinds.filter((k) => k === "fragment.authoring.succeeded")).toHaveLength(1);
  });
});
