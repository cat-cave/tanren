import { describe, expect, it } from "vitest";
import { fakeAuditor, fakeChecker, fakePlanner, fakeWriter } from "../src/engine/providers/fake.js";

describe("fake provider adapters", () => {
  it("prove the writer and answerer contracts can complete", async () => {
    const plan = await fakePlanner.runAnswerer({ prompt: "plan", timeoutMs: 100 });
    const writer = await fakeWriter.runWriter({ prompt: "write", workspace: "/workspace", timeoutMs: 100 });
    const check = await fakeChecker.runAnswerer({ prompt: writer.diff, timeoutMs: 100 });
    const audit = await fakeAuditor.runAnswerer({ prompt: JSON.stringify(plan), timeoutMs: 100 });

    expect(plan.subtasks).toHaveLength(1);
    expect(writer.exitReason).toBe("completed");
    expect(check.done).toBe(true);
    expect(audit.verified).toBe(true);
  });
});
