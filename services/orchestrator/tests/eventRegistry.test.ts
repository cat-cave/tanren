import { describe, expect, it } from "vitest";
import {
  EventRegistry,
  UnknownEventTypeError,
  decodeEvent,
  isEventName,
  listEventNames,
} from "../src/engine/events/index.js";

describe("event registry", () => {
  it("registers every event name as a parseable Zod schema", () => {
    const names = listEventNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const schema = EventRegistry[name];
      expect(schema).toBeDefined();
      // sanity: schema can be parsed against an empty object (may fail; that's fine)
      // we only require it to be a Zod schema
      expect(typeof schema.parse).toBe("function");
    }
  });

  it("admits all currently-emitted event names from the phase 1 timeline", () => {
    const expectedNames = [
      "run.queued",
      "run.started",
      "run.completed",
      "run.failed",
      "task.queued",
      "task.started",
      "task.completed",
      "task.failed",
      "planner.started",
      "planner.completed",
      "planner.failed",
      "planner.subtasks.emitted",
      "writer.started",
      "writer.completed",
      "writer.failed",
      "writer.subtask.started",
      "writer.subtask.completed",
      "writer.subtask.failed",
      "checker.started",
      "checker.completed",
      "checker.failed",
      "checker.verdict",
      "auditor.started",
      "auditor.completed",
      "auditor.failed",
      "auditor.verdict",
      "runner.allocated",
      "runner.released",
      "runner.failed",
      "allocator.requested",
      "allocator.allocated",
      "allocator.failed",
      "workspace.prepared",
      "workspace.git_captured",
      "workspace.failed",
      "credential.requested",
      "credential.loaded",
      "credential.failed",
      "cost.resolved",
      "cost.failed",
      "github.branch.pushed",
      "github.pr.created",
      "github.pr.ready",
      "github.pr.merged",
      "github.failed",
      "ci.started",
      "ci.passed",
      "ci.failed",
      "phase1.fixture.started",
      "phase1.fixture.ci_pending",
      "phase1.fixture.completed",
      "phase1.fixture.failed",
      "review.requested",
      "review.approved",
      "review.changes_requested",
      "notification.enqueued",
      "notification.sent",
      "notification.failed",
      "hello.started",
      "hello.ssh_started",
      "hello.ssh_completed",
      "hello.completed",
    ];
    for (const name of expectedNames) {
      expect(isEventName(name)).toBe(true);
    }
  });

  it("decodeEvent parses known names and rejects unknown names", () => {
    const decoded = decodeEvent({
      event_type: "run.started",
      payload: { status: "running" },
    });
    expect(decoded.eventType).toBe("run.started");
    expect(decoded.payload).toEqual({ status: "running" });

    expect(() => decodeEvent({ event_type: "made_up.event", payload: {} })).toThrow(UnknownEventTypeError);
  });

  it("decodeEvent rejects payloads that violate the schema", () => {
    expect(() => decodeEvent({ event_type: "run.started", payload: { status: 42 } })).toThrow(
      /invalid|expected|string/iu,
    );
  });

  it("isEventName narrows the union", () => {
    const value = "checker.verdict";
    expect(isEventName(value)).toBe(true);
    // After the narrowing predicate, the registry lookup is type-safe.
    const schema = isEventName(value) ? EventRegistry[value] : undefined;
    expect(schema).toBeDefined();
  });
});
