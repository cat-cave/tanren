// THE FAILURE-SIGNATURE CANONICALIZER (forward-looking-audit finding #14, the
// hardening layer behind the convergence detector).
//
// THE BUG WE CLOSE. `subtaskInnerLoop.ts`'s inner loop keys its `AttemptSignature.
// failureSignature` on the RAW `rejectionReason` — and `rejectionReason` is built
// from `gateReason` (the captured tier/step output tail), the checker's
// `decision.reason` (the checker's narrated incompleteness), and `writerFailureReason`.
// ALL THREE carry incidental nondeterminism that has nothing to do with the
// underlying failure: ANSI color escapes, tool-reported durations ("12s", "1.4 min",
// "(123 ms)"), wall-clock timestamps (ISO 8601, `12:34:56`), run/task/spec UUID
// references, vitest's trailing "Test Files / Tests / Duration / Start at" summary
// block whose counts + duration shift attempt-over-attempt even when the underlying
// failures are byte-identical, and content-addressed hashes (commit shas, run hashes).
//
// THE FAILURE MODE. The convergence detector treats two-different-hashes-but-same-
// failure as "different failure → progress" and KEEPS RE-DRIVING — silently — even
// though the writer is making no actual headway. v64-class scope drift is fixed by
// PR #704 on a different axis (writer-prompt mode-awareness), but THIS canonicalization
// gap is the load-bearing safety net behind it: any other failure shape with
// nondeterministic output (auditor entity-risk counts, checker counts mixed with tool
// durations, gate-step output tails with timestamps) still defeats the detector.
//
// THE FIX. Canonicalize the raw reason BEFORE it is hashed into `failureSignature`,
// stripping the specific nondeterminism classes that defeat equality. The ORIGINAL
// `rejectionReason` is still surfaced verbatim — to the writer as steering, and to
// the residual P0 finding's `body` for the human reading the timeline. Only the
// COMPARISON KEY (the convergence detector's structural identity) flows through here.
//
// CONSERVATIVE POLICY (the task brief's explicit guidance). When in doubt, over-strip
// durations / timestamps / IDs rather than under-strip them: a spuriously-collapsed
// signature only causes the loop to halt one round early on a fixed point that was
// truly a fixed point under any reasonable comparison, while an under-stripped one
// silently lets the loop spin forever. We DO NOT strip bare numbers — error counts
// are MEANINGFUL (the 1000 → 500 → 100 → 1 trajectory is the trajectory-aware
// progress signal the detector reads), so collapsing them would convert real progress
// into a false fixed point.

// ANSI CSI escapes (color codes, cursor moves): ESC `[` digits-and-semis terminator-letter.
// The control-character matches (ESC \u{1B}, BEL \u{07}) are INTENTIONAL — stripping the
// raw bytes a TTY-aware tool emits is the whole point of this pass — so the
// `no-control-regex` rule is disabled for the ANSI regex block.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\u{1B}\[[0-9;?]*[A-Za-z]/gu;
// ANSI OSC escapes (titles, hyperlinks): ESC `]` payload BEL-or-ST.
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\u{1B}\][^\u{07}\u{1B}]*(?:\u{07}|\u{1B}\\)/gu;
// Bare ESC stragglers (defense in depth, never expected to fire post-CSI/OSC).
// eslint-disable-next-line no-control-regex
const ANSI_STRAY_ESC = /\u{1B}/gu;

// Vitest's trailing summary block — the "Test Files / Tests / Snapshots / Start at /
// Duration / RERUN" lines whose counts (passed | failed) + wall-clock + duration differ
// run-over-run even when the underlying test failures are byte-identical. Match WHOLE
// LINES so the placeholder lives where the line did (preserving surrounding context).
const VITEST_SUMMARY_LINE = /^[ \t]*(?:Test Files|Tests|Snapshots|Start at|Duration|RERUN)\s.*$/gmu;

// UUIDs in any of the canonical hyphenated forms (lowercase, uppercase, mixed).
const UUID = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/gu;

// Prefixed engine IDs: `run_<...>`, `task_<...>`, `spec_<...>`, `job_<...>`,
// `attempt_<...>`, `workflow_<...>`, `build_<...>`, `deploy_<...>`, `req_<...>`,
// `request_<...>`, `sess_<...>`, `session_<...>`, `trace_<...>`. We KEEP the
// prefix (it carries semantic information — a run-id reference is different from a
// spec-id reference) and replace just the id suffix. The id is taken to be a run
// of id-safe characters (letters, digits, `-`, `_`) of length >= 4 so we never
// match plain English words ("run_now", "spec_v1", etc., short of 4 chars).
const PREFIXED_ID =
  /\b(run|task|spec|job|attempt|workflow|build|deploy|req|request|sess|session|trace)_[A-Za-z0-9_-]{4,}/gu;

// ISO 8601 timestamps — `2026-06-28T12:34:56.789Z` and offsets `+02:00`/`-0500`. Also
// the space-separated form `2026-06-28 12:34:56` that some tools emit. ORDER: match
// the full timestamp FIRST so the date / time sub-patterns below do not eat halves.
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/gu;
// Date-only `2026-06-28` (run AFTER `ISO_TIMESTAMP`, so a full timestamp's date is gone).
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/gu;
// Wall-clock time `12:34:56` / `12:34:56.789` (NOT mm:ss — that's the duration class).
const WALL_TIME = /\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/gu;

// Durations carrying an explicit unit. Covers ms / µs / us / ns / s / sec(s|ond|onds) /
// m / min(s|ute|utes) / h / hr(s) / hour(s). Word-bounded so a unit suffix on a
// non-numeric token (e.g. `claims` ending in `s`) is never matched.
const DURATION_UNIT = /\b\d+(?:[.,]\d+)?\s*(?:ms|µs|us|ns|sec(?:ond)?s?|s|min(?:ute)?s?|m|hours?|hrs?|h)\b/giu;
// Parenthesized duration `(123 ms)` — keep the parens visible (they carry layout
// the surrounding text may still depend on for shape equality).
const PARENS_DURATION = /\(\s*\d+(?:[.,]\d+)?\s*(?:ms|µs|us|ns|sec(?:ond)?s?|s|min(?:ute)?s?|m|hours?|hrs?|h)\s*\)/giu;
// mm:ss elapsed (e.g. "15:23") when NOT preceded by a digit (which would suggest a
// fragment of a date or a wall-time we already matched). Two segments only (no third
// `:ss`) so we don't double-match `WALL_TIME`.
const MMSS_DURATION = /(?<!\d:)\b\d{1,3}:\d{2}\b(?!:\d{2})/gu;

// Long content-addressed hex blobs (commit shas, sha256, run hashes). 12+ hex chars
// is well above any meaningful short numeric we want to preserve. Word-bounded both
// sides so embedded text isn't matched mid-token.
const LONG_HEX = /\b[0-9a-f]{12,}\b/giu;
// Pointer-shaped `0x...` (any length).
const POINTER_HEX = /\b0x[0-9a-fA-F]+\b/gu;

// Whitespace-normalization passes (collapse runs / trim per-line).
const RUN_OF_SPACES = /[ \t]+/gu;
const RUN_OF_NEWLINES = /\n{2,}/gu;
const LINE_EDGES = /^[ \t]+|[ \t]+$/gmu;

// Each strip pass replaces its match with a single STABLE placeholder so the
// canonicalized text is itself a readable diagnostic (a human inspecting the hash
// pre-image can still see WHERE a duration / timestamp / id used to sit). The
// placeholders are spelled so two different categories never collide ("<dur>" ≠
// "<ts>" ≠ "<id>") and so a placeholder in one site cannot be confused with the
// surrounding plain-text content.
const PLACEHOLDER = {
  ansi: "",
  vitestSummary: "<vitest-summary>",
  uuid: "<uuid>",
  prefixedId: "<id>",
  isoTimestamp: "<ts>",
  isoDate: "<date>",
  wallTime: "<time>",
  duration: "<dur>",
  longHex: "<hex>",
  pointerHex: "<ptr>",
} as const;

/**
 * Canonicalize a raw rejection-reason string into a STABLE comparison key suitable for
 * the convergence detector's `failureSignature`. Two SEMANTICALLY-IDENTICAL reasons
 * that differ only in ANSI escapes, timestamps, durations, run/task/spec id
 * references, vitest's trailing summary block, or content-addressed hex blobs
 * canonicalize to the SAME string — so the detector's structural read sees them as
 * the same state (and a TRULY DIFFERENT failure still hashes differently because its
 * substantive text differs).
 *
 * PURE (no I/O, no clock); the placeholders are stable across calls. Empty input
 * returns `""` so the upstream "no rejection text" path is preserved.
 *
 * ORDER OF OPERATIONS is load-bearing — see the top-of-file comment block for the
 * conservative-strip policy; the order below is the result of that policy:
 *
 *   1. ANSI escapes first (so the residual text the later passes scan is plain).
 *   2. Vitest summary lines (whole-line replace — preempts the date/time sub-strips
 *      from punching holes in those lines while leaving the rest of the body).
 *   3. UUIDs (anywhere; would otherwise be partly matched by the hex passes).
 *   4. Prefixed engine IDs (`run_<...>`, etc. — keep the prefix, replace the id).
 *   5. Full ISO timestamps (before the date / time sub-strips so we don't bisect).
 *   6. Date-only / wall-time-only stragglers.
 *   7. Duration classes (parenthesized → bare → mm:ss; the parens variant is the
 *      most specific and must run first).
 *   8. Long-hex / pointer-hex (last; short error counts are deliberately preserved).
 *
 * Finally, whitespace is normalized: runs of tabs/spaces collapse to a single space,
 * runs of newlines collapse to a single newline, and per-line leading/trailing
 * whitespace is trimmed. Whitespace differences are themselves a class of incidental
 * nondeterminism (tools align columns differently across runs).
 */
export function canonicalizeFailureSignature(raw: string): string {
  if (raw === "") return "";
  let s = raw;
  // (1) ANSI noise.
  s = s.replaceAll(ANSI_CSI, PLACEHOLDER.ansi);
  s = s.replaceAll(ANSI_OSC, PLACEHOLDER.ansi);
  s = s.replaceAll(ANSI_STRAY_ESC, PLACEHOLDER.ansi);
  // (2) Vitest summary lines — whole-line replace before any sub-pattern bites them.
  s = s.replaceAll(VITEST_SUMMARY_LINE, PLACEHOLDER.vitestSummary);
  // (3) UUIDs anywhere.
  s = s.replaceAll(UUID, PLACEHOLDER.uuid);
  // (4) Prefixed engine ids — preserve the prefix, replace the id portion.
  s = s.replaceAll(PREFIXED_ID, (_match, prefix: string) => `${prefix}_${PLACEHOLDER.prefixedId}`);
  // (5)–(6) Timestamps then date/time stragglers.
  s = s.replaceAll(ISO_TIMESTAMP, PLACEHOLDER.isoTimestamp);
  s = s.replaceAll(ISO_DATE, PLACEHOLDER.isoDate);
  s = s.replaceAll(WALL_TIME, PLACEHOLDER.wallTime);
  // (7) Duration classes — parens first (most specific), then bare unit, then mm:ss.
  s = s.replaceAll(PARENS_DURATION, `(${PLACEHOLDER.duration})`);
  s = s.replaceAll(DURATION_UNIT, PLACEHOLDER.duration);
  s = s.replaceAll(MMSS_DURATION, PLACEHOLDER.duration);
  // (8) Hex blobs / pointers (after the structured ids, so a `run_<uuid>` hex
  // segment isn't double-touched).
  s = s.replaceAll(LONG_HEX, PLACEHOLDER.longHex);
  s = s.replaceAll(POINTER_HEX, PLACEHOLDER.pointerHex);
  // Whitespace normalization.
  s = s.replaceAll(RUN_OF_SPACES, " ");
  s = s.replaceAll(RUN_OF_NEWLINES, "\n");
  s = s.replaceAll(LINE_EDGES, "");
  return s.trim();
}
