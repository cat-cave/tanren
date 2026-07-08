// Sanitize an authorer error message BEFORE it is folded into the F2 fixed-point
// signature (docs/roadmap/timeout-eradication.md — the F2 doctrine extension).
//
// THE BUG THIS FIX CLOSES. `authorOneFragment`'s previous shape hashed the RAW
// authorer error message into its per-attempt signature:
//     const signature = `authorer-threw:${lastRejection}`;
// Real LLM providers (Codex, Claude, Anthropic bedrock, etc.) throw with
// content-variable error messages — request ids, ISO 8601 timestamps, Unix
// second/millisecond counters, retry-after clocks, UUID trace ids. A STUCK
// provider (e.g. rate-limited, upstream 5xx) throws with a slightly-different
// error string EACH attempt (`request_id: 7f3c1a...`, `at 2026-07-07T14:22:41Z`,
// `retry after 12 seconds`). The prior signature comparison saw a NEW signature
// on every attempt and treated the loop as making progress — an unbounded
// credit burn against a provider that is materially in a fixed-point (same
// class of failure, cosmetically-different message).
//
// The sanitizer normalizes the message so cosmetic clock/id noise strips to
// invariant placeholder tokens. Two throws from the same class of failure hash
// identically ⇒ the fixed-point detector catches the stuck-provider loop.
//
// SCOPE. We replace, not delete — an operator reading a rejection sees
// `<TIMESTAMP>` / `<UNIX_TS>` / `<UUID>` / `retry-after:<N>` / `<MS>` in place
// of the original tokens, so the SHAPE of the message is preserved for triage.
// The list is enumerated; extend it (with a matching test) when a new noise
// class is observed in the wild.

/** Strip content-variable noise from an authorer error message so the F2
 * fixed-point signature is invariant to cosmetic clock/id churn. Used ONLY as
 * the signature input — the RAW rejection is still surfaced to the writer +
 * the terminal `fragment.authoring.failed` event's `reason` field. */
export function sanitizeAuthorerErrorSignature(errMsg: string): string {
  return (
    errMsg
      // ISO 8601 timestamps (2026-07-07T14:22:41Z, 2026-07-07T14:22:41.123+00:00).
      .replaceAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/gu, "<TIMESTAMP>")
      // UUIDs / request-id shapes (8-4-4-4-12 hex — request_id: 7f3c1a2b-...).
      .replaceAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu, "<UUID>")
      // Retry-After / retry after N (any unit — plain N, N ms, N s, N seconds).
      // Matches `Retry-After: 12`, `retry after 12 seconds`, `retry-after 12s`.
      //
      // Round III H3 (Codex, verified via `node -e`): the trailing single-`s`
      // unit MUST be followed by punctuation / whitespace / end-of-input.
      // Without that constraint, `retry after 12 sockets are open` greedy-matched
      // through the `s` of `sockets`, collapsing every distinct error class of
      // shape `retry after N s <word>` into the same signature. The
      // `(?=[.,;\s\)!]|$)` lookahead pins the unit boundary — regex backtracks
      // to the no-unit match ("retry after 12") when the next char after the
      // unit isn't a boundary.
      .replaceAll(
        /retry[- ]after[:\s]*\d+(?:\.\d+)?\s*(?:milliseconds?|ms|seconds?|sec|s)?(?=[.,;\s)!]|$)/giu,
        "retry-after:<N>",
      )
      // Bare millisecond counters (`took 4200ms`, `elapsed 12.3 ms`).
      //
      // Round III H3 (Codex): `\b` matched `foo-1ms-cache-bar` because `\b`
      // fires at the `-`/digit transition (hyphen is not a word char). That
      // collapsed `foo-1ms-x` and `foo-2ms-x` — legitimately distinct npm
      // package/version pairs — to the same signature. The lookbehind
      // `(?<=^|[\s(\[])` requires the leading digit to be at start-of-string
      // or after whitespace / `(` / `[`, so hyphen-prefixed digits are NOT
      // matched. Zero-width so the leading whitespace is preserved in output.
      .replaceAll(/(?<=^|[\s([])\d+(?:\.\d+)?\s*ms\b/gu, "<MS>")
      // Unix timestamps (10-13 digit numbers — seconds since epoch or ms since epoch).
      // MUST run AFTER the ms counter + timestamp patterns so those are not
      // shredded first. The `\b` bounds keep us from eating substrings of longer
      // identifiers (a git sha is 40 hex chars — bounded away by `\b` + digit-only).
      .replaceAll(/\b\d{10,13}\b/gu, "<UNIX_TS>")
  );
}
