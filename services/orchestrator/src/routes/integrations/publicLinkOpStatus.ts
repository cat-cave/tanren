export const PUBLIC_LINK_OP_STATUSES = [
  "awaiting_principal_selection",
  "provider_unavailable",
  "verification_in_progress",
  "finalize_pending",
  "activate_pending",
  "completed",
  "failed",
  "malformed",
  "unknown",
] as const;

export type PublicLinkOpStatus = (typeof PUBLIC_LINK_OP_STATUSES)[number];

export interface DurableLinkOperationState {
  status: string;
  stage: string;
  failureClassification?: string;
  retryAfter?: string;
}

export interface PublicLinkOperationProjection {
  publicStatus: PublicLinkOpStatus;
  failureClassification?: string;
  retryAfter?: string;
}

function publicFailureClassification(value: string | undefined): string | undefined {
  return value !== undefined && /^[a-z][a-z0-9_]{0,127}$/u.test(value) ? value : undefined;
}

function publicRetryAfter(value: string | undefined): string | undefined {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return undefined;
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? undefined : instant.toISOString();
}

function publicStatusOf(input: DurableLinkOperationState, classification: string | undefined): PublicLinkOpStatus {
  if (input.status === "completed" && input.stage === "completed") return "completed";
  if (input.status === "compensated" || (input.status === "failed" && input.stage === "failed")) return "failed";
  if (
    classification !== undefined &&
    ((input.status === "awaiting_principal_selection" && input.stage === "awaiting_principal_selection") ||
      (["pending", "in_progress"].includes(input.status) &&
        ["created", "credential_staged", "verifying"].includes(input.stage)))
  ) {
    return "provider_unavailable";
  }
  if (input.failureClassification !== undefined && classification === undefined) return "unknown";
  if (input.status === "awaiting_principal_selection" && input.stage === "awaiting_principal_selection") {
    return "awaiting_principal_selection";
  }
  if (input.status === "in_progress" && input.stage === "finalizing") return "finalize_pending";
  if (input.status === "in_progress" && input.stage === "activate_pending") return "activate_pending";
  if (
    ["pending", "in_progress"].includes(input.status) &&
    ["created", "credential_staged", "verifying"].includes(input.stage)
  ) {
    return "verification_in_progress";
  }
  return "unknown";
}

/** Pure, fail-closed projection. Secret coordinates and provider bodies never enter it. */
export function publicLinkOperationProjection(input: DurableLinkOperationState): PublicLinkOperationProjection {
  const failureClassification = publicFailureClassification(input.failureClassification);
  const retryAfter = publicRetryAfter(input.retryAfter);
  return {
    publicStatus: publicStatusOf(input, failureClassification),
    ...(failureClassification === undefined ? {} : { failureClassification }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}
