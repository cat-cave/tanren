// LOOP 3 — the run-setup audit-posture preflight. For an AUTONOMOUS run the resolved
// `auditPosture` MUST re-enter scheduled-audit findings into the DAG (residual
// routes/fixes AND blocking findings become remediation specs). A posture that would
// strand findings silently no-ops the audit→fix→merge proof, so the run FAILS CLOSED
// at setup (a loud `audit.posture_strands_findings` event + a thrown error). A
// non-autonomous run is a no-op (a parked blocking finding is its intended human-stop).
import { describe, expect, it } from "vitest";
import type { EventName, EventPayload } from "../src/engine/events/index.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";
import {
  assertAuditPostureReentersFindings,
  AuditPostureStrandsFindingsError,
} from "../src/engine/workflow/auditPosturePreflight.js";
import { AUTONOMOUS_AUDIT_POSTURE, DEFAULT_AUDIT_POSTURE } from "../src/engine/config/index.js";

interface Captured {
  eventType: EventName;
  payload: EventPayload<EventName>;
}

function recorder(): { append: AppendEvent; events: Captured[] } {
  const events: Captured[] = [];
  const append: AppendEvent = async (eventType, payload) => {
    events.push({ eventType, payload });
  };
  return { append, events };
}

describe("assertAuditPostureReentersFindings (Loop 3)", () => {
  it("FAILS LOUD: an autonomous run with the BALANCED default posture strands findings", async () => {
    const r = recorder();
    await expect(
      assertAuditPostureReentersFindings({ autonomous: true, posture: DEFAULT_AUDIT_POSTURE }, r.append),
    ).rejects.toBeInstanceOf(AuditPostureStrandsFindingsError);
    // A loud, secret-free event fires BEFORE the throw.
    expect(r.events.map((e) => e.eventType)).toEqual(["audit.posture_strands_findings"]);
    expect(r.events[0]?.payload).toMatchObject({ autonomousRemediation: false });
  });

  it("PASSES: an autonomous run with the AUTONOMOUS posture (route + remediate) re-enters findings", async () => {
    const r = recorder();
    await expect(
      assertAuditPostureReentersFindings({ autonomous: true, posture: AUTONOMOUS_AUDIT_POSTURE }, r.append),
    ).resolves.toBeUndefined();
    expect(r.events).toEqual([]);
  });

  it("is a NO-OP for a non-autonomous run, even with a parking posture (the intended human-stop)", async () => {
    const r = recorder();
    await expect(
      assertAuditPostureReentersFindings({ autonomous: false, posture: DEFAULT_AUDIT_POSTURE }, r.append),
    ).resolves.toBeUndefined();
    expect(r.events).toEqual([]);
  });
});
