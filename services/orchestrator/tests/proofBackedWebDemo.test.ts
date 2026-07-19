// rv-18 A2 — the PROOF-BACKED web demo. DECISIVE proof: a deployed product whose `/`
// returns 200 but whose DECLARED BEHAVIOR fails its acceptance assertion produces a FAILED
// demo — the demo verdict is the REAL per-behavior acceptance verdict, not reachability.
// Driven over the REAL rv-11 AcceptanceOrchestrator + the REAL rv-6 HttpAcceptanceSurfaceDriver
// with a SCRIPTED fetch (no live network) + a fake base-url resolver + a compiled plan, so the
// full assertion algebra + fail-closed outcome resolution runs for real; only the network I/O
// and the plan source are scripted.

import { describe, expect, it } from "vitest";
import { getJobOrgId } from "@tanren/db";
import type { Digest } from "../src/engine/contracts/cas.js";
import type { ReleaseInstanceRecord } from "../src/engine/contracts/deployAdapter.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  AcceptanceOrchestrator,
  HttpAcceptanceSurfaceDriver,
  compileAcceptancePlan,
  type AcceptanceBaseUrlResolver,
  type AcceptancePlan,
  type AcceptancePlanLoader,
  type HttpFetch,
  type HttpResponseLike,
} from "../src/engine/verification/acceptance/index.js";
import {
  EphemeralAcceptanceEventSink,
  EphemeralAcceptanceRunStore,
  ProofBackedDemoNoBehaviorsError,
  ProofBackedDemoUnobservableError,
  ProofBackedWebDemo,
} from "../src/engine/demo/proofBackedWebDemo.js";

const ORG = "org_demo";
const RUN = "run_demo";
const SPEC = "spec_demo";
const PROJECT = "proj_demo";
const BR = "br_health";
const DIGEST = `sha256:${"a".repeat(64)}` as Digest;
const BASE_URL = "https://product.test";

const TARGET = { runId: RUN, specId: SPEC, projectId: PROJECT, orgId: ORG };

class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: Record<string, unknown>; ambientOrgId?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({
      eventType: input.eventType,
      payload: input.payload as Record<string, unknown>,
      ambientOrgId: getJobOrgId(),
    });
  }
}

/** A release delivering the `br_health` behavior, reachable at the scripted base URL. */
function release(behaviorRevisionIds: readonly string[]): ReleaseInstanceRecord {
  return {
    releaseInstanceId: "ri_1",
    orgId: ORG,
    projectId: PROJECT,
    provider: "deploy.flyio",
    appId: "app_1",
    environment: "production",
    deploymentId: "dep_1",
    sourceRef: "abcdef1234",
    artifactDigest: DIGEST,
    providerChecksum: null,
    integrationNodeId: RUN,
    behaviorRevisionIds: behaviorRevisionIds as ReleaseInstanceRecord["behaviorRevisionIds"],
    url: BASE_URL,
    region: null,
    previousReleaseInstanceId: null,
    state: "live",
    createdAt: "2026-07-18T00:00:00.000Z",
  };
}

/** The single-behavior acceptance spec: GET /health, its body's `ok` flag must be true. */
function healthPlan(): AcceptancePlan {
  return compileAcceptancePlan({
    id: BR,
    acceptance: {
      requiredSurfaces: ["api"],
      httpProbes: [{ probeId: "p1", method: "GET", path: "/health" }],
      assertions: [{ assertionId: "a1", subject: "p1.body.ok", comparisonOperator: "equals", expected: true }],
    },
  });
}

const planLoader = (plans: readonly AcceptancePlan[]): AcceptancePlanLoader => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  async loadPlans() {
    return plans;
  },
});

const resolver = (result: Awaited<ReturnType<AcceptanceBaseUrlResolver["resolve"]>>): AcceptanceBaseUrlResolver => ({
  // eslint-disable-next-line @typescript-eslint/require-await
  async resolve() {
    return result;
  },
});

/** A scripted fetch: `/` always answers 200, `/health` answers 200 with the given body. */
function scriptedFetch(healthBody: unknown): HttpFetch & { hits: string[] } {
  const hits: string[] = [];
  const fetchImpl: HttpFetch = (url) => {
    hits.push(new URL(url).pathname);
    const body = new URL(url).pathname === "/health" ? JSON.stringify(healthBody) : "OK";
    const response: HttpResponseLike = {
      status: 200,
      headers: { get: () => null },
      // eslint-disable-next-line @typescript-eslint/require-await
      text: async () => body,
    };
    return Promise.resolve(response);
  };
  return Object.assign(fetchImpl, { hits });
}

function buildDemo(events: EventStore, plans: readonly AcceptancePlan[], fetchImpl: HttpFetch): ProofBackedWebDemo {
  const orchestrator = new AcceptanceOrchestrator({
    store: new EphemeralAcceptanceRunStore(),
    events: new EphemeralAcceptanceEventSink(),
    drivers: [
      new HttpAcceptanceSurfaceDriver({ resolveBaseUrl: resolver({ kind: "resolved", baseUrl: BASE_URL }), fetchImpl }),
    ],
  });
  return new ProofBackedWebDemo({ events, planLoader: planLoader(plans), orchestrator });
}

describe("ProofBackedWebDemo — the demo verdict is the real behavior verdict", () => {
  it("DECISIVE: `/` returns 200 but the declared behavior FAILS its assertion → a FAILED demo (not a pass)", async () => {
    const events = new RecordingEventStore();
    // The product is UP (every route answers 200) but GET /health reports { ok: false } — the
    // behavior's acceptance assertion (p1.body.ok == true) FAILS. A naive `/`-probe would pass.
    const fetchImpl = scriptedFetch({ ok: false });
    const demo = buildDemo(events, [healthPlan()], fetchImpl);

    const result = await demo.demo(TARGET, release([BR]));

    // The demo did NOT pass: the behavior's evidence is FAILED and the summary tally is 0/1.
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.evidence[0]!.outcome).toBe("failed");
    // The evidence carries the REAL acceptance outcome — a product failure, not reachability.
    expect(result.evidence[0]!.detail).toContain("failed_product");
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "web_url", behaviorCount: 1, passed: 0, failed: 1 });
    expect(summary!.ambientOrgId).toBe(ORG);
    // The real behavior route WAS driven (not just `/`): the driver fired GET /health.
    expect(fetchImpl.hits).toContain("/health");
  });

  it("a genuinely-working product (behavior passes its assertion) → a PASSING demo", async () => {
    const events = new RecordingEventStore();
    const demo = buildDemo(events, [healthPlan()], scriptedFetch({ ok: true }));

    const result = await demo.demo(TARGET, release([BR]));

    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.evidence[0]!.outcome).toBe("passed");
    expect(result.evidence[0]!.detail).toContain("acceptance passed");
    const evidence = events.appends.filter((a) => a.eventType === "demo.evidence.recorded");
    expect(evidence).toHaveLength(1);
    expect(evidence.every((a) => a.ambientOrgId === ORG)).toBe(true);
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ behaviorCount: 1, passed: 1, failed: 0 });
  });

  it("an UNREACHABLE product (base url unresolved) → inconclusive, never a fabricated pass (fails loud)", async () => {
    const events = new RecordingEventStore();
    // The driver's resolver goes unresolved → the surface is unavailable → inconclusive.
    const orchestrator = new AcceptanceOrchestrator({
      store: new EphemeralAcceptanceRunStore(),
      events: new EphemeralAcceptanceEventSink(),
      drivers: [
        new HttpAcceptanceSurfaceDriver({
          resolveBaseUrl: resolver({ kind: "unresolved", reason: "no deploy" }),
          fetchImpl: scriptedFetch({ ok: true }),
        }),
      ],
    });
    const demo = new ProofBackedWebDemo({ events, planLoader: planLoader([healthPlan()]), orchestrator });

    await expect(demo.demo(TARGET, release([BR]))).rejects.toBeInstanceOf(ProofBackedDemoUnobservableError);
    // No demo.completed — an unobservable demo is a loud failure, not a silent green.
    expect(events.appends.find((a) => a.eventType === "demo.completed")).toBeUndefined();
  });

  it("a release delivering NO declared behaviors → fails loud (nothing to prove)", async () => {
    const events = new RecordingEventStore();
    const demo = buildDemo(events, [], scriptedFetch({ ok: true }));
    await expect(demo.demo(TARGET, release([]))).rejects.toBeInstanceOf(ProofBackedDemoNoBehaviorsError);
    expect(events.appends).toEqual([]);
  });

  it("never leaks a secret-looking value into the recorded evidence", async () => {
    const events = new RecordingEventStore();
    const demo = buildDemo(events, [healthPlan()], scriptedFetch({ ok: true }));
    await demo.demo(TARGET, release([BR]));
    expect(JSON.stringify(events.appends)).not.toMatch(/token|secret|bearer/iu);
  });
});
