// Per-attempt observability for the F2 writer-rework loop
// (fix/f2-per-attempt-observability). Today the loop emits
// `fragment.authoring.{started,succeeded,failed}` — 3 events per authoring run.
// On a many-iteration run the operator sees "succeeded, attempts: 7" but has NO
// visibility into what attempts 1-6 tried. This file pins the per-iteration
// emit contract: one `fragment.authoring.attempt` event per for-loop iteration,
// carrying the writer body preview + canonical signature + rejection + decision.

import { describe, expect, it } from "vitest";
import {
  buildFragmentAuthoring,
  FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX,
  type FragmentAuthoringAttemptDecision,
  type FragmentAuthoringEvents,
  type FragmentAuthorer,
  type FragmentPersistence,
  type FragmentSpec,
  truncateBodyPreview,
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

function inMemoryPersistence(): { persistence: FragmentPersistence } {
  const persistence: FragmentPersistence = {
    async createValidated(input) {
      return { fragmentId: `${input.orgId}:${input.spec.id}:1.0.0` };
    },
    async deleteById() {
      /* Round-III H1 stub — observability tests don't exercise retract. */
    },
  };
  return { persistence };
}

/** Type-narrow helper for the recorded event stream. */
type AttemptEvent = {
  kind: "fragment.authoring.attempt";
  orgId: string;
  fragmentId: string;
  attempt: number;
  bodyPreview: string;
  canonicalSignature: string;
  rejection: string;
  decision: FragmentAuthoringAttemptDecision;
};

function attemptEvents(calls: unknown[]): AttemptEvent[] {
  return calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.attempt") as AttemptEvent[];
}

/** Authorer that produces a DISTINCT un-parsable body on each of the first N-1
 * calls (so the loop registers PROGRESS + `continue`) then REPEATS the (N-1)th
 * body on call N — identical canonical signature + identical rejection ⇒ the
 * fixed-point detector fires on the Nth iteration. Yields exactly N attempt
 * events before the terminal `failed`. */
function iteratingBadAuthorer(iterations: number): FragmentAuthorer {
  let call = 0;
  return async () => {
    call += 1;
    // Calls 1..iterations-1 produce distinct bodies; call `iterations` repeats
    // the (iterations-1)th body verbatim ⇒ fixed point fires on that call.
    const idx = call < iterations ? call : iterations - 1;
    return { bodyTs: `not a valid fragment module — iter ${idx}` };
  };
}

const testActor = {
  userId: "u",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"] as const,
  source: "session" as const,
};

describe("fragment.authoring.attempt — per-iteration observability", () => {
  it("a 3-attempt authoring emits 3 attempt events + 1 succeeded", async () => {
    // A stateful authorer that fails twice, then produces a valid body on
    // attempt #3. Each failing body is DIFFERENT so the fixed-point detector
    // registers progress + the loop continues.
    let call = 0;
    const winnerAuthorer: FragmentAuthorer = async (input) => {
      call += 1;
      if (call < 3) {
        // Un-parsable body — validator rejects, canonical signature changes each
        // iteration so the fixed-point detector sees progress + continues.
        return { bodyTs: `not a valid fragment module — iter ${call}` };
      }
      // Attempt 3: delegate to the deterministic fake, which produces a valid body.
      return buildFakeFragmentAuthorer()(input);
    };
    const { events, calls } = recordingEvents();
    const { persistence } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: winnerAuthorer, persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "flaky")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([]);
    // Three attempt events fire (one per iteration of the writer-rework loop).
    const attempts = attemptEvents(calls);
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    // The first two are `continue` (progress made; another iteration ran); the
    // third is `converged` (validated + persisted).
    expect(attempts.map((a) => a.decision)).toEqual(["continue", "continue", "converged"]);
    // The winning attempt carries an empty rejection; earlier attempts carry the
    // validator's rejection message.
    expect(attempts[0]!.rejection.length).toBeGreaterThan(0);
    expect(attempts[1]!.rejection.length).toBeGreaterThan(0);
    expect(attempts[2]!.rejection).toBe("");
    // Exactly one succeeded event, no failed event.
    const succeeded = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.succeeded");
    expect(succeeded).toHaveLength(1);
    const failed = calls.filter((c) => (c as { kind: string }).kind === "fragment.authoring.failed");
    expect(failed).toHaveLength(0);
  });

  it("a fixed-point halt emits N attempt events + 1 failed (last decision = halted_fixed_point)", async () => {
    // Force a 3-iteration progress-then-halt shape: two distinct bodies (which
    // the validator rejects but with DIFFERENT canonical signatures ⇒
    // continue), then the same body a third time (identical canonical signature
    // + identical rejection ⇒ halted_fixed_point).
    const { events, calls } = recordingEvents();
    const { persistence } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: iteratingBadAuthorer(3), persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "stuck")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual(["addon-stuck"]);
    const attempts = attemptEvents(calls);
    // Three iterations: two `continue` (bodies differed), one
    // `halted_fixed_point` (body/rejection identical to previous).
    expect(attempts).toHaveLength(3);
    expect(attempts.map((a) => a.decision)).toEqual(["continue", "continue", "halted_fixed_point"]);
    // 1-indexed attempt numbers monotonically increase.
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    // Every failing attempt carries a non-empty rejection.
    for (const a of attempts) {
      expect(a.rejection.length).toBeGreaterThan(0);
    }
    // Exactly one terminal failed event with attempts === last attempt count.
    const failed = calls.find((c) => (c as { kind: string }).kind === "fragment.authoring.failed") as
      | { attempts: number; reason: string }
      | undefined;
    expect(failed).toBeDefined();
    expect(failed?.attempts).toBe(3);
  });

  it("bodyPreview is truncated at the length ceiling", () => {
    // Under the limit — returned verbatim.
    const short = "a".repeat(100);
    expect(truncateBodyPreview(short)).toBe(short);
    expect(truncateBodyPreview(short).length).toBe(100);
    // At the limit — returned verbatim.
    const exact = "a".repeat(FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX);
    expect(truncateBodyPreview(exact)).toBe(exact);
    expect(truncateBodyPreview(exact).length).toBe(FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX);
    // Over the limit — sliced + ellipsis (single-char ellipsis, so total length
    // is CEILING + 1). The ellipsis is a payload marker that the body was cut.
    const long = "a".repeat(FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX + 200);
    const truncated = truncateBodyPreview(long);
    expect(truncated.length).toBe(FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX + 1);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.startsWith("a".repeat(FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX))).toBe(true);
  });

  it("emitted bodyPreview reflects the truncation limit on a long-body iteration", async () => {
    // An authorer whose body exceeds the preview ceiling. The emitted
    // bodyPreview must be exactly CEILING+1 chars (slice + ellipsis).
    const longBody = "// pad ".repeat(FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX);
    const longBodyAuthorer: FragmentAuthorer = async () => ({ bodyTs: longBody });
    const { events, calls } = recordingEvents();
    const { persistence } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: longBodyAuthorer, persistence, events });
    await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "verbose")],
      lifecycle: lifecycle(),
    });
    const attempts = attemptEvents(calls);
    expect(attempts.length).toBeGreaterThan(0);
    // The bodyPreview must be truncated to CEILING + 1 (slice + ellipsis marker).
    expect(attempts[0]!.bodyPreview.length).toBe(FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX + 1);
    expect(attempts[0]!.bodyPreview.endsWith("…")).toBe(true);
    // canonicalSignature is populated (a SHA-256 hash) — non-empty.
    expect(attempts[0]!.canonicalSignature.length).toBeGreaterThan(0);
  });

  it("decision = converged on the winning attempt of a single-iteration success", async () => {
    // The deterministic fake produces a valid body on iteration 1 ⇒ ONE
    // attempt event with decision=converged, no failed event.
    const { events, calls } = recordingEvents();
    const { persistence } = inMemoryPersistence();
    const runner = buildFragmentAuthoring({ authorer: buildFakeFragmentAuthorer(), persistence, events });
    const result = await runner({
      orgId: "org_a",
      actor: { ...testActor, scopes: [...testActor.scopes] },
      missing: [spec("addon", "single-shot")],
      lifecycle: lifecycle(),
    });
    expect(result.failedIds).toEqual([]);
    const attempts = attemptEvents(calls);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.attempt).toBe(1);
    expect(attempts[0]!.decision).toBe("converged");
    expect(attempts[0]!.rejection).toBe("");
    // bodyPreview is the (short) body of the deterministic fake — not truncated.
    expect(attempts[0]!.bodyPreview.length).toBeLessThanOrEqual(FRAGMENT_AUTHORING_ATTEMPT_BODY_PREVIEW_MAX);
    // Followed by succeeded, in that order (attempt event precedes succeeded).
    const eventKinds = calls.map((c) => (c as { kind: string }).kind);
    expect(eventKinds.indexOf("fragment.authoring.attempt")).toBeLessThan(
      eventKinds.indexOf("fragment.authoring.succeeded"),
    );
  });
});
