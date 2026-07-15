import type pg from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  AllowAllPeerVerifier,
  DenyAllPeerVerifier,
  type MtlsFetch,
  type RecoveryParkInput,
} from "../src/engine/contracts/index.js";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
import { HttpRunStateWriter } from "../src/engine/worker/httpRunStateWriter.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";

const INPUT: RecoveryParkInput = {
  orgId: "org_park",
  projectId: "project_park",
  queueId: "queue_park",
  runId: "run_park",
  specId: "spec_park",
  message: "genuine intent conflict",
};

const THROWING_POOL = {
  connect: async () => {
    throw new Error("injected database outage");
  },
} as unknown as pg.Pool;

function post(app: ReturnType<typeof createInternalRunStateWriteRoutes>, body: unknown): Promise<Response> {
  return app.request(
    "/internal/park-recovery-and-dequeue",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    { incoming: { socket: {} } },
  );
}

function reply(status: number, body: unknown): MtlsFetch {
  return () => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

const THROWING_FETCH: MtlsFetch = () => Promise.reject(new Error("connection reset"));

describe("internal recovery park endpoint", () => {
  it("authenticates before parsing or touching the database", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new DenyAllPeerVerifier() });
    const response = await post(app, { malformed: true });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "untrusted_peer" });
  });

  it("rejects malformed ownership input before database access", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new AllowAllPeerVerifier() });
    const response = await post(app, { queueId: INPUT.queueId });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_recovery_park");
  });

  it("defensively rejects an empty message before database access", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new AllowAllPeerVerifier() });
    const response = await post(app, { ...INPUT, message: "" });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_recovery_park");
  });

  it("maps a rolled-back database failure to typed parking_failed", async () => {
    const app = createInternalRunStateWriteRoutes({ pool: THROWING_POOL, verifier: new AllowAllPeerVerifier() });
    const response = await post(app, INPUT);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      kind: "parking_failed",
      reason: "write_failed",
      queueDisposition: "unknown",
      retryAfterMs: 3_000,
    });
  });
});

describe("HttpRunStateWriter recovery park parity and transport discipline", () => {
  it("strictly decodes parked and parking_failed endpoint outcomes", async () => {
    const parked = new HttpRunStateWriter(
      "https://control.internal",
      reply(200, { kind: "parked", newlyParked: true }),
    );
    const failed = new HttpRunStateWriter(
      "https://control.internal",
      reply(200, {
        kind: "parking_failed",
        reason: "spec_not_recoverable",
        queueDisposition: "retained",
        retryAfterMs: 3_000,
      }),
    );

    await expect(parked.parkRecoveryAndDequeue(INPUT)).resolves.toEqual({ kind: "parked", newlyParked: true });
    await expect(failed.parkRecoveryAndDequeue(INPUT)).resolves.toEqual({
      kind: "parking_failed",
      reason: "spec_not_recoverable",
      queueDisposition: "retained",
      retryAfterMs: 3_000,
    });
  });

  it("accepts only coupled reason/disposition pairs and canonical retry delays", async () => {
    const validScheduled = new HttpRunStateWriter(
      "https://control.internal",
      reply(200, {
        kind: "parking_failed",
        reason: "queue_not_active",
        queueDisposition: "unknown",
        retryAfterMs: 10_000,
      }),
    );
    await expect(validScheduled.parkRecoveryAndDequeue(INPUT)).resolves.toMatchObject({
      reason: "queue_not_active",
      retryAfterMs: 10_000,
    });

    for (const body of [
      {
        kind: "parking_failed",
        reason: "ownership_missing",
        queueDisposition: "retained",
        retryAfterMs: 3_000,
      },
      {
        kind: "parking_failed",
        reason: "spec_not_recoverable",
        queueDisposition: "unknown",
        retryAfterMs: 3_000,
      },
      {
        kind: "parking_failed",
        reason: "write_failed",
        queueDisposition: "unknown",
        retryAfterMs: 120_000,
      },
    ]) {
      await expect(
        new HttpRunStateWriter("https://control.internal", reply(200, body)).parkRecoveryAndDequeue(INPUT),
      ).resolves.toEqual({
        kind: "parking_failed",
        reason: "transport_failed",
        queueDisposition: "unknown",
        retryAfterMs: 3_000,
      });
    }
  });

  it("posts the exact bounded ownership tuple to the dedicated internal route", async () => {
    const fetch = vi.fn<MtlsFetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ kind: "parked", newlyParked: true }), { status: 200 })),
    );
    const writer = new HttpRunStateWriter("https://control.internal/", fetch);
    await writer.parkRecoveryAndDequeue(INPUT);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("https://control.internal/internal/park-recovery-and-dequeue");
    expect(JSON.parse(String(init?.body))).toEqual(INPUT);
  });

  it.each([
    ["non-2xx", reply(503, "unavailable")],
    ["malformed 2xx", reply(200, { kind: "parked", newlyParked: "yes" })],
    ["unknown 2xx fields", reply(200, { kind: "parked", newlyParked: true, trusted: false })],
  ])("turns %s into typed transport_failed with a paced redrive", async (_name, fetch) => {
    const writer = new HttpRunStateWriter("https://control.internal", fetch);
    await expect(writer.parkRecoveryAndDequeue(INPUT)).resolves.toEqual({
      kind: "parking_failed",
      reason: "transport_failed",
      queueDisposition: "unknown",
      retryAfterMs: 3_000,
    });
  });

  it("turns a thrown transport into typed parking_failed instead of throwing or fabricating dequeue", async () => {
    const writer = new HttpRunStateWriter("https://control.internal", THROWING_FETCH);
    await expect(writer.parkRecoveryAndDequeue(INPUT)).resolves.toEqual({
      kind: "parking_failed",
      reason: "transport_failed",
      queueDisposition: "unknown",
      retryAfterMs: 3_000,
    });
  });

  it("rejects empty messages with Direct/HTTP parity before DB or transport", async () => {
    const fetch = vi.fn<MtlsFetch>(() => Promise.reject(new Error("must not send")));
    const direct = new DirectRunStateWriter(THROWING_POOL);
    const http = new HttpRunStateWriter("https://control.internal", fetch);
    const expected = {
      kind: "parking_failed",
      reason: "invalid_input",
      queueDisposition: "unknown",
      retryAfterMs: 3_000,
    };

    await expect(direct.parkRecoveryAndDequeue({ ...INPUT, message: "" })).resolves.toEqual(expected);
    await expect(http.parkRecoveryAndDequeue({ ...INPUT, message: "" })).resolves.toEqual(expected);
    expect(fetch).not.toHaveBeenCalled();
  });
});
