import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  AllowAllPeerVerifier,
  DenyAllPeerVerifier,
  type MtlsFetch,
  type RecoveryPreparationInput,
  type RecoveryPreparationOutcome,
} from "../src/engine/contracts/index.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { HttpRunStateWriter } from "../src/engine/worker/httpRunStateWriter.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";

const INPUT: RecoveryPreparationInput = {
  orgId: "org_prepare",
  projectId: "project_prepare",
  specId: "spec_prepare",
  oldRunId: "run_old",
  queueId: "queue_old",
  steeringNote: "re-plan on the exact new base",
  reopenStatus: "open",
  route: {
    kind: "planner_replan",
    newContext: "upstream changed",
    otherSpecId: "spec_upstream",
    conflictSignature: "signature_exact",
  },
};

const OWNED: RecoveryPreparationOutcome = {
  kind: "owned",
  receipt: {
    kind: "planner_replan",
    specId: INPUT.specId,
    run: { kind: "enqueued", replanRunId: "run_successor", plannerTaskId: "task_successor" },
  },
  newlyPrepared: false,
};

const THROWING_POOL = {
  connect: async () => {
    throw new Error("injected database outage");
  },
} as unknown as pg.Pool;

function post(
  app: ReturnType<typeof createInternalRunStateWriteRoutes>,
  path: "/internal/prepare-recovery" | "/internal/read-recovery-preparation",
  body: unknown,
): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { incoming: { socket: {} } },
  );
}

describe("internal recovery-preparation endpoints", () => {
  it("authenticates and validates before database access", async () => {
    const denied = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new DenyAllPeerVerifier() });
    expect((await post(denied, "/internal/prepare-recovery", { malformed: true })).status).toBe(401);

    const allowed = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new AllowAllPeerVerifier() });
    const malformed = await post(allowed, "/internal/read-recovery-preparation", { ...INPUT, steeringNote: "" });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error).toBe("invalid_recovery_preparation");
  });

  it("maps a transaction failure to an explicit non-authoritative outcome", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new AllowAllPeerVerifier() });
    const response = await post(app, "/internal/prepare-recovery", INPUT);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "failure", reason: "write_failed" });
  });
});

describe("HttpRunStateWriter recovery-preparation readback", () => {
  it("returns a strict authoritative response without a second request", async () => {
    const fetch = vi.fn<MtlsFetch>(() => Promise.resolve(Response.json({ ...OWNED, newlyPrepared: true })));
    await expect(new HttpRunStateWriter("https://control.internal", fetch).prepareRecovery(INPUT)).resolves.toEqual({
      ...OWNED,
      newlyPrepared: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["thrown response loss", "malformed 2xx"])("uses exact durable readback after %s", async (failure) => {
    const fetch = vi.fn<MtlsFetch>(async (url) => {
      if (new URL(url).pathname === "/internal/prepare-recovery") {
        if (failure === "thrown response loss") throw new Error("response lost after commit");
        return Response.json({ kind: "owned", newlyPrepared: "yes" });
      }
      return Response.json(OWNED);
    });
    await expect(new HttpRunStateWriter("https://control.internal/", fetch).prepareRecovery(INPUT)).resolves.toEqual(
      OWNED,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/internal/prepare-recovery",
      "/internal/read-recovery-preparation",
    ]);
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([INPUT, INPUT]);
  });

  it("never fabricates ownership when exact readback is unavailable", async () => {
    const fetch = vi.fn<MtlsFetch>(() => Promise.reject(new Error("control plane unavailable")));
    await expect(
      new HttpRunStateWriter("https://control.internal", fetch).prepareRecovery(INPUT),
    ).resolves.toMatchObject({ kind: "failure", reason: "transport_failed" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed input before either Direct DB or HTTP transport", async () => {
    const fetch = vi.fn<MtlsFetch>();
    const malformed = { ...INPUT, steeringNote: "" };
    const expected = { kind: "failure", reason: "invalid_input", message: "invalid recovery preparation" };
    await expect(new DirectRunStateWriter(THROWING_POOL).prepareRecovery(malformed)).resolves.toEqual(expected);
    await expect(new HttpRunStateWriter("https://control.internal", fetch).prepareRecovery(malformed)).resolves.toEqual(
      expected,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
