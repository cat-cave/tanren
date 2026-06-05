// Plane-split P3 — unit-level behavior of the run-state write endpoints + the
// HttpRunStateWriter that need NO database:
//
//   1. authn REJECTS an untrusted (non-mTLS) peer with 401 BEFORE any DB work —
//      proven without a real pool (a sentinel pool that throws if touched);
//   2. a malformed request is 400 (again before any DB work);
//   3. the HttpRunStateWriter surfaces a non-2xx (e.g. the 401 above) as a
//      RunStateWriteTransportError — the worker treats it as infra, so a failed
//      write is NEVER mistaken for a landed one (no phantom finalize/event).
//
// The persist-the-right-rows + exactly-once proofs are the DB-backed
// planeSplitP3RemoteWrites.integration.test.ts.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import { runWithJobOrgId } from "@tanren/db";
import { AllowAllPeerVerifier, DenyAllPeerVerifier, type MtlsFetch } from "../src/engine/contracts/index.js";
import { HttpRunStateWriter, RunStateWriteTransportError } from "../src/engine/worker/index.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";
import { SpecDependenciesBlockedError, SpecNotRunnableError } from "../src/engine/workflow/projectSpecErrors.js";

// A pool that throws if any query runs — so a test that reaches the DB fails
// loudly. The authn-reject + bad-request paths must return BEFORE touching it.
const THROWING_POOL = {
  connect() {
    throw new Error("DB must not be touched on the reject path");
  },
  query() {
    throw new Error("DB must not be touched on the reject path");
  },
} as never;

function post(
  app: ReturnType<typeof createInternalRunStateWriteRoutes>,
  path: string,
  body: unknown,
): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { incoming: { socket: {} } },
  );
}

describe("plane-split P3 — write endpoint authn + validation (no DB)", () => {
  it("rejects an untrusted peer with 401 before any DB work, on every write endpoint", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new DenyAllPeerVerifier() });
    for (const path of [
      "/internal/append-event",
      "/internal/record-cost",
      "/internal/finalize-run",
      // Plane-split P3c lifecycle endpoints — same authn-before-DB contract.
      "/internal/set-run-status",
      "/internal/set-run-pr-url",
      "/internal/set-spec-status",
      "/internal/reconcile-stranded-spec",
      "/internal/supersede-queued-planner-task",
      "/internal/insert-task",
      "/internal/update-task",
    ]) {
      const response = await post(app, path, { anything: true });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "untrusted_peer" });
    }
  });

  it("rejects a malformed finalize-run request with 400 before any DB work", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new AllowAllPeerVerifier() });
    // Missing orgId/status/outcome/fromStatuses → schema rejects pre-DB.
    const response = await post(app, "/internal/finalize-run", { runId: "run_1" });
    expect(response.status).toBe(400);
  });

  it("rejects a malformed P3c lifecycle request with 400 before any DB work", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new AllowAllPeerVerifier() });
    // Missing status/setStartedAt etc. → schema rejects pre-DB (THROWING_POOL untouched).
    const response = await post(app, "/internal/set-run-status", { runId: "run_1" });
    expect(response.status).toBe(400);
  });
});

// A fake mTLS channel that always 401s (an untrusted peer / mesh outage). The
// writer must surface it, NOT swallow it — a failed write is infra, not a silent
// success.
const denying: MtlsFetch = () => Promise.resolve(new Response('{"error":"untrusted_peer"}', { status: 401 }));

describe("plane-split P3 — HttpRunStateWriter transport faults", () => {
  it("surfaces a non-2xx finalize as a RunStateWriteTransportError", async () => {
    const writer = new HttpRunStateWriter("https://control.internal:3110", denying);
    await expect(
      writer.finalizeRun({
        runId: "run_1",
        orgId: "org_a",
        status: "halted",
        outcome: "halted",
        fromStatuses: ["running"],
      }),
    ).rejects.toBeInstanceOf(RunStateWriteTransportError);
  });

  it("surfaces a non-2xx append as a RunStateWriteTransportError", async () => {
    const writer = new HttpRunStateWriter("https://control.internal:3110", denying);
    // append reads the run's org from the per-job org-id scope before posting.
    await expect(
      runWithJobOrgId("org_a", () =>
        writer.append({
          runId: "run_1",
          specId: "s",
          projectId: "p",
          eventType: "run.started",
          payload: { status: "running" },
        }),
      ),
    ).rejects.toBeInstanceOf(RunStateWriteTransportError);
  });

  it("append throws loudly (not a phantom success) when no per-job org-id is in scope", async () => {
    // A remote write outside runWithJobOrgId is a wiring bug: it must throw rather
    // than post an unscoped write the server would deny under enforced RLS.
    const writer = new HttpRunStateWriter("https://control.internal:3110", denying);
    await expect(
      writer.append({
        runId: "run_1",
        specId: "s",
        projectId: "p",
        eventType: "run.started",
        payload: { status: "running" },
      }),
    ).rejects.toThrow(/per-job org-id/u);
  });
});

// A fake org-scoped pool whose client passes the tx-control statements through
// (BEGIN / SET LOCAL / COMMIT / ROLLBACK) and throws the supplied error on the
// FIRST real query — i.e. on `createQueuedRunFromSpec`'s spec-load SELECT. This
// drives the create-queued-run handler's catch deterministically without a real
// DB (the mapping under test is the try/catch, not the multi-table write itself).
function poolThatThrowsOn(error: Error): pg.Pool {
  const client = {
    // eslint-disable-next-line @typescript-eslint/require-await
    query: async (sql: string) => {
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL|SELECT set_config)/u.test(sql.trim())) {
        return { rows: [], rowCount: 0 };
      }
      throw error;
    },
    release: () => {},
  };
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    connect: async () => client,
    query: client.query,
  } as unknown as pg.Pool;
}

const CREATE_RUN_BODY = {
  input: { specId: "spec_x", trigger: "dag_walker" },
  actor: {
    userId: "dag-walker",
    orgId: "org_a",
    projectId: "proj_a",
    scopes: ["platform:admin"],
    source: "local_dev",
  },
};

describe("plane-split (autonomy loops) — create-queued-run maps benign per-spec errors to a typed 409", () => {
  it("returns 409 { error: spec_not_runnable, specId, status } when the claim races a concurrent tick", async () => {
    const app = createInternalRunStateWriteRoutes({
      pool: poolThatThrowsOn(new SpecNotRunnableError("spec_x", "in_flight")),
      verifier: new AllowAllPeerVerifier(),
    });
    const response = await post(app, "/internal/create-queued-run", CREATE_RUN_BODY);
    // The benign concurrent-tick race is a TYPED 409, NOT a scary 500.
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "spec_not_runnable", specId: "spec_x", status: "in_flight" });
  });

  it("returns 409 { error: spec_dependencies_blocked, specId, blockedBy } when deps are not yet done", async () => {
    const app = createInternalRunStateWriteRoutes({
      pool: poolThatThrowsOn(new SpecDependenciesBlockedError("spec_x", ["spec_y"])),
      verifier: new AllowAllPeerVerifier(),
    });
    const response = await post(app, "/internal/create-queued-run", CREATE_RUN_BODY);
    // The benign deps-not-yet-done condition is a TYPED 409 (a later tick enqueues
    // it once the dependency lands as done), NOT a scary 500 that would abort the
    // walker's whole tick and starve the OTHER ready specs.
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "spec_dependencies_blocked",
      specId: "spec_x",
      blockedBy: ["spec_y"],
    });
  });

  it("still returns 500 for a genuine (non-benign) error — no silent swallow", async () => {
    const app = createInternalRunStateWriteRoutes({
      pool: poolThatThrowsOn(new Error("connection reset by peer")),
      verifier: new AllowAllPeerVerifier(),
    });
    const response = await post(app, "/internal/create-queued-run", CREATE_RUN_BODY);
    expect(response.status).toBe(500);
  });
});

// §2c contract parity: the route schema's `speculative.speculativeBase` must accept
// `string | null` to byte-match the in-process `CreateSpecRunInput` (a percolation
// re-exec whose every ancestor has merged has a NULL base — a real run against main —
// yet still carries the percolation marker). Before the fix the schema was
// `z.string().min(1)`, which 400'd the present-but-null base so the worker could never
// create the §2c non-speculative re-exec at all. These cases need NO DB: validation
// passing reaches the spec-load SELECT (the throwing pool → 500/409), and validation
// failing returns 400 BEFORE any DB work.
describe("plane-split (autonomy loops) — create-queued-run accepts a present-but-null speculative base (§2c)", () => {
  it("PASSES validation for speculative: { speculativeBase: null } — reaches the DB (not a 400)", async () => {
    const app = createInternalRunStateWriteRoutes({
      // The body is well-formed, so the handler proceeds to the spec-load SELECT, which
      // this pool throws on → 500. The point: it is NOT a 400 — the null base validated.
      pool: poolThatThrowsOn(new Error("reached the DB — validation passed")),
      verifier: new AllowAllPeerVerifier(),
    });
    const response = await post(app, "/internal/create-queued-run", {
      input: {
        specId: "spec_x",
        trigger: "percolation_reexec",
        speculative: { speculativeBase: null, percolationPending: { reexecOf: "spec_anc" } },
      },
      actor: CREATE_RUN_BODY.actor,
    });
    expect(response.status).toBe(500);
    expect(response.status).not.toBe(400);
  });

  it("PASSES validation for a non-null speculative base too — the field stays nullable, not loosened to any", async () => {
    const app = createInternalRunStateWriteRoutes({
      pool: poolThatThrowsOn(new Error("reached the DB — validation passed")),
      verifier: new AllowAllPeerVerifier(),
    });
    const response = await post(app, "/internal/create-queued-run", {
      input: { specId: "spec_x", trigger: "dag_walker", speculative: { speculativeBase: "tanren/integ/x" } },
      actor: CREATE_RUN_BODY.actor,
    });
    expect(response.status).toBe(500);
  });

  it("STILL rejects a genuinely-invalid speculative base (a number) with 400 before any DB work", async () => {
    const app = createInternalRunStateWriteRoutes({
      // THROWING_POOL throws if touched — proving the 400 is returned pre-DB.
      pool: THROWING_POOL,
      verifier: new AllowAllPeerVerifier(),
    });
    const response = await post(app, "/internal/create-queued-run", {
      input: { specId: "spec_x", trigger: "dag_walker", speculative: { speculativeBase: 123 } },
      actor: CREATE_RUN_BODY.actor,
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_create_queued_run");
  });

  it("STILL rejects an empty-string speculative base with 400 — only null is added, the .min(1) string floor holds", async () => {
    const app = createInternalRunStateWriteRoutes({
      pool: THROWING_POOL,
      verifier: new AllowAllPeerVerifier(),
    });
    const response = await post(app, "/internal/create-queued-run", {
      input: { specId: "spec_x", trigger: "dag_walker", speculative: { speculativeBase: "" } },
      actor: CREATE_RUN_BODY.actor,
    });
    expect(response.status).toBe(400);
  });
});

// A fake mTLS channel that replies with a fixed status + body — to drive the
// HttpRunStateWriter's per-endpoint error mapping.
function replyWith(status: number, body: string): MtlsFetch {
  return () => Promise.resolve(new Response(body, { status }));
}

describe("plane-split (autonomy loops) — HttpRunStateWriter.createQueuedRun reconstructs the typed error", () => {
  const baseInput = {
    input: { specId: "spec_x", trigger: "dag_walker" },
    actor: {
      userId: "dag-walker",
      orgId: "org_a",
      projectId: "proj_a",
      scopes: ["platform:admin"] as const,
      source: "local_dev" as const,
    },
  };

  it("throws a reconstructed SpecNotRunnableError (instanceof) on a 409 spec_not_runnable response", async () => {
    const writer = new HttpRunStateWriter(
      "https://control.internal:3110",
      replyWith(409, JSON.stringify({ error: "spec_not_runnable", specId: "spec_x", status: "in_flight" })),
    );
    const promise = writer.createQueuedRun(baseInput);
    // The typed error crosses the wire INTACT — so the walker's in-process
    // concurrent-tick tolerance applies identically to the control-plane path.
    await expect(promise).rejects.toBeInstanceOf(SpecNotRunnableError);
    await expect(promise).rejects.toMatchObject({ specId: "spec_x", status: "in_flight" });
    // It is NOT a generic transport error.
    await expect(promise).rejects.not.toBeInstanceOf(RunStateWriteTransportError);
  });

  it("throws a reconstructed SpecDependenciesBlockedError (instanceof) on a 409 spec_dependencies_blocked response", async () => {
    const writer = new HttpRunStateWriter(
      "https://control.internal:3110",
      replyWith(409, JSON.stringify({ error: "spec_dependencies_blocked", specId: "spec_x", blockedBy: ["spec_y"] })),
    );
    const promise = writer.createQueuedRun(baseInput);
    // The typed error crosses the wire INTACT — so the walker's benign deps-not-yet-done
    // skip applies identically to the control-plane path.
    await expect(promise).rejects.toBeInstanceOf(SpecDependenciesBlockedError);
    await expect(promise).rejects.toMatchObject({ specId: "spec_x", blockedSpecIds: ["spec_y"] });
    // It is NOT a generic transport error.
    await expect(promise).rejects.not.toBeInstanceOf(RunStateWriteTransportError);
  });

  it("throws a RunStateWriteTransportError on any OTHER non-2xx (a genuine fault still surfaces loudly)", async () => {
    const writer = new HttpRunStateWriter("https://control.internal:3110", replyWith(500, "boom"));
    await expect(writer.createQueuedRun(baseInput)).rejects.toBeInstanceOf(RunStateWriteTransportError);
  });

  it("throws a RunStateWriteTransportError on a 409 matching NEITHER typed shape (no over-broad mapping)", async () => {
    const writer = new HttpRunStateWriter(
      "https://control.internal:3110",
      // An unknown 409 error code — NOT one of the two tolerated typed shapes.
      replyWith(409, JSON.stringify({ error: "something_unexpected", specId: "spec_x" })),
    );
    await expect(writer.createQueuedRun(baseInput)).rejects.toBeInstanceOf(RunStateWriteTransportError);
  });

  it("throws a RunStateWriteTransportError on a 409 spec_dependencies_blocked MISSING blockedBy (malformed → not mapped)", async () => {
    const writer = new HttpRunStateWriter(
      "https://control.internal:3110",
      // The spec_dependencies_blocked code but no `blockedBy` array — a malformed
      // body must NOT be reconstructed (it would lose the blocked list); it falls
      // back to the generic transport error so a genuine fault is never masked.
      replyWith(409, JSON.stringify({ error: "spec_dependencies_blocked", specId: "spec_x" })),
    );
    await expect(writer.createQueuedRun(baseInput)).rejects.toBeInstanceOf(RunStateWriteTransportError);
  });
});
