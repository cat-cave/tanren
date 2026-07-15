/** Recovery prepare refused: missing row or status outside the recoverable allowlist. */
export class SpecNotPreparedForRecoveryError extends Error {
  constructor(
    readonly specId: string,
    readonly reason: "missing" | "not_recoverable",
    readonly status?: string,
  ) {
    const detail =
      reason === "missing"
        ? "spec status is missing"
        : `spec status '${status ?? "unknown"}' is not a recoverable recovery source`;
    super(`spec ${specId} cannot be prepared for recovery: ${detail}`);
    this.name = "SpecNotPreparedForRecoveryError";
  }
}
