import { describe, expect, it } from "vitest";
import { EventRegistry, sensitivityFor } from "../src/engine/events/index.js";
import { defaultSeverityFor } from "../src/engine/notifications/eventDefaultSeverity.js";

const PREVIOUS = {
  blockReviewAt: "P1",
  p2p3Handling: "fix-if-idle",
  autonomousRemediation: false,
} as const;
const CURRENT = {
  blockReviewAt: "P3",
  p2p3Handling: "route-to-dag",
  autonomousRemediation: true,
} as const;

describe("governance.audit_posture.updated event contract", () => {
  it("accepts only the minimal non-secret before/after mutation evidence", () => {
    const schema = EventRegistry["governance.audit_posture.updated"];
    expect(schema.parse({ actorUserId: "user_admin", previous: PREVIOUS, current: CURRENT })).toEqual({
      actorUserId: "user_admin",
      previous: PREVIOUS,
      current: CURRENT,
    });
    expect(() =>
      schema.parse({ actorUserId: "user_admin", previous: PREVIOUS, current: CURRENT, credential: "secret" }),
    ).toThrow(/credential/u);
  });

  it("registers every field as public and keeps the default informational", () => {
    for (const path of [
      "actorUserId",
      "previous.blockReviewAt",
      "previous.p2p3Handling",
      "previous.autonomousRemediation",
      "current.blockReviewAt",
      "current.p2p3Handling",
      "current.autonomousRemediation",
    ]) {
      expect(sensitivityFor("governance.audit_posture.updated", path)).toBe("public");
    }
    expect(defaultSeverityFor("governance.audit_posture.updated")).toBe("info");
  });
});
