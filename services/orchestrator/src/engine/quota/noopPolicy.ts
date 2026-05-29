// The default QuotaPolicy: unlimited. This is what a self-hosted deployment
// gets unless a hosting layer wires a real policy. It always admits and treats
// accrual as a no-op, so default behavior is unchanged — the gate only ever
// restricts when a real policy + quotas are configured.

import type { AdmissionDecision, AdmissionRequest, QuotaPolicy, RunUsage } from "./contracts.js";

export class NoopQuotaPolicy implements QuotaPolicy {
  async checkAdmission(_orgId: string, _requested: AdmissionRequest): Promise<AdmissionDecision> {
    return { admit: true };
  }

  async accrueUsage(_orgId: string, _usage: RunUsage): Promise<void> {
    // Unlimited: nothing to accrue.
  }
}
