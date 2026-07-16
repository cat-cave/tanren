import type { IneligibleResult } from "../../integrations/provisioningEngine.js";

export class DeployIneligibleError extends Error {
  constructor(readonly outcome: IneligibleResult) {
    super(outcome.message);
  }
}
