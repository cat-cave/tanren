import {
  DeployFailedPayload,
  DeployManualConfirmedPayload,
  DeployPendingManualPayload,
  DeploySkippedPayload,
  DeployTriggeredPayload,
  DeployVerifiedPayload,
  helloEventRegistry,
} from "./integrations.js";
import { DemoCompletedPayload, DemoEvidenceRecordedPayload, DemoFailedPayload } from "./postMerge.js";

export const deploymentEventRegistry = {
  "deploy.triggered": DeployTriggeredPayload,
  "deploy.verified": DeployVerifiedPayload,
  "deploy.failed": DeployFailedPayload,
  "deploy.skipped": DeploySkippedPayload,
  "deploy.pending_manual": DeployPendingManualPayload,
  "deploy.manual_confirmed": DeployManualConfirmedPayload,
  "demo.evidence.recorded": DemoEvidenceRecordedPayload,
  "demo.completed": DemoCompletedPayload,
  "demo.failed": DemoFailedPayload,
  ...helloEventRegistry,
} as const;
