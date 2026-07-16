/**
 * gv-3 — project policy identity receipt (content hash of governance-sensitive
 * fields). Mirrors the orchestrator `PolicyIdentityView` response shape.
 */

export interface PolicyIdentityView {
  orgId: string;
  projectId: string;
  /** Non-empty hex digest — the sole land/proof policy identity. */
  policyHash: string;
  fields: string[];
  schemaVersion: 1;
  proof: "gv3_policy_identity_receipt";
}

export function isPolicyIdentityView(value: unknown): value is PolicyIdentityView {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["orgId"] === "string" &&
    typeof v["projectId"] === "string" &&
    typeof v["policyHash"] === "string" &&
    /^[0-9a-f]{64}$/u.test(v["policyHash"]) &&
    Array.isArray(v["fields"]) &&
    v["schemaVersion"] === 1 &&
    v["proof"] === "gv3_policy_identity_receipt"
  );
}
