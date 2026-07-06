// Plane-split: behavior tests for the control-plane `/internal/claim-job`
// endpoint + the claim clients that reach it. No mock-only assertions — every
// test drives the REAL endpoint handler and asserts an observable outcome:
//
//   1. authn REJECTS a caller that did not present a trusted mTLS peer (401),
//      and does so BEFORE any claim runs (the fake queue is never touched);
//   2. a trusted peer claims a job and the endpoint returns it WITH its org_id
//      (the R3b queue threading survives the transport hop);
//   3. claim-ONCE under contention: two concurrent callers against ONE queued
//      job get one job + one empty — never the same job twice (exactly-once);
//   4. the `HttpJobClaimClient` round-trips a claim through a fake `MtlsFetch`
//      that routes straight into the real endpoint app, and surfaces a non-mTLS
//      401 as a `JobClaimTransportError` (the worker treats it as infra, never a
//      silent double-execute);
//   5. the `DirectJobClaimClient` delegates to `JobQueue.claim` unchanged.

import { describe, expect, it } from "vitest";
import {
  DirectJobClaimClient,
  FakeJobQueue,
  HttpJobClaimClient,
  JobClaimTransportError,
} from "../src/engine/contracts/index.js";
import { AllowAllPeerVerifier, DenyAllPeerVerifier } from "../src/engine/contracts/index.js";
import type { MtlsFetch } from "../src/engine/contracts/index.js";
import { createInternalClaimRoutes } from "../src/routes/internal/claimJob.js";

const FAKE_POOL = {} as never;

function trustedRequest(app: ReturnType<typeof createInternalClaimRoutes>, body: unknown): Promise<Response> {
  return app.request(
    "/internal/claim-job",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    // The 3rd arg becomes `c.env`. A real mTLS deployment exposes the validated
    // peer cert on `incoming.socket`; here AllowAllPeerVerifier trusts any.
    { incoming: { socket: {} } },
  );
}

describe("plane-split P2 — internal claim endpoint", () => {
  it("rejects an untrusted (non-mTLS) caller with 401 before claiming", async () => {
    const queue = new FakeJobQueue();
    await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: {}, orgId: "org_a" });
    const app = createInternalClaimRoutes({ pool: FAKE_POOL, jobQueue: queue, verifier: new DenyAllPeerVerifier() });

    const response = await trustedRequest(app, { taskKind: "plan" });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "untrusted_peer" });
    // The job was NEVER claimed — authn ran before any claim.
    await expect(queue.claim("plan")).resolves.toMatchObject({ runId: "run_1" });
  });

  it("claims a job for a trusted peer and returns it with its org_id", async () => {
    const queue = new FakeJobQueue();
    await queue.enqueue({ runId: "run_1", taskId: "task_1", taskKind: "plan", payload: { ok: true }, orgId: "org_a" });
    const app = createInternalClaimRoutes({ pool: FAKE_POOL, jobQueue: queue, verifier: new AllowAllPeerVerifier() });

    const response = await trustedRequest(app, { taskKind: "plan" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { job: { runId: string; orgId: string; attempts: number } | null };
    expect(body.job).toMatchObject({ runId: "run_1", taskId: "task_1", orgId: "org_a", attempts: 1 });
  });

  it("returns { job: null } when the queue is empty", async () => {
    const app = createInternalClaimRoutes({
      pool: FAKE_POOL,
      jobQueue: new FakeJobQueue(),
      verifier: new AllowAllPeerVerifier(),
    });
    const response = await trustedRequest(app, { taskKind: "plan" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ job: null });
  });

  it("claims ONCE under contention: two concurrent callers, one job each, no dup", async () => {
    const queue = new FakeJobQueue();
    await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: {}, orgId: "org_a" });
    const app = createInternalClaimRoutes({ pool: FAKE_POOL, jobQueue: queue, verifier: new AllowAllPeerVerifier() });

    const [a, b] = await Promise.all([
      trustedRequest(app, { taskKind: "plan" }),
      trustedRequest(app, { taskKind: "plan" }),
    ]);
    const jobs = [
      ((await a.json()) as { job: { runId: string } | null }).job,
      ((await b.json()) as { job: { runId: string } | null }).job,
    ];

    const claimed = jobs.filter((job) => job !== null);
    const empty = jobs.filter((job) => job === null);
    expect(claimed).toHaveLength(1);
    expect(empty).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ runId: "run_1" });
  });

  it("rejects a malformed claim request with 400", async () => {
    const app = createInternalClaimRoutes({
      pool: FAKE_POOL,
      jobQueue: new FakeJobQueue(),
      verifier: new AllowAllPeerVerifier(),
    });
    const response = await trustedRequest(app, { taskKind: "" });
    expect(response.status).toBe(400);
  });
});

// Route a fake MtlsFetch straight into the real endpoint app: this is the
// worker→control-plane round trip with the network swapped for an in-process
// call, so the claim logic + wire shape are proven without standing up TLS.
function fetchInto(app: ReturnType<typeof createInternalClaimRoutes>): MtlsFetch {
  return (url, init) => app.request(new URL(url).pathname, init as RequestInit, { incoming: { socket: {} } });
}

describe("plane-split P2 — claim clients", () => {
  it("HttpJobClaimClient round-trips a claim through the mTLS channel", async () => {
    const queue = new FakeJobQueue();
    await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: {}, orgId: "org_a" });
    const app = createInternalClaimRoutes({ pool: FAKE_POOL, jobQueue: queue, verifier: new AllowAllPeerVerifier() });
    const client = new HttpJobClaimClient("https://control-plane.internal:3110", fetchInto(app));

    const job = await client.claimJob({ taskKind: "plan", leaseMs: 1_000 });
    expect(job).toMatchObject({ runId: "run_1", orgId: "org_a" });
    // The job is gone — a second claim is empty (exactly-once across the hop).
    await expect(client.claimJob({ taskKind: "plan" })).resolves.toBeUndefined();
  });

  it("HttpJobClaimClient surfaces a non-mTLS 401 as a transport error", async () => {
    const app = createInternalClaimRoutes({
      pool: FAKE_POOL,
      jobQueue: new FakeJobQueue(),
      verifier: new DenyAllPeerVerifier(),
    });
    const client = new HttpJobClaimClient("https://control-plane.internal:3110", fetchInto(app));
    await expect(client.claimJob({ taskKind: "plan" })).rejects.toBeInstanceOf(JobClaimTransportError);
  });

  it("DirectJobClaimClient delegates to JobQueue.claim unchanged", async () => {
    const queue = new FakeJobQueue();
    await queue.enqueue({ runId: "run_1", taskKind: "plan", payload: {}, orgId: "org_a" });
    const client = new DirectJobClaimClient(queue);

    await expect(client.claimJob({ taskKind: "plan", runId: "run_1", leaseMs: 500 })).resolves.toMatchObject({
      runId: "run_1",
      attempts: 1,
    });
    await expect(client.claimJob({ taskKind: "plan" })).resolves.toBeUndefined();
  });
});

// Audit C2 §8: parse-on-receive at the HTTP boundary. Assert a malformed 2xx
// body from the control plane surfaces as `JobClaimTransportError` (kind:
// "schema_drift") rather than silently returning "no work" (undefined) — which
// was the pre-fix behavior when `parsed.job` was undefined on schema drift and
// idled every worker.
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const invalidJsonFetch: MtlsFetch = async () =>
  new Response("not json at all", { status: 200, headers: { "content-type": "application/json" } });

describe("HttpJobClaimClient — audit C2 §8 parse-on-receive", () => {
  it("throws JobClaimTransportError on a malformed 2xx body (missing job field)", async () => {
    const fetchImpl: MtlsFetch = async () => jsonResponse({ notAJobField: true });
    const client = new HttpJobClaimClient("https://control-plane.internal:3110", fetchImpl);

    let caught: unknown;
    try {
      await client.claimJob({ taskKind: "plan" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JobClaimTransportError);
    expect((caught as JobClaimTransportError).kind).toBe("schema_drift");
    expect((caught as JobClaimTransportError).issues?.length ?? 0).toBeGreaterThan(0);
    // Redacted preview shows the offending key WITHOUT its value (no leak).
    expect((caught as JobClaimTransportError).payloadPreview).toContain("notAJobField");
    expect((caught as JobClaimTransportError).payloadPreview).not.toContain("true");
  });

  it("throws JobClaimTransportError on a wrong-shape job (missing required fields)", async () => {
    // `job` is present, but the envelope is missing required fields like id
    // and taskKind — the old unchecked cast would let `job.id` be undefined,
    // silently propagating a broken envelope into the worker.
    const fetchImpl: MtlsFetch = async () => jsonResponse({ job: { runId: "run_x" } });
    const client = new HttpJobClaimClient("https://control-plane.internal:3110", fetchImpl);

    await expect(client.claimJob({ taskKind: "plan" })).rejects.toBeInstanceOf(JobClaimTransportError);
  });

  it("throws JobClaimTransportError.invalidJson on a body that fails JSON parse", async () => {
    const client = new HttpJobClaimClient("https://control-plane.internal:3110", invalidJsonFetch);

    let caught: unknown;
    try {
      await client.claimJob({ taskKind: "plan" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JobClaimTransportError);
    expect((caught as JobClaimTransportError).kind).toBe("schema_drift");
  });

  it("parses a well-formed { job: null } as an empty queue (undefined)", async () => {
    const fetchImpl: MtlsFetch = async () => jsonResponse({ job: null });
    const client = new HttpJobClaimClient("https://control-plane.internal:3110", fetchImpl);
    await expect(client.claimJob({ taskKind: "plan" })).resolves.toBeUndefined();
  });

  it("parses a well-formed envelope reply and returns it unchanged", async () => {
    const envelope = {
      id: "job_1",
      runId: "run_1",
      taskId: "task_1",
      taskKind: "plan",
      payload: { arbitrary: "opaque" },
      attempts: 1,
      orgId: "org_a",
    };
    const fetchImpl: MtlsFetch = async () => jsonResponse({ job: envelope });
    const client = new HttpJobClaimClient("https://control-plane.internal:3110", fetchImpl);
    const job = await client.claimJob({ taskKind: "plan" });
    expect(job).toMatchObject(envelope);
  });

  it("http_error variant carries the status + body for non-2xx replies", () => {
    const err = JobClaimTransportError.httpError(502, "bad gateway");
    expect(err).toBeInstanceOf(JobClaimTransportError);
    expect(err.kind).toBe("http_error");
    expect(err.status).toBe(502);
    expect(err.body).toBe("bad gateway");
    expect(err.issues).toBeUndefined();
  });
});
