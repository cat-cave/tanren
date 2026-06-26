// THE CURATED-TEMPLATE REGISTRY (matrix-hit routing — docs/roadmap/templating-system.md
// §FRAGMENTS / PR-C). Maps a free-form stack label (the operator's `lifecycle.stack`,
// e.g. "ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io") to a CURATED
// `TemplateConfig` the composer (compose.ts) assembles deterministically.
//
// WHY: PR-A built the deterministic 9-phase composer; PR-B hardened the fragments with
// real behavior tie-ins. PR-C is the LIVE DECISION-POINT WIRING — `selectSeedTemplate`
// (forge/interview/interviewTemplateGate.ts) checks this registry FIRST. A hit yields a
// `compose-from-fragments` decision (the new variant); the agent template-build path
// (the slow research → author → build → validate loop) runs ONLY on a true miss.
//
// CANONICALIZATION. The lookup key is the operator's free-form stack label, so two
// cosmetically-different requests for the SAME stack must hit the same entry. We
// normalize: lowercase + collapse any run of non-`[a-z0-9.]` characters into a single
// space + trim. Periods stay (so "fly.io" remains one token); pluses, slashes,
// punctuation collapse to spaces. The canonical form is comparison-only — never
// rendered to the user.
//
// EVERY entry inherits the base/ fragment's non-negotiable Tanren opinions (green CI,
// behavior tie-ins, functional demo, mutation testing) by construction — the composer's
// `assertBaseInvariantsHeld` re-checks them after compose. A curated entry CANNOT
// opt out (no knob exists; the base/ surface is structural).

import type { TemplateConfig } from "../types.js";
import { CURATED_TEMPLATES } from "./curated.js";

/**
 * A curated matrix-hit entry. `id` is the stable, opaque key (used in audit + tests);
 * `stack` is the human-readable stack label the lookup matches against (canonicalized
 * at compare time); `config` is the complete `TemplateConfig` the composer will run
 * through `composeTemplate`.
 *
 * Two entries MUST NOT share a canonicalized `stack` (the registry rejects duplicates
 * at load time so a typo cannot silently shadow an earlier entry).
 */
export interface CuratedTemplate {
  /** Stable, opaque id (the audit / observability key). */
  readonly id: string;
  /** Human stack label (canonicalized at compare time). */
  readonly stack: string;
  /** The composer input — a complete, valid `TemplateConfig`. */
  readonly config: TemplateConfig;
}

/**
 * Canonicalize a stack label so two cosmetically-different requests for the same
 * stack hit the same entry. Lowercase + collapse non-`[a-z0-9.]` to single spaces +
 * trim. Comparison-only — never user-rendered.
 *
 * Examples:
 *   "ts/pnpm + React Router + Prisma + PostgreSQL on Fly.io"
 *     → "ts pnpm react router prisma postgresql on fly.io"
 *   "TS / PNPM + React-Router + Prisma + PostgreSQL on Fly.io  "
 *     → "ts pnpm react router prisma postgresql on fly.io"
 */
export function canonicalizeStack(stack: string): string {
  return stack
    .toLowerCase()
    .replaceAll(/[^a-z0-9.]+/gu, " ")
    .trim();
}

// Build the canonical-key index ONCE at module load. A duplicate canonical key is a
// LOUD failure (two entries claiming the same stack — a copy-paste bug) — re-thrown at
// every `lookupCurated`/`listCurated` call so the misconfiguration is impossible to
// ignore. Lazy + memoized so test edits to the curated module re-run the duplicate
// check on the first call after import.
let indexCache: ReadonlyMap<string, CuratedTemplate> | undefined;
let indexError: Error | undefined;

function buildIndex(): ReadonlyMap<string, CuratedTemplate> {
  const out = new Map<string, CuratedTemplate>();
  for (const entry of CURATED_TEMPLATES) {
    const key = canonicalizeStack(entry.stack);
    if (key === "") {
      throw new Error(`CuratedTemplate "${entry.id}" has an empty stack key after canonicalization`);
    }
    if (out.has(key)) {
      const prior = out.get(key);
      throw new Error(
        `CuratedTemplate duplicate canonical stack "${key}" — "${entry.id}" collides with ` +
          `"${prior?.id ?? "<unknown>"}". A canonical stack uniquely identifies a matrix entry.`,
      );
    }
    out.set(key, entry);
  }
  return out;
}

function getIndex(): ReadonlyMap<string, CuratedTemplate> {
  if (indexError !== undefined) {
    // Re-throw the captured load-time error so every subsequent lookup keeps surfacing it.
    throw new Error(`CuratedTemplate index failed to load: ${indexError.message}`, { cause: indexError });
  }
  try {
    if (indexCache === undefined) indexCache = buildIndex();
    return indexCache;
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    indexError = new Error(msg, { cause });
    throw new Error(msg, { cause });
  }
}

/**
 * Find a curated template for a free-form stack label. Canonicalizes the input + the
 * registry entries so cosmetic differences (case, whitespace, punctuation) do not
 * cause a miss. Returns `undefined` on a true miss (the caller falls through to the
 * org-registry / agent template-build path).
 */
export function lookupCurated(stack: string): CuratedTemplate | undefined {
  const key = canonicalizeStack(stack);
  if (key === "") return undefined;
  return getIndex().get(key);
}

/**
 * Every curated template, in stable id order. Used by tests + observability surfaces
 * that enumerate the matrix-hit catalog (e.g. "which stacks short-circuit the agent
 * template-build?"). Stable across calls so the snapshot test is deterministic.
 */
export function listCurated(): readonly CuratedTemplate[] {
  return [...getIndex().values()].sort((a, b) => a.id.localeCompare(b.id));
}

// Re-export the curated list source so tests + observability can import either name.
export { CURATED_TEMPLATES } from "./curated.js";
