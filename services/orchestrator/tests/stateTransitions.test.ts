import { describe, expect, it } from "vitest";
import {
  IllegalJobTransitionError,
  IllegalRunTransitionError,
  IllegalSpecTransitionError,
  IllegalTaskTransitionError,
  JobStatus,
  RunOutcome,
  RunStatus,
  SpecStatus,
  TaskKind,
  TaskOutcome,
  TaskStatus,
  isAllowedJobTransition,
  isAllowedRunTransition,
  listAllowedJobTransitions,
  listAllowedRunTransitions,
  listAllowedTaskTransitions,
  transitionJob,
  transitionRun,
  transitionSpec,
  transitionTask
} from "../src/engine/state/index.js";

describe("RunStatus transitions", () => {
  it("allows the Phase 2 happy-path sequence", () => {
    expect(() => transitionRun("queued", "running")).not.toThrow();
    expect(() => transitionRun("running", "completed")).not.toThrow();
  });

  it("allows pause-and-resume via halted", () => {
    expect(isAllowedRunTransition("running", "halted")).toBe(true);
    expect(isAllowedRunTransition("halted", "running")).toBe(true);
    expect(isAllowedRunTransition("halted", "cancelled")).toBe(true);
  });

  it("rejects illegal transitions at runtime", () => {
    expect(() => transitionRun("queued", "completed")).toThrowError(IllegalRunTransitionError);
    expect(() => transitionRun("completed", "running")).toThrowError(IllegalRunTransitionError);
    expect(() => transitionRun("failed", "running")).toThrowError(IllegalRunTransitionError);
  });

  it("exposes the full transition list for inspection", () => {
    expect(listAllowedRunTransitions("queued")).toContain("running");
    expect(listAllowedRunTransitions("completed")).toHaveLength(0);
  });
});

describe("SpecStatus transitions", () => {
  it("allows the Phase 2 review path", () => {
    expect(() => transitionSpec("open", "in_flight")).not.toThrow();
    expect(() => transitionSpec("in_flight", "review")).not.toThrow();
    expect(() => transitionSpec("review", "merged")).not.toThrow();
  });

  it("rejects skipping review", () => {
    expect(() => transitionSpec("open", "merged")).toThrowError(IllegalSpecTransitionError);
  });
});

describe("TaskStatus transitions", () => {
  it("allows the standard worker lifecycle", () => {
    expect(() => transitionTask("queued", "claimed")).not.toThrow();
    expect(() => transitionTask("claimed", "running")).not.toThrow();
    expect(() => transitionTask("running", "done")).not.toThrow();
    expect(() => transitionTask("running", "failed")).not.toThrow();
  });

  it("rejects illegal transitions", () => {
    expect(() => transitionTask("done", "running")).toThrowError(IllegalTaskTransitionError);
    expect(() => transitionTask("queued", "done")).toThrowError(IllegalTaskTransitionError);
  });
});

describe("JobStatus transitions", () => {
  it("matches the task-status lifecycle", () => {
    for (const from of JobStatus.options) {
      const taskAllowed = listAllowedTaskTransitions(from);
      const jobAllowed = listAllowedJobTransitions(from);
      expect([...jobAllowed].sort()).toEqual([...taskAllowed].sort());
    }
  });

  it("rejects illegal transitions", () => {
    expect(() => transitionJob("failed", "done")).toThrowError(IllegalJobTransitionError);
  });

  it("isAllowedJobTransition agrees with the helper", () => {
    expect(isAllowedJobTransition("queued", "claimed")).toBe(true);
    expect(isAllowedJobTransition("done", "queued")).toBe(false);
  });
});

describe("enum membership", () => {
  it("includes Phase 2 canonical values plus legacy values", () => {
    expect(RunStatus.options).toContain("queued");
    expect(RunStatus.options).toContain("completed");
    expect(RunStatus.options).toContain("done");
    expect(RunOutcome.options).toContain("hello_complete");
    expect(RunOutcome.options).toContain("hello_world_complete");
    expect(SpecStatus.options).toContain("in_flight");
    expect(SpecStatus.options).toContain("pending");
    expect(TaskKind.options).toContain("forge");
    expect(TaskStatus.options).toContain("claimed");
    expect(TaskOutcome.options).toContain("rejected_by_checker");
  });
});
