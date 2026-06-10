import type { z } from "zod";
import { CiConfigV1, SUPPORTED_CI_CONFIG_VERSIONS } from "./schema.js";
import type { CiStep, CiWhen } from "./schema.js";
import { CiYamlParseError, parseYaml } from "./yaml.js";

// Loader + resolver for `tanren-ci.yml`. Turns raw YAML text into a validated,
// typed config — or yields the documented default when the file is absent.
// Invalid input ALWAYS throws (never silently degrades to the default) so a
// misconfigured repo fails the gate loudly instead of running an empty tier
// set. This module performs no execution.

// Thrown when YAML parsed cleanly but did not satisfy the schema (e.g. a tier
// with no steps, an unknown `when` value, an unmapped tier). Distinct from
// CiYamlParseError (syntax) so callers can report the two classes separately.
export class CiConfigValidationError extends Error {
  readonly issues: ReadonlyArray<z.core.$ZodIssue>;
  constructor(issues: ReadonlyArray<z.core.$ZodIssue>) {
    const summary = issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ");
    super(`invalid tanren-ci.yml: ${summary}`);
    this.name = "CiConfigValidationError";
    this.issues = issues;
  }
}

export { CiYamlParseError };

// The conventional workspace path a test tier writes its JUnit report to. The
// native gate's per-test ingest (`ingestGateJunit`) reads back EXACTLY this path
// over SSH to feed CI-intelligence (flaky detection + quarantine). A project whose
// `just tier-2` runs tests MUST emit to this path or there is no per-test grain;
// keep this the single source of truth so the writer side and the read side agree.
// The COMMAND that writes it is the project's (inside `just tier-2`) — Tanren names
// no test runner; only the OUTPUT path convention is fixed.
export const JUNIT_REPORT_PATH = "reports/junit.xml";

// The built-in 3-tier default used when a repo ships no `.tanren/ci.yml`. STACK-
// AGNOSTIC: every step defers to `just <target>`, so Tanren names NO tech stack —
// the stack commands live in the project's `justfile` (the project CONTRACT; see
// engine/forge/scaffold/skeleton.ts). The three tiers map 1:1 to the spec-loop's
// lifecycle points:
//   - fast   (per_iteration) — `just tier-1`: the cheap per-iteration gate (e.g.
//     lint + typecheck). NO tests here — tests arrive with features, so a scaffold
//     pass is never blocked by a test tier.
//   - slow   (pre_audit)     — `just tier-2`: build + tests, the tier that DECLARES its
//     JUnit report (`junitReport: JUNIT_REPORT_PATH`) for the CI-intelligence per-test
//     grain — the EXPLICIT contract field, so Tanren reads back exactly that path.
//   - merge  (pre_merge)     — `just tier-3`: the heaviest thorough gate, the
//     merge-queue authority.
// `bootstrap.run` is `just bootstrap`. This default mirrors the skeleton's ci.yml
// (engine/forge/scaffold/skeleton.ts) — both are the same lifecycle map.
export const DEFAULT_CI_CONFIG: CiConfigV1 = Object.freeze(
  CiConfigV1.parse({
    version: 1,
    bootstrap: { run: "just bootstrap" },
    tiers: {
      fast: [{ name: "tier-1", run: "just tier-1" }],
      slow: [{ name: "tier-2", run: "just tier-2", junitReport: JUNIT_REPORT_PATH }],
      merge: [{ name: "tier-3", run: "just tier-3" }],
    },
    when: {
      fast: ["per_iteration"],
      slow: ["pre_audit"],
      merge: ["pre_merge"],
    },
  }),
);

// Parse + validate raw YAML text into a typed config. `undefined` (no file in
// the repo) resolves to DEFAULT_CI_CONFIG. Throws CiYamlParseError on syntax
// errors and CiConfigValidationError on schema violations.
export function resolveCiConfig(yamlText: string | undefined): CiConfigV1 {
  if (yamlText === undefined) {
    return DEFAULT_CI_CONFIG;
  }
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    if (error instanceof CiYamlParseError) {
      throw error;
    }
    throw new CiYamlParseError(error instanceof Error ? error.message : String(error), 0);
  }
  const result = CiConfigV1.safeParse(raw);
  if (!result.success) {
    throw new CiConfigValidationError(result.error.issues);
  }
  return result.data;
}

// ---- Consumer surface ------------------------------------------------------
// Small helpers the in-loop gate and CI poller call. They operate on a
// resolved config so callers never re-derive policy from raw shapes.

// All tier names whose `when` policy includes the given lifecycle point, in a
// stable order (fast, slow, then any extra tiers alphabetically). The gate
// runs these tiers' steps at that point.
export function tiersFor(config: CiConfigV1, when: CiWhen): string[] {
  return orderedTierNames(config).filter((name) => (config.when[name] ?? []).includes(when));
}

// The ordered list of named steps to run at a lifecycle point: every step of
// every tier mapped to `when`, in tier order then step order.
export function stepsFor(config: CiConfigV1, when: CiWhen): CiStep[] {
  return tiersFor(config, when).flatMap((name) => config.tiers[name] ?? []);
}

// The bootstrap/install command, or undefined when the repo declares none.
export function bootstrapCommand(config: CiConfigV1): string | undefined {
  return config.bootstrap?.run;
}

// The DECLARED JUnit report among the tiers mapped to a lifecycle point — the
// EXPLICIT CI-config contract that replaces the old command-string sniff. A step is
// junit-producing iff it sets `junitReport`; the first such step (in tier then step
// order) names the tier + the workspace-relative path the native gate reads back to
// ingest the per-test grain. `undefined` ⇒ no tier at this point declares a report,
// so the ingest is a clean QUIET skip (not an error). When a step DOES declare one but
// the runner produces no report, that is a LOUD `ci.junit_missing` (the gate caller).
// STACK-AGNOSTIC: the path is the project's own declaration; Tanren names no runner.
export function junitReportFor(config: CiConfigV1, when: CiWhen): { tier: string; path: string } | undefined {
  for (const tierName of tiersFor(config, when)) {
    for (const step of config.tiers[tierName] ?? []) {
      if (step.junitReport !== undefined) {
        return { tier: tierName, path: step.junitReport };
      }
    }
  }
  return undefined;
}

function orderedTierNames(config: CiConfigV1): string[] {
  const extras = Object.keys(config.tiers)
    .filter((name) => name !== "fast" && name !== "slow")
    .sort((a, b) => a.localeCompare(b));
  return ["fast", "slow", ...extras];
}

export { SUPPORTED_CI_CONFIG_VERSIONS };
