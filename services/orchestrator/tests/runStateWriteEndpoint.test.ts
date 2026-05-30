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

import { describe, expect, it } from "vitest";
import { runWithJobOrgId } from "@tanren/db";
import { AllowAllPeerVerifier, DenyAllPeerVerifier, type MtlsFetch } from "../src/engine/contracts/index.js";
import { HttpRunStateWriter, RunStateWriteTransportError } from "../src/engine/worker/index.js";
import { createInternalRunStateWriteRoutes } from "../src/routes/internal/runStateWrites.js";

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
    for (const path of ["/internal/append-event", "/internal/record-cost", "/internal/finalize-run"]) {
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
    ).rejects.toThrow(/per-job org-id/);
  });
});
