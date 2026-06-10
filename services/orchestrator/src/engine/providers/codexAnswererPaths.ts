// Codex Answerer file-name + workspace-path helpers, split out of codex.ts to keep
// that adapter under the 500-line cap. The names derive from the answerer's output
// schema; a per-call uniqueness suffix keeps concurrent answerers (Checker +
// Auditor sharing a runner) from clobbering each other's schema/response files.

/**
 * Filesystem-safe schema file base name. `schemaName` is sanitized to the safe
 * `[a-zA-Z0-9._-]` set; an optional per-call `suffix` (also sanitized) is appended
 * so concurrent answerers sharing a CODEX_HOME / workspace base never derive the
 * same file name and clobber each other's schema / response files.
 */
export function safeSchemaFileName(schemaName: string, suffix?: string): string {
  const base = sanitizeFileToken(schemaName);
  return suffix === undefined || suffix === "" ? base : `${base}-${sanitizeFileToken(suffix)}`;
}

function sanitizeFileToken(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/gu, "_");
}

/**
 * The per-run answerer scratch workspace path. Must be writable by the runner's
 * `tanren` user — /tmp is uid-owned and denies mkdir, so the scratch lives under
 * tanren's home (same base as opencodeDataHomeForRun), NOT /tmp. `fileBase` is the
 * already-safe, per-call-unique name so two concurrent answerers under the same
 * runId get distinct workspace dirs.
 */
export function answererWorkspacePath(runId: string, fileBase: string, baseDirOverride?: string): string {
  const baseDir = baseDirOverride ?? "/home/tanren/.tanren/runs";
  return `${baseDir}/${runId}/${fileBase}`;
}
