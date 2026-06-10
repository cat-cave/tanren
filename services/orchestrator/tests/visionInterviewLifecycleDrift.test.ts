// LIFECYCLE/STACK DRIFT GUARD tests (apex v28–v31).
//
// The Forge vision interview captures a STRUCTURED lifecycle (stack +
// bootstrap/tier1/2/3/build/deploy). Across rounds the LLM answerer DRIFTED it —
// re-writing the stack label, swapping a tier's test reporter (junit→json),
// dropping flags — so the operator's confirmed intent was not preserved verbatim
// and every apex setup had to re-normalize the drifted capture before derive.
//
// The fix: once a lifecycle is captured it is OPERATOR-CONFIRMED + PINNED. The
// capture-merge PRESERVES it verbatim; a re-emitted-but-different lifecycle is
// REJECTED as drift (and surfaced, never swallowed); a genuine change is taken
// ONLY when EXPLICIT (`lifecycleChange: true`) + operator-visible. Derive emits
// EXACTLY the captured commands (no re-LLM-derivation that could drift).
//
// These cover the merge pin, the runRound surfacing, and the derive verbatim
// projection. The pool is the same in-memory stub as visionInterview.test.ts.

import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  deriveFromCapture,
  emptyCapture,
  mergeCapture,
  resolveLifecycle,
  runRound,
  type CaptureLifecycle,
  type InterviewAnswerer,
  type InterviewCapture,
} from "../src/engine/forge/interview/index.js";
import { preparedDeploy, stubPool } from "./fixtures/forge/interviewDeriveStub.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

const TEST_REPO_URL = "https://github.com/cat-cave/supply-chain-os";

// The operator's CONFIRMED TS/pnpm lifecycle (the apex v27 default) — declared by
// the project, NOT a Tanren hardcode.
const TS_LIFECYCLE: CaptureLifecycle = {
  stack: "ts/pnpm",
  bootstrap: "pnpm install --frozen-lockfile",
  tier1: "pnpm lint && pnpm typecheck",
  tier2: "pnpm build && pnpm test -- --reporter=junit --outputFile=reports/junit.xml",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
};

// A DRIFTED re-emission: stack label re-written, the tier-2 reporter swapped
// junit→json, the tier-1 flag dropped — exactly the live round-to-round drift.
const DRIFTED: CaptureLifecycle = {
  stack: "typescript",
  bootstrap: "pnpm install",
  tier1: "pnpm lint",
  tier2: "pnpm build && pnpm test -- --reporter=json --outputFile=reports/test.json",
  tier3: "pnpm lint && pnpm typecheck && pnpm build && pnpm test",
  build: "pnpm build",
  deploy: "flyctl deploy",
};

const confirmedCapture = (): InterviewCapture => ({
  ...emptyCapture(),
  lifecycle: TS_LIFECYCLE,
  lifecycleConfirmed: true,
});

// A scripted answerer that re-emits a lifecycle delta (optionally flagged as an
// explicit change) — the drift the real LLM answerer exhibited.
const driftingAnswerer = (lifecycle: CaptureLifecycle, lifecycleChange?: boolean): InterviewAnswerer => ({
  async ask() {
    return {
      say: "anything else?",
      captureDelta: { lifecycle, ...(lifecycleChange === undefined ? {} : { lifecycleChange }) },
      suggestions: [],
      complete: false,
    };
  },
});

describe("mergeCapture · lifecycle pin (no silent drift)", () => {
  it("takes the FIRST lifecycle + latches it confirmed", () => {
    const merged = mergeCapture(emptyCapture(), { lifecycle: TS_LIFECYCLE });
    expect(merged.lifecycle).toEqual(TS_LIFECYCLE);
    expect(merged.lifecycleConfirmed).toBe(true);
  });

  it("PRESERVES a confirmed lifecycle when a later round drifts it (no explicit change)", () => {
    const base = mergeCapture(emptyCapture(), { lifecycle: TS_LIFECYCLE });
    // A later round re-emits a DRIFTED lifecycle WITHOUT a change signal.
    const merged = mergeCapture(base, { lifecycle: DRIFTED, behaviors: [] });
    // The confirmed lifecycle is preserved VERBATIM — the drift is rejected.
    expect(merged.lifecycle).toEqual(TS_LIFECYCLE);
    expect(merged.lifecycle?.stack).toBe("ts/pnpm");
    expect(merged.lifecycleConfirmed).toBe(true);
  });

  it("re-emitting the IDENTICAL confirmed lifecycle is a no-op (not drift)", () => {
    const base = mergeCapture(emptyCapture(), { lifecycle: TS_LIFECYCLE });
    const merged = mergeCapture(base, { lifecycle: { ...TS_LIFECYCLE } });
    expect(merged.lifecycle).toEqual(TS_LIFECYCLE);
    expect(resolveLifecycle(base, { lifecycle: { ...TS_LIFECYCLE } }).outcome).toBe("unchanged");
  });

  it("an EXPLICIT lifecycleChange:true is taken (a visible change is allowed)", () => {
    const base = mergeCapture(emptyCapture(), { lifecycle: TS_LIFECYCLE });
    const merged = mergeCapture(base, { lifecycle: DRIFTED, lifecycleChange: true });
    expect(merged.lifecycle).toEqual(DRIFTED);
    expect(merged.lifecycleConfirmed).toBe(true);
  });

  it("resolveLifecycle classifies initial/drift/changed/unchanged", () => {
    const base = mergeCapture(emptyCapture(), { lifecycle: TS_LIFECYCLE });
    expect(resolveLifecycle(emptyCapture(), { lifecycle: TS_LIFECYCLE }).outcome).toBe("initial");
    expect(resolveLifecycle(base, { lifecycle: DRIFTED }).outcome).toBe("drift");
    expect(resolveLifecycle(base, { lifecycle: DRIFTED, lifecycleChange: true }).outcome).toBe("changed");
    expect(resolveLifecycle(base, {}).outcome).toBe("unchanged");
  });
});

describe("runRound · lifecycle drift is surfaced (operator-visible)", () => {
  it("a drifting round PRESERVES the confirmed lifecycle + surfaces a drift notice", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { pool } = stubPool();
    const result = await runRound(
      { pool, answerer: driftingAnswerer(DRIFTED) },
      { round: 11, answer: "ok", capture: confirmedCapture() },
    );
    // The captured lifecycle survives the round UNCHANGED.
    expect(result.capture.lifecycle).toEqual(TS_LIFECYCLE);
    // The drift is surfaced (operator-visible) + logged loudly.
    expect(result.lifecycleDrift?.kind).toBe("drift");
    expect(result.lifecycleDrift?.effective.stack).toBe("ts/pnpm");
    expect(result.lifecycleDrift?.attempted.stack).toBe("typescript");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("REJECTED lifecycle drift"));
    warn.mockRestore();
  });

  it("an EXPLICIT change round takes the new lifecycle + surfaces a visible 'changed' notice", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { pool } = stubPool();
    const result = await runRound(
      { pool, answerer: driftingAnswerer(DRIFTED, true) },
      { round: 11, answer: "switch the stack", capture: confirmedCapture() },
    );
    expect(result.capture.lifecycle).toEqual(DRIFTED);
    expect(result.lifecycleDrift?.kind).toBe("changed");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EXPLICIT lifecycle change"));
    warn.mockRestore();
  });

  it("a non-lifecycle round carries no drift notice", async () => {
    const { pool } = stubPool();
    const answerer: InterviewAnswerer = {
      async ask() {
        return {
          say: "more personas?",
          captureDelta: { personas: [{ name: "ops", description: "x", surface: "" }] },
          suggestions: [],
          complete: false,
        };
      },
    };
    const result = await runRound({ pool, answerer }, { round: 5, answer: "ok", capture: confirmedCapture() });
    expect(result.lifecycleDrift).toBeUndefined();
    expect(result.capture.lifecycle).toEqual(TS_LIFECYCLE);
  });
});

describe("deriveProductGraph · emits EXACTLY the captured lifecycle (no re-derivation drift)", () => {
  it("persists the captured lifecycle commands verbatim onto the project config", async () => {
    const { pool, configs } = stubPool();
    const captured: InterviewCapture = {
      ...confirmedCapture(),
      identity: { slug: "shortener", pitch: "url shortener", repoHint: "" },
    };
    const derived = await deriveFromCapture(
      {
        pool,
        async prepareDeploy(request) {
          return preparedDeploy(request.providerKind as "deploy.vercel" | "deploy.flyio");
        },
      },
      {
        orgId: "org_a",
        capture: captured,
        actor,
        repoUrl: TEST_REPO_URL,
        deploy: { providerKind: "deploy.vercel" },
        // This test asserts lifecycle persistence (identical seed-or-scratch). Run it as
        // the template-BUILD origin (the legitimate from-scratch authoring) so it does
        // not require a template registry query to exercise the verbatim projection.
        scaffoldOrigin: "template_build",
      },
    );
    const config = configs.get(derived.projectId) as { lifecycle?: CaptureLifecycle } | undefined;
    // Byte-for-byte the captured lifecycle — derive does NOT re-LLM-derive it.
    expect(config?.lifecycle).toEqual(TS_LIFECYCLE);
  });
});
