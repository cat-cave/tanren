/**
 * Parse a positive-hours env var fail-closed — UNSET defaults, PRESENT-malformed
 * THROWS.
 *
 * `TANREN_MAX_RUN_HOURS` becomes the sweeper's abandoned threshold (`now - hours`)
 * AND derives the scoped-credential token TTL. A `0` would make the threshold
 * exactly `now`, so `listActiveOlderThan(now)` reaps EVERY active runner —
 * including the live apex run; `abc` → NaN → an Invalid Date threshold. A reaper
 * threshold must NEVER be `<= now`.
 *
 * No-silent-fallback doctrine (Codex r4 §1): a PRESENT-but-malformed / non-positive
 * value is a DEPLOY-CONFIG PARSE FAILURE, not a recoverable runtime event — it
 * THROWS loud at boot rather than quietly degrading to the default (which the old
 * `log.error + return fallback` did, masking a typo'd operator value as a working
 * 6h cap). The default applies ONLY when the var is genuinely UNSET/blank.
 *
 * Dependency-free (no module-level env reads / no logger), so it stays importable
 * for tests without triggering `main.ts`'s env reads.
 */
export function requirePositiveHours(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `${name}='${raw}' is not a positive number of hours. A reaper threshold / token-TTL ceiling must be ` +
        "strictly positive and finite (a <= 0 or NaN value would reap every active runner / collapse the " +
        "scoped-token TTL). Unset it to use the default; a present-but-malformed value must NOT silently degrade.",
    );
  }
  return parsed;
}
