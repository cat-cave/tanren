import { describe, expect, it } from "vitest";
import { listEventNames } from "../src/engine/events/index.js";
import { defaultSeverityFor, eventDefaultSeverity } from "../src/engine/notifications/index.js";

// every EventName in the registry must have a default
// severity in the matrix UI. Missing entries would silently fall back to
// `info`, which the matrix UI would render as "no severity" — confusing.

describe("eventDefaultSeverity coverage", () => {
  it("maps every registered event name to a severity", () => {
    for (const name of listEventNames()) {
      const severity = eventDefaultSeverity[name];
      expect(severity).toBeDefined();
      expect(["ok", "info", "warn", "fail"]).toContain(severity);
    }
  });

  it("classifies the canonical examples per the spec", () => {
    expect(defaultSeverityFor("run.completed")).toBe("ok");
    expect(defaultSeverityFor("run.failed")).toBe("fail");
    expect(defaultSeverityFor("github.failed")).toBe("warn");
    expect(defaultSeverityFor("cost.unattributed")).toBe("fail");
    expect(defaultSeverityFor("redaction.raw_access")).toBe("info");
    expect(defaultSeverityFor("writer.subtask.completed")).toBe("info");
    expect(defaultSeverityFor("github.pr.merged")).toBe("ok");
  });
});
