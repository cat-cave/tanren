// ROUND-3 audit findings H-R3.1, H-R3.2, H-R3.3 — the `priorEvents` slot
// discipline on the atomic terminal write seam (`updateTaskWithEvent`).
//
// Pins:
//   - H-R3.1: a TERMINAL task/run event type leaked into priorEvents is
//     rejected at the seam with a typed Zod error (no silent double-emit of a
//     terminal event). Verified against BOTH the InMemoryRunStateWriter
//     fixture AND the shared production `terminalPairSchema` so the test
//     fixture is conformance-equivalent to the direct-DB writer.
//   - H-R3.2: an idempotency-keyed retry of the SAME bundle dedupes the
//     priorEvents instead of double-recording them in the in-memory writer's
//     `atomic` / `allEvents` shapes (mirrors the production
//     `events_prior_idempotency_unique` partial unique index +
//     `ON CONFLICT DO NOTHING`).
//   - H-R3.3: the InMemoryRunStateWriter fixture parse-validates every
//     `updateTaskWithEvent` input through the SAME `terminalPairSchema` the
//     production direct writer runs — a missing `idempotencyKey`, a missing
//     `runId`, or a mismatched terminal pair fails LOUDLY in tests rather
//     than silently passing while production would crash.

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { terminalPairSchema } from "../src/engine/worker/runStateLifecycleSql.js";
import { InMemoryRunStateWriter } from "./fixtures/inMemoryRunStateWriter.js";

const BASE = {
  runId: "run_round3_priors",
  specId: "spec_round3",
  projectId: "project_round3",
  taskId: "task_round3",
};

describe("round-3 priorEvents discipline (H-R3.1 + H-R3.2 + H-R3.3)", () => {
  // -------------------------------------------------------------------------
  // H-R3.1 — terminal-event leak guard
  // -------------------------------------------------------------------------

  const TERMINAL_LEAK_TYPES = [
    "task.completed",
    "task.failed",
    "task.cancelled",
    "run.completed",
    "run.failed",
    "run.cancelled",
    // run.resumed is a terminal-deduped run event (events_run_terminal_unique);
    // it must be refused in the priorEvents bundle like any other terminal run event.
    "run.resumed",
  ];

  it.each(TERMINAL_LEAK_TYPES)("(H-R3.1) terminalPairSchema rejects priorEvents.eventType=%s", (eventType) => {
    const result = terminalPairSchema.safeParse({
      task: { taskId: "t", orgId: "org_round3", transition: "done", outcome: "passed" },
      event: { projectId: BASE.projectId, eventType: "task.completed", payload: { taskKind: "review" } },
      priorEvents: [
        {
          runId: "r",
          projectId: BASE.projectId,
          eventType,
          payload: {},
          idempotencyKey: "r:terminal-leak",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("(H-R3.2) terminalPairSchema rejects priorEvents entry missing idempotencyKey", () => {
    const result = terminalPairSchema.safeParse({
      task: { taskId: "t", orgId: "org_round3", transition: "done", outcome: "passed" },
      event: { projectId: BASE.projectId, eventType: "task.completed", payload: { taskKind: "review" } },
      priorEvents: [
        {
          runId: "r",
          projectId: BASE.projectId,
          eventType: "review.approved",
          payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1 },
          // intentionally NO idempotencyKey
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("(H-R3.2) terminalPairSchema rejects priorEvents entry missing runId", () => {
    const result = terminalPairSchema.safeParse({
      task: { taskId: "t", orgId: "org_round3", transition: "done", outcome: "passed" },
      event: { projectId: BASE.projectId, eventType: "task.completed", payload: { taskKind: "review" } },
      priorEvents: [
        {
          // intentionally NO runId
          projectId: BASE.projectId,
          eventType: "review.approved",
          payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1 },
          idempotencyKey: "r:review:approved",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it.each(TERMINAL_LEAK_TYPES)(
    "(H-R3.1) InMemoryRunStateWriter rejects priorEvents.eventType=%s (terminal-leak guard)",
    async (eventType) => {
      const writer = new InMemoryRunStateWriter();
      const call = writer.updateTaskWithEvent({
        task: { taskId: BASE.taskId, orgId: "org_round3", transition: "done", outcome: "ok" },
        event: {
          ...BASE,
          eventType: "task.completed",
          payload: { taskKind: "review", status: "approved" } as never,
        },
        priorEvents: [
          {
            ...BASE,
            eventType: eventType as never,
            payload: {} as never,
            idempotencyKey: `${BASE.runId}:terminal-leak:${eventType}`,
          },
        ],
      });
      await expect(call).rejects.toBeInstanceOf(ZodError);
      // No row mutation, no atomic record landed (the rejection happens at the
      // seam BEFORE any state change — the doctrine-critical fail-loud point).
      expect(writer.atomic).toEqual([]);
      expect(writer.tasks.size).toBe(0);
    },
  );

  // -------------------------------------------------------------------------
  // H-R3.2 — retried bundle dedupes the prior events
  // -------------------------------------------------------------------------

  it("(H-R3.2) a retried bundle with the same (runId, idempotencyKey) dedupes priorEvents", async () => {
    const writer = new InMemoryRunStateWriter();
    const bundle = () =>
      writer.updateTaskWithEvent({
        task: { taskId: BASE.taskId, orgId: "org_round3", transition: "done", outcome: "ok" },
        event: {
          ...BASE,
          eventType: "task.completed",
          payload: { taskKind: "review", status: "approved" } as never,
        },
        priorEvents: [
          {
            ...BASE,
            eventType: "review.approved",
            payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1 } as never,
            idempotencyKey: `${BASE.runId}:review:approved`,
          },
        ],
      });

    await bundle();
    await bundle();

    // Two atomic-write calls landed (the row UPDATE / terminal-event ledger
    // tracks each invocation), BUT the second call's priorEvents deduped on
    // (runId, idempotencyKey) so the flattened `allEvents` carries the
    // review.approved exactly ONCE — same as a real PG commit under the
    // `events_prior_idempotency_unique` partial unique index. (The terminal
    // event still appears once per atomic record; the in-memory fixture
    // mirrors a successful retry where the production `appendIfAbsent` would
    // have returned alreadyTerminal=true.)
    expect(writer.atomic).toHaveLength(2);
    const reviewApprovedCount = writer.allEvents.filter((e) => e.eventType === "review.approved").length;
    expect(reviewApprovedCount).toBe(1);
  });

  it("(H-R3.2) distinct idempotencyKeys on the same run DO land separately", async () => {
    const writer = new InMemoryRunStateWriter();
    const orgId = "org_round3";
    await writer.updateTaskWithEvent({
      task: { taskId: BASE.taskId, orgId, transition: "done", outcome: "ok" },
      event: {
        ...BASE,
        eventType: "task.completed",
        payload: { taskKind: "review", status: "approved" } as never,
      },
      priorEvents: [
        {
          ...BASE,
          eventType: "review.approved",
          payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1 } as never,
          idempotencyKey: `${BASE.runId}:review:approved:v1`,
        },
        {
          ...BASE,
          eventType: "review.approved",
          payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1, reviewer: "bob" } as never,
          idempotencyKey: `${BASE.runId}:review:approved:v2`,
        },
      ],
    });
    const reviewApprovedCount = writer.allEvents.filter((e) => e.eventType === "review.approved").length;
    expect(reviewApprovedCount).toBe(2);
  });

  // -------------------------------------------------------------------------
  // H-R3.3 — InMemoryRunStateWriter parse-validates every input
  // -------------------------------------------------------------------------

  it("(H-R3.3) InMemoryRunStateWriter rejects a priorEvents entry missing idempotencyKey", async () => {
    const writer = new InMemoryRunStateWriter();
    const call = writer.updateTaskWithEvent({
      task: { taskId: BASE.taskId, orgId: "org_round3", transition: "done", outcome: "ok" },
      event: {
        ...BASE,
        eventType: "task.completed",
        payload: { taskKind: "review", status: "approved" } as never,
      },
      // Force-cast around the type-system so the runtime parse is what catches
      // it — the fixture's job is to enforce the contract regardless of
      // upstream typing slips.
      priorEvents: [
        {
          ...BASE,
          eventType: "review.approved",
          payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1 } as never,
        } as never,
      ],
    });
    await expect(call).rejects.toBeInstanceOf(ZodError);
    expect(writer.atomic).toEqual([]);
  });

  it("(H-R3.3) InMemoryRunStateWriter rejects a mismatched terminal pair (done ↔ task.failed)", async () => {
    const writer = new InMemoryRunStateWriter();
    const call = writer.updateTaskWithEvent({
      task: { taskId: BASE.taskId, orgId: "org_round3", transition: "done", outcome: "ok" },
      event: {
        ...BASE,
        eventType: "task.failed",
        payload: { taskKind: "review", reason: "wat" } as never,
      },
    });
    await expect(call).rejects.toBeInstanceOf(ZodError);
    expect(writer.atomic).toEqual([]);
  });

  it("(H-R3.3) InMemoryRunStateWriter rejects a non-terminal transition through the atomic seam", async () => {
    const writer = new InMemoryRunStateWriter();
    const call = writer.updateTaskWithEvent({
      task: { taskId: BASE.taskId, orgId: "org_round3", transition: "running" as never, outcome: "ok" },
      event: {
        ...BASE,
        eventType: "task.completed",
        payload: { taskKind: "review", status: "approved" } as never,
      },
    });
    await expect(call).rejects.toBeInstanceOf(ZodError);
    expect(writer.atomic).toEqual([]);
  });

  it("(H-R3.3) happy path: a well-formed priorEvents bundle records the atomic write + applies the row transition", async () => {
    const writer = new InMemoryRunStateWriter();
    await writer.updateTaskWithEvent({
      task: { taskId: BASE.taskId, orgId: "org_round3", transition: "done", outcome: "ok" },
      event: {
        ...BASE,
        eventType: "task.completed",
        payload: { taskKind: "review", status: "approved" } as never,
      },
      priorEvents: [
        {
          ...BASE,
          eventType: "review.approved",
          payload: { prUrl: "https://github.com/o/r/pull/1", prNumber: 1 } as never,
          idempotencyKey: `${BASE.runId}:review:approved`,
        },
      ],
    });
    expect(writer.atomic).toHaveLength(1);
    expect(writer.tasks.get(BASE.taskId)?.status).toBe("done");
    expect(writer.allEvents.map((e) => e.eventType)).toEqual(["review.approved", "task.completed"]);
  });
});
