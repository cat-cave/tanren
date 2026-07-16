import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  AllowAllPeerVerifier,
  DenyAllPeerVerifier,
  type MtlsFetch,
  type RecoveryOwnedSettleInput,
} from "../src/engine/contracts/index.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { HttpRunStateWriter } from "../src/engine/worker/httpRunStateWriter.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";

const INPUT: RecoveryOwnedSettleInput = {
  orgId: "org_owned",
  projectId: "project_owned",
  queueId: "queue_old",
  runId: "run_old",
  specId: "spec_owned",
  receipt: {
    kind: "planner_replan",
    specId: "spec_owned",
    run: { kind: "enqueued", replanRunId: "run_new", plannerTaskId: "task_plan_new" },
  },
  reason: "conflict",
  message: "exact successor owns recovery",
};

const THROWING_POOL = {
  connect: async () => {
    throw new Error("injected database outage");
  },
} as unknown as pg.Pool;

function postOwned(app: ReturnType<typeof createInternalRunStateWriteRoutes>, body: unknown): Promise<Response> {
  return app.request(
    "/internal/settle-owned-recovery-and-dequeue",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { incoming: { socket: {} } },
  );
}

function reply(status: number, body: unknown): MtlsFetch {
  return () => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

describe("internal owned-recovery atomic endpoint", () => {
  it("authenticates before parsing or database access", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new DenyAllPeerVerifier() });
    const response = await postOwned(app, { malformed: true });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "untrusted_peer" });
  });

  it("rejects malformed receipts before database access", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new AllowAllPeerVerifier() });
    const response = await postOwned(app, { ...INPUT, receipt: { kind: "planner_replan" } });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_owned_recovery_settle");
  });

  it("maps transaction failure to typed unknown settlement failure", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new AllowAllPeerVerifier() });
    const response = await postOwned(app, INPUT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "settlement_failed",
      reason: "write_failed",
      queueDisposition: "unknown",
      retryAfterMs: 3000,
    });
  });
});

describe("Direct/HTTP owned-recovery transport parity", () => {
  it("strictly decodes success and evidence failure", async () => {
    const success = new HttpRunStateWriter(
      "https://control.internal",
      reply(200, { kind: "settled", newlySettled: true }),
    );
    const rejected = new HttpRunStateWriter(
      "https://control.internal",
      reply(200, {
        kind: "settlement_failed",
        reason: "evidence_invalid",
        queueDisposition: "retained",
        retryAfterMs: 3000,
      }),
    );
    await expect(success.settleOwnedRecoveryAndDequeue(INPUT)).resolves.toEqual({
      kind: "settled",
      newlySettled: true,
    });
    await expect(rejected.settleOwnedRecoveryAndDequeue(INPUT)).resolves.toMatchObject({
      reason: "evidence_invalid",
      queueDisposition: "retained",
    });
  });

  it("posts the exact tuple and receipt to the dedicated endpoint", async () => {
    const fetch = vi.fn<MtlsFetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ kind: "settled", newlySettled: true }), { status: 200 })),
    );
    await new HttpRunStateWriter("https://control.internal/", fetch).settleOwnedRecoveryAndDequeue(INPUT);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://control.internal/internal/settle-owned-recovery-and-dequeue");
    expect(JSON.parse(String(init?.body))).toEqual(INPUT);
  });

  it.each([
    ["non-2xx", reply(503, "unavailable")],
    ["malformed", reply(200, { kind: "settled", newlySettled: "yes" })],
    [
      "invalid disposition pair",
      reply(200, {
        kind: "settlement_failed",
        reason: "evidence_invalid",
        queueDisposition: "unknown",
        retryAfterMs: 3000,
      }),
    ],
  ])("turns %s into transport uncertainty", async (_name, fetch) => {
    await expect(
      new HttpRunStateWriter("https://control.internal", fetch).settleOwnedRecoveryAndDequeue(INPUT),
    ).resolves.toEqual({
      kind: "settlement_failed",
      reason: "transport_failed",
      queueDisposition: "unknown",
      retryAfterMs: 3000,
    });
  });

  it("rejects malformed input identically before direct DB or HTTP transport", async () => {
    const fetch = vi.fn<MtlsFetch>();
    const malformed = { ...INPUT, message: "" };
    const expected = {
      kind: "settlement_failed",
      reason: "invalid_input",
      queueDisposition: "unknown",
      retryAfterMs: 3000,
    };
    await expect(new DirectRunStateWriter(THROWING_POOL).settleOwnedRecoveryAndDequeue(malformed)).resolves.toEqual(
      expected,
    );
    await expect(
      new HttpRunStateWriter("https://control.internal", fetch).settleOwnedRecoveryAndDequeue(malformed),
    ).resolves.toEqual(expected);
    expect(fetch).not.toHaveBeenCalled();
  });
});
