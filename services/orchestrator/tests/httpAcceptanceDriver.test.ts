// rv-6 A2 DECISIVE real-observation proof. It drives the REAL AcceptanceOrchestrator
// through the REAL HttpAcceptanceSurfaceDriver against a REAL node:http server over
// the platform `fetch`. It proves the trichotomy that closes every false-green hole:
//   - a correct response ⇒ passed (a REAL matching observation),
//   - a wrong response (500) ⇒ failed_product (the real status fails the assertion),
//   - an unreachable surface ⇒ inconclusive_infrastructure (NEVER passed, no fabricated
//     observation).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Digest } from "../src/engine/contracts/cas.js";
import { assertVerdictAssertionCoverage } from "../src/engine/contracts/runtimeVerificationInvariants.js";
import type { ExecutionMatrix } from "../src/engine/contracts/runtimeVerificationPlan.js";
import type { AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import {
  AcceptanceOrchestrator,
  HttpAcceptanceSurfaceDriver,
  recordAttemptedVerdictSequential,
  type AcceptanceBaseUrlResolver,
  type AcceptanceDriveInput,
  type AcceptanceEventSink,
  type AcceptancePlan,
  type AcceptanceRunStore,
  type CompleteAcceptanceRunInput,
  type EnsureVerificationPlanInput,
  type RecordAcceptanceRunInput,
  type RecordAttemptInput,
  type RecordAcceptanceVerdictInput,
  type RecordAttemptedVerdictInput,
  type RecordAttemptedVerdictResult,
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
    // The SAME coverage guard the Pg store enforces: a fake pass cannot be stored.
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
  public append<N extends EventName>(_input: AppendEventInput<N>): Promise<void> {
    return Promise.resolve();
  }
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

function plan(path: string, assertions: AcceptancePlan["assertions"]): AcceptancePlan {
  return {
    planId: "plan_http_rv6",
    behaviorRevisionId: "br_http_rv6",
    requiredSurfaces: ["api"],
    assertions,
    fixtures: [],
    examples: [],
    executionMatrix: MATRIX,
    httpProbes: [{ probeId: "p1", method: "GET", path }],
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

async function runWith(baseUrl: string, p: AcceptancePlan) {
  const store = new InMemoryAcceptanceRunStore();
  const orchestrator = new AcceptanceOrchestrator({
    store,
    events: new RecordingEventSink(),
    drivers: [new HttpAcceptanceSurfaceDriver({ surface: "api", resolveBaseUrl: fixedResolver(baseUrl) })],
  });
  const result = await orchestrator.execute(request([p]));
  return { store, behavior: result.behaviors[0]! };
}

describe("HttpAcceptanceSurfaceDriver — real HTTP observations, no fabrication", () => {
  let server: Server;
  let baseUrl: string;
  let deadUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", count: 3 }));
        return;
      }
      if (req.url === "/broken") {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      if (req.url === "/null_field") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ value: null }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Reserve then release a port so it is genuinely closed (connection refused).
    const dead = createServer();
    await new Promise<void>((resolve) => {
      dead.listen(0, "127.0.0.1", () => resolve());
    });
    deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => {
      dead.close(() => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("DECISIVE: a correct real response yields passed on real observed values", async () => {
    const { behavior } = await runWith(
      baseUrl,
      plan("/health", [
        { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
        { assertionId: "a2", subject: "p1.body.count", comparisonOperator: "greater_than", expected: 1 },
        { assertionId: "a3", subject: "p1.body.status", comparisonOperator: "equals", expected: "ok" },
      ]),
    );
    expect(behavior.outcome).toBe("passed");
    expect(behavior.executedAssertionCount).toBe(3);
    expect(behavior.passedAssertionCount).toBe(3);
  });

  it("DECISIVE: a wrong response (500) fails the status assertion — failed_product, never passed", async () => {
    const { behavior } = await runWith(
      baseUrl,
      plan("/broken", [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }]),
    );
    expect(behavior.outcome).toBe("failed_product");
    expect(behavior.executedAssertionCount).toBe(1);
    expect(behavior.passedAssertionCount).toBe(0);
  });

  it("DECISIVE: a genuinely-absent body field is NOT observed — the assertion does not execute, never passes", async () => {
    const { behavior } = await runWith(
      baseUrl,
      plan("/health", [
        { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
        { assertionId: "a2", subject: "p1.body.missing", comparisonOperator: "equals", expected: "present" },
      ]),
    );
    // The absent field is unobservable ⇒ a2 does not execute ⇒ executed(1) <
    // required(2) ⇒ failed_verification_contract. It is NEVER a fabricated-null
    // observation and NEVER a pass.
    expect(behavior.outcome).not.toBe("passed");
    expect(behavior.outcome).toBe("failed_verification_contract");
    expect(behavior.executedAssertionCount).toBe(1);
    expect(behavior.passedAssertionCount).toBe(1);
  });

  it("DECISIVE: a bogus/unknown selector is NOT observed — never a fabricated-null match, never passed", async () => {
    const { behavior } = await runWith(
      baseUrl,
      // `p1.totally_bogus equals null` must NOT pass on a fabricated null; the
      // selector is unobservable ⇒ the assertion does not execute ⇒ not passed.
      plan("/health", [
        { assertionId: "a1", subject: "p1.totally_bogus", comparisonOperator: "equals", expected: null },
      ]),
    );
    expect(behavior.outcome).not.toBe("passed");
    expect(behavior.outcome).toBe("failed_verification_contract");
    expect(behavior.executedAssertionCount).toBe(0);
  });

  it("DECISIVE: not_equals / not_contains on a genuinely-absent field never pass (absent ≠ observed)", async () => {
    const notEquals = await runWith(
      baseUrl,
      plan("/health", [
        { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
        { assertionId: "a2", subject: "p1.body.missing", comparisonOperator: "not_equals", expected: "x" },
      ]),
    );
    // The absent field is NOT observed, so a2 never executes — the run cannot pass.
    expect(notEquals.behavior.outcome).not.toBe("passed");
    expect(notEquals.behavior.outcome).toBe("failed_verification_contract");
    expect(notEquals.behavior.executedAssertionCount).toBe(1);

    const notContains = await runWith(
      baseUrl,
      plan("/health", [
        { assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 },
        { assertionId: "a2", subject: "p1.body.missing", comparisonOperator: "not_contains", expected: "secret" },
      ]),
    );
    expect(notContains.behavior.outcome).not.toBe("passed");
    expect(notContains.behavior.executedAssertionCount).toBe(1);
  });

  it("REGRESSION: a genuinely-present JSON null IS observed and satisfies equals null", async () => {
    const { behavior } = await runWith(
      baseUrl,
      plan("/null_field", [
        { assertionId: "a1", subject: "p1.body.value", comparisonOperator: "equals", expected: null },
      ]),
    );
    expect(behavior.outcome).toBe("passed");
    expect(behavior.executedAssertionCount).toBe(1);
    expect(behavior.passedAssertionCount).toBe(1);
  });

  it("DECISIVE: an unreachable surface is inconclusive_infrastructure — never passed, never fabricated", async () => {
    const { behavior, store } = await runWith(
      deadUrl,
      plan("/health", [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }]),
    );
    expect(behavior.outcome).toBe("inconclusive_infrastructure");
    expect(behavior.executedAssertionCount).toBe(0);
    expect(store.verdicts[0]?.outcome).toBe("inconclusive_infrastructure");
  });

  it("an unresolved base URL (no deploy) is inconclusive_infrastructure, not a pass", async () => {
    const store = new InMemoryAcceptanceRunStore();
    const orchestrator = new AcceptanceOrchestrator({
      store,
      events: new RecordingEventSink(),
      drivers: [
        new HttpAcceptanceSurfaceDriver({
          surface: "api",
          resolveBaseUrl: { resolve: () => Promise.resolve({ kind: "unresolved", reason: "no deploy" }) },
        }),
      ],
    });
    const result = await orchestrator.execute(
      request([
        plan("/health", [{ assertionId: "a1", subject: "p1.status", comparisonOperator: "equals", expected: 200 }]),
      ]),
    );
    expect(result.behaviors[0]?.outcome).toBe("inconclusive_infrastructure");
  });
});
