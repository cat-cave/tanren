// Environment management (environment-management.md §4 + §7 P4) — the ENV-IMAGE
// negative-control PLAN, the env-layer counterpart of `templates/negativeControls.ts`.
//
// A code-template negative control plants a DEFECT in a scratch copy and asserts the
// gate CATCHES it. An ENV negative control is the ISOLATION analogue: it probes the
// freshly-built env image and asserts the env is genuinely ISOLATED from the golden
// base it was built FROM. Two controls, both non-optional:
//
//   1. UNDECLARED-TOOL-ABSENT — pick a tool the project did NOT declare AND that the
//      golden baseline DID warm (so the env, having FROMed the golden base, is at
//      real risk of leaking it). Assert that tool does NOT resolve through the
//      project's mise toolchain (`mise which <tool>` fails / `mise exec -- <tool>
//      --version` is non-zero). A LEAKED env (the baseline tool still resolves) makes
//      this `unproven` → validation FAILS. This is the env-layer of "a Python-only
//      env must fail to find a stray global Node".
//
//   2. FORBIDDEN-VERSION-ABSENT — pick a DECLARED tool and a WRONG version of it (a
//      version-spec the project did NOT lock). Assert the env does NOT resolve that
//      wrong version (mise resolves the LOCKED version, never a forbidden one). A
//      version-leaky env makes this `unproven` → validation FAILS.
//
// STACK-AGNOSTIC: the controls are derived from the PROJECT's declared toolchain +
// the golden baseline (both data), never a hardcoded stack. A project that declares
// EVERY baseline tool has no baseline tool left to probe for control 1 — the planner
// then probes a NON-baseline sentinel tool that no env should ever resolve, so the
// isolation control is never silently skipped.

import { GOLDEN_BASELINE_TOOLCHAIN } from "../baselineCoverage.js";
import type { ProjectToolchain } from "../../config/projectConfig.js";

// A sentinel tool NEITHER the golden baseline warms NOR a typical project declares —
// used for control 1 when the project happens to declare every baseline tool (so
// there is no baseline tool left to probe). No env should EVER resolve this; a
// resolvable sentinel means the env image is contaminated. `cobol` is a deliberate,
// obviously-absent choice (Tanren privileges no stack; it is just a name that must
// not resolve in a node/python/go/rust env).
const ABSENT_SENTINEL_TOOL = "cobol";

// One env-image negative control: a tool to probe + the version-spec it is probed at
// (absent for the undeclared-tool control — it must not resolve AT ALL) + the human
// description recorded on an `unproven` verdict so a leak names exactly what leaked.
export interface EnvNegativeControl {
  // The capability this control proves on the proof (`undeclaredToolAbsent` /
  // `forbiddenVersionAbsent`).
  capability: "undeclaredToolAbsent" | "forbiddenVersionAbsent";
  // The tool to probe (its mise tool name).
  tool: string;
  // For `forbiddenVersionAbsent`: the WRONG version-spec that must NOT resolve. Absent
  // for `undeclaredToolAbsent` (the tool must not resolve at ANY version).
  forbiddenVersion?: string;
  // Recorded on an `unproven` verdict (the leak diagnosis).
  description: string;
}

// The plan: exactly the two isolation controls. Built from the project's declared
// toolchain + the golden baseline.
export interface EnvNegativeControlPlan {
  undeclaredTool: EnvNegativeControl;
  forbiddenVersion: EnvNegativeControl;
}

// Pick the UNDECLARED tool to probe for control 1: a tool the golden BASELINE warmed
// but the project did NOT declare (the leak that actually matters — the env FROMed a
// base that has it). Falls back to the sentinel when the project declares every
// baseline tool (nothing baseline-shaped left to probe — but isolation must STILL be
// proven, so we probe a tool no env should ever have).
function pickUndeclaredTool(toolchain: ProjectToolchain): EnvNegativeControl {
  for (const baselineTool of Object.keys(GOLDEN_BASELINE_TOOLCHAIN)) {
    if (!(baselineTool in toolchain)) {
      return {
        capability: "undeclaredToolAbsent",
        tool: baselineTool,
        description: `undeclared baseline tool "${baselineTool}" must NOT resolve in this env (golden-base leakage)`,
      };
    }
  }
  // The project declared every baseline tool — probe the never-present sentinel so the
  // isolation control still runs (never silently `n/a`).
  return {
    capability: "undeclaredToolAbsent",
    tool: ABSENT_SENTINEL_TOOL,
    description: `sentinel tool "${ABSENT_SENTINEL_TOOL}" must NOT resolve in any env (contamination check)`,
  };
}

// Compute a FORBIDDEN version-spec for a declared tool: a spec the project did NOT
// lock, so mise must NOT resolve it. We derive it from the declared spec so it is
// always genuinely different (and obviously wrong): prefix `0.` onto the declared
// spec yields a version that does not exist for any real tool (`0.24`, `0.3.13`),
// guaranteeing a real env rejects it while a version-leaky env might resolve a stray
// global. Tanren parses no semver — it just needs a spec the project DID NOT declare.
function forbiddenVersionFor(declaredSpec: string): string {
  return `0.${declaredSpec.trim()}`;
}

// Pick the DECLARED tool + a forbidden version of it for control 2. Uses the first
// declared tool (sorted for determinism). A project with NO declared tools never
// reaches the JIT-build path (an empty toolchain short-circuits to the golden base),
// so this is always called with at least one tool — but we guard with the sentinel
// to stay total (a forbidden sentinel version that must not resolve either).
function pickForbiddenVersion(toolchain: ProjectToolchain): EnvNegativeControl {
  const tools = Object.keys(toolchain).sort();
  const tool = tools[0];
  if (tool === undefined) {
    return {
      capability: "forbiddenVersionAbsent",
      tool: ABSENT_SENTINEL_TOOL,
      forbiddenVersion: "0.0.0",
      description: `forbidden version of sentinel "${ABSENT_SENTINEL_TOOL}" must NOT resolve`,
    };
  }
  const declaredSpec = toolchain[tool] ?? "";
  const forbiddenVersion = forbiddenVersionFor(declaredSpec);
  return {
    capability: "forbiddenVersionAbsent",
    tool,
    forbiddenVersion,
    description: `forbidden version "${forbiddenVersion}" of declared tool "${tool}" (locked "${declaredSpec}") must NOT resolve`,
  };
}

/**
 * Build the two isolation negative controls for an env image from the project's
 * declared toolchain + the golden baseline. ALWAYS returns both controls (never an
 * empty/optional plan — isolation is non-optional): one undeclared-tool-absent probe
 * + one forbidden-version-absent probe.
 */
export function buildEnvNegativeControlPlan(toolchain: ProjectToolchain): EnvNegativeControlPlan {
  return {
    undeclaredTool: pickUndeclaredTool(toolchain),
    forbiddenVersion: pickForbiddenVersion(toolchain),
  };
}

export { ABSENT_SENTINEL_TOOL };
