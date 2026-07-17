import {
  CiFlakyDetectedPayload,
  CiJunitMissingPayload,
  CiTestQuarantinedPayload,
  CiTestsReportedPayload,
} from "./ciFlaky.js";
import {
  GateAdvisoryFailedPayload,
  GateFailedPayload,
  GatePassedPayload,
  GatePublishFailedPayload,
  GateQuarantineExcludedPayload,
  GateStartedPayload,
  GateVerdictPayload,
} from "./gate.js";

export const gateEventRegistry = {
  "ci.flaky.detected": CiFlakyDetectedPayload,
  "ci.test.quarantined": CiTestQuarantinedPayload,
  "ci.tests.reported": CiTestsReportedPayload,
  "ci.junit_missing": CiJunitMissingPayload,
  "gate.started": GateStartedPayload,
  "gate.passed": GatePassedPayload,
  "gate.failed": GateFailedPayload,
  "gate.advisory_failed": GateAdvisoryFailedPayload,
  "gate.quarantine_excluded": GateQuarantineExcludedPayload,
  "gate.publish_failed": GatePublishFailedPayload,
  "gate.verdict": GateVerdictPayload,
} as const;
