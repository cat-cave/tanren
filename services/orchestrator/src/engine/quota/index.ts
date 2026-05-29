// Barrel for the SaaS Tier-B quota-admission-gate — the OSS↔hosting billing
// seam. The OSS *enforces* a pluggable QuotaPolicy + *exports* usage; a closed
// hosting layer supplies the limits + does billing. See
// docs/architecture/portability-and-longevity.md (OSS↔hosting seam).
//
// - QuotaPolicy: the pluggable interface (pre-flight admission + post-run accrual).
// - NoopQuotaPolicy: the unlimited default (self-host is unrestricted).
// - DbQuotaPolicy: reads/accrues `org_quotas` (a hosting layer writes limits).
// - metering-export: typed reads off `cost_records` grouped by org_id.

export {
  type AdmissionRequest,
  type AdmissionDecision,
  type RunUsage,
  type QuotaPolicy,
  SINGLE_RUN_REQUEST,
} from "./contracts.js";
export { NoopQuotaPolicy } from "./noopPolicy.js";
export { DbQuotaPolicy } from "./dbPolicy.js";
export {
  type UsageWindow,
  type OrgUsage,
  type BillableRun,
  getOrgUsage,
  streamBillableRuns,
  getRunUsage,
} from "./meteringExport.js";
