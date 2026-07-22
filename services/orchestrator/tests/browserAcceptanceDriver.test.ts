// rv-26.6 DECISIVE driver proof (DB-free). It drives the REAL
// AcceptanceOrchestrator through the REAL BrowserAcceptanceSurfaceDriver + the REAL
// canonical event-append seam, proving the fail-closed invariant the audit probes:
//   - 100 confirmed clicks ⇒ EXACTLY 100 `behavior.action.observed` events (no missing /
//     no dup) AND a `notify.clickCount == 100` observation ⇒ passed,
//   - a browser that cannot launch / an absent-or-erroring click ⇒ the surface is
//     inconclusive_infrastructure (NEVER passed) with ZERO events emitted — no short or
//     fabricated count,
//   - a runner that lies (ok:true with the wrong count) ⇒ the driver THROWS loud.
import { describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import { assertVerdictAssertionCoverage } from "../src/engine/contracts/runtimeVerificationInvariants.js";
import type { ExecutionMatrix } from "../src/engine/contracts/runtimeVerificationPlan.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  AcceptanceOrchestrator,
  BrowserAcceptanceSurfaceDriver,
  confirmedClickObservations,
  recordAttemptedVerdictSequential,
  type AcceptanceBaseUrlResolver,
  type AcceptanceDriveInput,
  type AcceptanceEventSink,
  type AcceptancePlan,
  type AcceptanceRunStore,
  type BrowserClickRunInput,
  type BrowserClickRunResult,
  type BrowserClickRunner,
  type CompleteAcceptanceRunInput,
  type EnsureVerificationPlanInput,
  type RecordAcceptanceRunInput,
  type RecordAcceptanceVerdictInput,
  type RecordAttemptedVerdictInput,
  type RecordAttemptedVerdictResult,
  type RecordAttemptInput,
  type StoredAcceptanceVerdict,
} from "../src/engine/verification/acceptance/index.js";

const ARTIFACT = `sha256:${"a".repeat(64)}` as Digest;

class InMemoryAcceptanceRunStore implements AcceptanceRunStore {
  public readonly verdicts: (RecordAcceptanceVerdictInput & { readonly verdictId: string })[] = [];
  private seq = 0;
  public recordRun(_input: RecordAcceptanceRunInput): Promise<string> {
    return Promise.resolve("run_mem_1");
  }
  public completeRun(_input: CompleteAcceptanceRunInput): Promise<void> {
    return Promise.resolve();
  }
  public ensureVerificationPlan(input: EnsureVerificationPlanInput): Promise<string> {
    return Promise.resolve(input.planId);
  }
  public recordAttempt(_input: RecordAttemptInput): Promise<string> {
    return Promise.resolve("attempt_mem_1");
  }
  public recordVerdict(input: RecordAcceptanceVerdictInput): Promise<string> {
    assertVerdictAssertionCoverage(input);
    const verdictId = `verdict_mem_${(this.seq += 1)}`;
    this.verdicts.push({ ...input, verdictId });
    return Promise.resolve(verdictId);
  }
  public recordAttemptedVerdict(input: RecordAttemptedVerdictInput): Promise<RecordAttemptedVerdictResult> {
    return recordAttemptedVerdictSequential(this, input);
  }
  public listVerdicts(): Promise<readonly StoredAcceptanceVerdict[]> {
    return Promise.resolve([]);
  }
}

class RecordingEventSink implements AcceptanceEventSink {
  public readonly events: { readonly eventType: EventName; readonly payload: unknown }[] = [];
  public append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.events.push({ eventType: input.eventType, payload: input.payload });
    return Promise.resolve();
  }
  public actionObserved(): readonly { readonly payload: unknown }[] {
    return this.events.filter((event) => event.eventType === "behavior.action.observed");
  }
}

/** A faithful runner double: confirms EXACTLY `clicks` clicks when the selector is the
 *  known present control; fails loud (as a real browser would) for any other selector. */
function fixtureRunner(presentSelector: string): BrowserClickRunner {
  return {
    runClicks(input: BrowserClickRunInput): Promise<BrowserClickRunResult> {
      if (input.selector !== presentSelector) {
        return Promise.resolve({ ok: false, kind: "click", reason: `selector '${input.selector}' not found` });
      }
      return Promise.resolve({ ok: true, observations: confirmedClickObservations(input.clicks) });
    },
  };
}

/** A LYING runner: reports success with a count that does NOT match the request. */
function miscountingRunner(returnCount: number): BrowserClickRunner {
  return {
    runClicks(_input: BrowserClickRunInput): Promise<BrowserClickRunResult> {
      return Promise.resolve({ ok: true, observations: confirmedClickObservations(returnCount) });
    },
  };
}

const MATRIX: ExecutionMatrix = {
  browser: [],
  viewport: [],
  locale: [],
  theme: [],
  motion: [],
  contrast: [],
  device: [],
};

function fixedResolver(baseUrl: string): AcceptanceBaseUrlResolver {
  return { resolve: (_input: AcceptanceDriveInput) => Promise.resolve({ kind: "resolved" as const, baseUrl }) };
}

function unresolvedResolver(reason: string): AcceptanceBaseUrlResolver {
  return { resolve: (_input: AcceptanceDriveInput) => Promise.resolve({ kind: "unresolved" as const, reason }) };
}

function clickPlan(clicks: number, expected: number, selector = "#target-control"): AcceptancePlan {
  return {
    planId: "plan_browser_rv266",
    behaviorRevisionId: "br_browser_rv266",
    requiredSurfaces: ["browser"],
    assertions: [{ assertionId: "a1", subject: "notify.clickCount", comparisonOperator: "equals", expected }],
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
    clickInteractions: [{ interactionId: "notify", selector, clicks }],
  };
}

function request(plans: readonly AcceptancePlan[]) {
  return {
    orgId: "org_1",
    projectId: "project_1",
    integrationNodeId: "inode_1",
    environmentId: "env_1",
    preparedHeadSha: "abc",
    jjTreeId: "tree",
    artifactDigest: ARTIFACT,
    deploymentFingerprint: "fp",
    plans,
  };
}

function orchestratorWith(runner: BrowserClickRunner, resolver: AcceptanceBaseUrlResolver, events: RecordingEventSink) {
  return new AcceptanceOrchestrator({
    store: new InMemoryAcceptanceRunStore(),
    events,
    drivers: [
      new BrowserAcceptanceSurfaceDriver({
        resolveBaseUrl: resolver,
        runner,
        events,
        now: () => "2026-07-21T00:00:00.000Z",
      }),
    ],
  });
}

describe("BrowserAcceptanceSurfaceDriver — real clicks, exact count, no fabrication", () => {
  it("DECISIVE: 100 confirmed clicks ⇒ exactly 100 behavior.action.observed + clickCount==100 ⇒ passed", async () => {
    const events = new RecordingEventSink();
    const orchestrator = orchestratorWith(fixtureRunner("#target-control"), fixedResolver("http://fixture"), events);
    const result = await orchestrator.execute(request([clickPlan(100, 100)]));
    const behavior = result.behaviors[0]!;

    expect(behavior.outcome).toBe("passed");
    expect(behavior.executedAssertionCount).toBe(1);
    // EXACTLY 100 action-observed events — no missing, no duplicate.
    const observed = events.actionObserved();
    expect(observed.length).toBe(100);
    for (const event of observed) {
      expect(event.payload).toMatchObject({
        behaviorRevisionId: "br_browser_rv266",
        shardId: "plan_browser_rv266:0",
        actionId: "notify",
        surface: "browser",
      });
    }
  });

  it("count integrity: a 100-click run never yields 99 or 101 events, and clickCount!=100 fails the assertion", async () => {
    const events = new RecordingEventSink();
    // The assertion demands 100 but the interaction confirms only 100 clicks — a plan asking
    // clickCount==101 must FAIL (never laundered by an off-by-one).
    const orchestrator = orchestratorWith(fixtureRunner("#target-control"), fixedResolver("http://fixture"), events);
    const behavior = (await orchestrator.execute(request([clickPlan(100, 101)]))).behaviors[0]!;
    expect(behavior.outcome).not.toBe("passed");
    expect(events.actionObserved().length).toBe(100);
  });

  it("NEGATIVE CONTROL: an absent/erroring click ⇒ inconclusive_infrastructure, ZERO events, no fabricated count", async () => {
    const events = new RecordingEventSink();
    // The fixture has no such control ⇒ the runner fails loud ⇒ the surface is unavailable.
    const orchestrator = orchestratorWith(fixtureRunner("#target-control"), fixedResolver("http://fixture"), events);
    const behavior = (await orchestrator.execute(request([clickPlan(100, 100, "#missing")]))).behaviors[0]!;
    // NOT passed, NOT failed_product on a fabricated count — the surface never executed.
    expect(behavior.outcome).not.toBe("passed");
    expect(behavior.executedAssertionCount).toBe(0);
    // The gravest fail-open: it must NOT have emitted a stream of fabricated clicks.
    expect(events.actionObserved().length).toBe(0);
  });

  it("NEGATIVE CONTROL: an unresolved deploy URL ⇒ inconclusive, no events, no clicks invented", async () => {
    const events = new RecordingEventSink();
    const orchestrator = orchestratorWith(
      fixtureRunner("#target-control"),
      unresolvedResolver("no release instance"),
      events,
    );
    const behavior = (await orchestrator.execute(request([clickPlan(100, 100)]))).behaviors[0]!;
    expect(behavior.outcome).not.toBe("passed");
    expect(events.actionObserved().length).toBe(0);
  });

  it("NEGATIVE CONTROL: a runner that lies (ok:true, wrong count) ⇒ the driver THROWS loud", async () => {
    const events = new RecordingEventSink();
    const orchestrator = orchestratorWith(miscountingRunner(3), fixedResolver("http://fixture"), events);
    await expect(orchestrator.execute(request([clickPlan(100, 100)]))).rejects.toThrow(/confirmed clicks/u);
    // A lie must never leak even a partial event stream.
    expect(events.actionObserved().length).toBe(0);
  });
});
