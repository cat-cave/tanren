// Canonicalize a fragment body for the writer-rework loop's fixed-point signature
// (audit finding H1 — task #150).
//
// The F2 writer-rework loop halts at a FIXED POINT: identical body + identical
// rejection ⇒ no progress. A naive `hash(bodyTs)` treats whitespace/comment
// changes as progress, so a stubborn writer that adds a trailing space every
// attempt burns credits unbounded. The signature MUST be invariant to cosmetic
// changes so the fixed-point detector can catch the loop.
//
// This helper produces a canonical fingerprint two ways, both invariant to
// cosmetic edits:
//
//   STRUCTURAL (preferred): if `parseFragmentBody` accepts the body, the
//   canonical form is the parsed `FragmentOp[]` list — JSON-stringified. Two
//   bodies that differ in whitespace, comments, imports, or the (unused) module
//   scaffolding yield the SAME ops sequence ⇒ SAME hash. This is the ideal
//   fingerprint because it names the semantic content.
//
//   LEXICAL (fallback): when the body is un-parseable (the common failure mode
//   at the writer's early attempts — the writer produces something the
//   constrained-subset parser rejects), we strip block + line comments, collapse
//   whitespace runs to a single space, and strip trailing commas. Two bodies
//   that differ only in cosmetic details still hash identically ⇒ the loop
//   detects the fixed point ⇒ credit-burn is bounded by real semantic changes.
//
// The signature is combined with the rejection string by `authorOneFragment`,
// so identical canonical body + identical rejection still means "no progress".

import { createHash } from "node:crypto";

import { parseFragmentBody } from "./unifiedLibrary.js";

/** Canonicalize a fragment body so cosmetic changes hash identically. Returns a
 * stable string derived from the body's semantic content (parsed ops) when
 * possible, else from a lexically normalized form. */
export function canonicalizeBodySignature(bodyTs: string): string {
  try {
    const ops = parseFragmentBody(bodyTs);
    return `ops:${hashish(JSON.stringify(ops))}`;
  } catch {
    return `raw:${hashish(lexicallyNormalize(bodyTs))}`;
  }
}

/** Strip block + line comments, collapse whitespace runs, strip trailing commas.
 * Exposed for tests; the fixed-point detector calls it via
 * `canonicalizeBodySignature`. */
export function lexicallyNormalize(bodyTs: string): string {
  return (
    bodyTs
      // Block comments — non-greedy so `/* a */ code /* b */` strips both.
      .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
      // Line comments — to end of line (stripped BEFORE whitespace collapse so
      // `// tail` at end-of-line vanishes cleanly).
      .replaceAll(/\/\/[^\n]*/gu, "")
      // Trailing commas inside `(...)` / `[...]` / `{...}` — invariant to
      // `a, b,)` vs `a, b)`.
      .replaceAll(/,\s*([)\]}])/gu, "$1")
      // Collapse consecutive whitespace (including newlines) to a single space.
      .replaceAll(/\s+/gu, " ")
      .trim()
  );
}

/** Stable hash for signature comparison. Uses SHA-256 (via node:crypto) so
 * that two DIFFERENT canonical forms are never collision-equal — the prior
 * multiplicative rolling hash overflowed to a fixed point on longish bodies
 * and silently equated distinct inputs, which would defeat the fixed-point
 * detector by claiming semantic progress was noise. */
export function hashish(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
