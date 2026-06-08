import type { UsageReadFailure } from "./contracts.js";

// The `usage.read_failed` event payload, derived from a {@link UsageReadFailure}.
// A usage read (codexbar window state / ccusage accounting) that timed out, hit
// an SSH transport failure, exited non-zero, or returned malformed NON-empty
// output is a LOUD discriminated failure — it must NEVER be conflated with a
// legitimately-empty read (no-silent-fallbacks doctrine). This is what the loop
// emits so an operator can tell an erased usage read apart from genuine absence
// of data. It carries NO secret value — `target` is a provider/cli label and
// `detail` is a bounded, whitespace-collapsed stderr/stdout tail.
export interface UsageReadFailedPayload {
  tool: "codexbar" | "ccusage";
  target: string;
  reason: "timeout" | "ssh_failure" | "nonzero_exit" | "malformed_output";
  exitCode: number | null;
  detail: string;
  reasonText: string;
}

export const USAGE_READ_FAILED_REASON =
  "a usage probe read (codexbar/ccusage) failed to report; recorded as a loud read failure, NOT silently treated as zero/no-data";

export function usageReadFailedPayload(failure: UsageReadFailure): UsageReadFailedPayload {
  return {
    tool: failure.tool,
    target: failure.target,
    reason: failure.reason,
    exitCode: failure.exitCode,
    detail: failure.detail,
    reasonText: USAGE_READ_FAILED_REASON,
  };
}
