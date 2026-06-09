// Lenient governance posture → advisory gate steps.
//
// The apex doctrine (docs/operator-guide/apex.md: functional-but-weak — broken
// code lands and improves over iterations; the strict gate must not permanently
// stall an autonomous build) needs a posture where the FIRST-PASS quality tier
// does not hard-block the loop. Under the `lenient` posture, the cheap
// per-iteration `tier-1` step's failure is ADVISORY: the failing step is still
// executed and its outcome recorded (a `gate.advisory_failed` warning event), but
// it does NOT fail the gate or trigger a planner rerun. `tier-2` / `tier-3` (build
// + tests) stay BLOCKING — a tree that does not build or whose tests fail is
// genuinely broken and must route to rework.
//
// Every other posture (strict / open / audit_only, and absent ⇒ strict default)
// yields an EMPTY advisory set, so every step blocks exactly as before. This is an
// EXPLICIT, configured advisory (only when `governancePosture: "lenient"`), never
// a silent fallback.

import type { GovernancePosture } from "../../config/shared.js";

// The step NAMES treated as advisory under the lenient posture. Matched against
// the CI tier's step `name` (per the stack-agnostic 3-tier DEFAULT_CI_CONFIG:
// `tier-1` in the fast tier, `tier-2`/`tier-3` in the slow + merge tiers). The
// cheap per-iteration `tier-1` (lint/typecheck-class first-pass quality) is
// advisory; `tier-2`/`tier-3` (build + tests) are never advisory — a tree that
// won't build or whose tests fail is genuinely broken. A repo that names its steps
// `lint`/`typecheck` (its own `.tanren/ci.yml`) keeps those advisory too.
const LENIENT_ADVISORY_STEP_NAMES: ReadonlySet<string> = new Set(["tier-1", "lint", "typecheck"]);

// The advisory (warn-but-don't-block) step names for a governance posture. Only
// `lenient` yields a non-empty set; every other posture (incl. the strict default)
// yields the empty set so every step blocks, behavior-identical to before lenient
// existed.
export function advisoryStepNamesForPosture(posture: GovernancePosture | undefined): ReadonlySet<string> {
  return posture === "lenient" ? LENIENT_ADVISORY_STEP_NAMES : EMPTY_ADVISORY_SET;
}

const EMPTY_ADVISORY_SET: ReadonlySet<string> = new Set<string>();
