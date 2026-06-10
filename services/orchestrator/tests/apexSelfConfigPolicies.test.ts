// APEX / AUTONOMOUS-MODE self-configures the autonomy-loop policy DEFAULTS so the
// scheduled-audit (Loop 3) and CI-intelligence (Loop 4) loops ACTUATE on a live apex
// run WITHOUT manual per-run config — while the conservative human-in-the-loop defaults
// stay for every non-autonomous project.
//
//   Loop 3 — `resolveDefaultAuditPosture()`: under apex mode an absent project posture
//     resolves to the AUTONOMOUS posture (residual P2/P3 route to the DAG + a blocking
//     finding becomes a remediation spec), so the audit-posture PREFLIGHT passes and a
//     scheduled-audit finding re-enters the DAG. A non-autonomous project keeps the
//     BALANCED human-stop default.
//   Loop 4 — `resolveInsightThresholds()`: under apex mode the CI-intelligence
//     recurrence bar drops to 1 (a single-run flake is spec-eligible), so the
//     flaky→root-cause→ship loop closes; normal mode keeps the 2-SHA bar.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTONOMOUS_AUDIT_POSTURE,
  DEFAULT_AUDIT_POSTURE,
  isApexMode,
  resolveDefaultAuditPosture,
} from "../src/engine/config/index.js";
import { APEX_THRESHOLDS, DEFAULT_THRESHOLDS, resolveInsightThresholds } from "../src/engine/insights/index.js";
import {
  assertAuditPostureReentersFindings,
  AuditPostureStrandsFindingsError,
} from "../src/engine/workflow/auditPosturePreflight.js";
import { decideFromFindings } from "../src/engine/contracts/auditPosture.js";
import type { AppendEvent } from "../src/engine/workflow/subtaskLoop.js";
import type { Finding } from "../src/engine/contracts/findings.js";

const APEX_KEY = "TANREN_APEX_MODE";

function setApex(on: boolean): void {
  if (on) process.env[APEX_KEY] = "1";
  else delete process.env[APEX_KEY];
}

function noopAppend(): AppendEvent {
  return async () => {};
}

// A single P2 (residual / below the P1 block bar) finding — the case that must ROUTE
// to the DAG under the autonomous posture and PARK under the balanced default.
const p2Finding: Finding = {
  id: "flaky-readme-link",
  severity: "P2",
  title: "stale link in README",
  body: "a doc link 404s",
};

describe("apex self-configures the autonomy-loop policies", () => {
  const prior = process.env[APEX_KEY];
  beforeEach(() => setApex(false));
  afterEach(() => {
    if (prior === undefined) delete process.env[APEX_KEY];
    else process.env[APEX_KEY] = prior;
  });

  describe("Loop 3 — audit posture", () => {
    it("apex mode is OFF by default and resolves the conservative BALANCED default", () => {
      expect(isApexMode()).toBe(false);
      expect(resolveDefaultAuditPosture()).toEqual(DEFAULT_AUDIT_POSTURE);
    });

    it("apex mode resolves the AUTONOMOUS posture as the absent-config default", () => {
      setApex(true);
      expect(isApexMode()).toBe(true);
      expect(resolveDefaultAuditPosture()).toEqual(AUTONOMOUS_AUDIT_POSTURE);
    });

    it("the audit-posture PREFLIGHT PASSES for an autonomous run under apex mode (no manual config)", async () => {
      setApex(true);
      // The resolved default an apex autonomous run would carry when the project set no
      // explicit posture — the preflight must NOT strand it.
      await expect(
        assertAuditPostureReentersFindings({ autonomous: true, posture: resolveDefaultAuditPosture() }, noopAppend()),
      ).resolves.toBeUndefined();
    });

    it("the preflight still FAILS LOUD for an autonomous run on the conservative default (non-apex)", async () => {
      setApex(false);
      await expect(
        assertAuditPostureReentersFindings({ autonomous: true, posture: resolveDefaultAuditPosture() }, noopAppend()),
      ).rejects.toBeInstanceOf(AuditPostureStrandsFindingsError);
    });

    it("a P2/P3 residual finding ROUTES to the DAG under the apex default; PARKS under the normal default", () => {
      // Apex default → route-to-dag: the residual P2 routes (the posture is the authority).
      setApex(true);
      const apexDecision = decideFromFindings([p2Finding], resolveDefaultAuditPosture());
      expect(apexDecision.route.map((f) => f.id)).toContain(p2Finding.id);
      expect(apexDecision.fixInPlace).toHaveLength(0);

      // Normal default → fix-if-idle: the residual is held for in-place fixing, not routed.
      setApex(false);
      const normalDecision = decideFromFindings([p2Finding], resolveDefaultAuditPosture());
      expect(normalDecision.route).toHaveLength(0);
      expect(normalDecision.fixInPlace.map((f) => f.id)).toContain(p2Finding.id);
    });
  });

  describe("Loop 4 — CI-intelligence flaky threshold", () => {
    it("normal mode keeps the conservative 2-SHA recurrence bar", () => {
      setApex(false);
      expect(resolveInsightThresholds().ciInsightFlakyMinShas).toBe(2);
      expect(resolveInsightThresholds()).toEqual(DEFAULT_THRESHOLDS);
    });

    it("apex mode lowers the recurrence bar to 1 so a single-run flake is spec-eligible", () => {
      setApex(true);
      expect(resolveInsightThresholds().ciInsightFlakyMinShas).toBe(1);
      expect(resolveInsightThresholds()).toEqual(APEX_THRESHOLDS);
    });

    it("apex mode moves ONLY the flaky bar (every other threshold is unchanged)", () => {
      setApex(true);
      const { ciInsightFlakyMinShas: _apex, ...apexRest } = resolveInsightThresholds();
      const { ciInsightFlakyMinShas: _def, ...defaultRest } = DEFAULT_THRESHOLDS;
      expect(apexRest).toEqual(defaultRest);
    });
  });
});
