import {
  DeployFailedPayload,
  DeployManualConfirmedPayload,
  DeployPendingManualPayload,
  DeployReapFailedPayload,
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
  "deploy.reap_failed": DeployReapFailedPayload,
  "deploy.skipped": DeploySkippedPayload,
  "deploy.pending_manual": DeployPendingManualPayload,
  "deploy.manual_confirmed": DeployManualConfirmedPayload,
  "demo.evidence.recorded": DemoEvidenceRecordedPayload,
  "demo.completed": DemoCompletedPayload,
  "demo.failed": DemoFailedPayload,
  ...helloEventRegistry,
} as const;
