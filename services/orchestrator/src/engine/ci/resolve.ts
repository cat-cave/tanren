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

// The conventional workspace path the test tier writes its JUnit report to. The
// native gate's per-test ingest (`ingestGateJunit`) reads back EXACTLY this path
// over SSH to feed CI-intelligence (flaky detection + quarantine). The generated
// `.tanren/ci.yml` test step MUST emit to this path or there is no per-test grain;
// keep this the single source of truth so the writer side and the read side agree.
export const JUNIT_REPORT_PATH = "reports/junit.xml";

// The vitest JUnit reporter invocation the generated test tiers use, writing to
// JUNIT_REPORT_PATH so the native per-test ingest can read it back. Domain-default
// (vitest is the scaffold toolchain); a repo with another runner overrides its own
// `.tanren/ci.yml`, but the OUTPUT path convention is fixed.
export const JUNIT_TEST_RUN = `pnpm test --reporter=junit --outputFile=${JUNIT_REPORT_PATH}`;

// The built-in 3-tier default used when a repo ships no `.tanren/ci.yml`. The three
// tiers map 1:1 to the spec-loop's lifecycle points (the spec-loop-redesign 3-tier
// CI requirement):
//   - fast   (per_iteration) — tier-1: lint + typecheck. CHEAP, runs after every
//     writer iteration. NO tests here — tests arrive with features, so a scaffold
//     pass is never blocked by a test tier.
//   - slow   (pre_audit)     — tier-2: build + tests, emitting JUnit evidence (the
//     CI-intelligence per-test grain). Runs once at spec completion before the audit.
//   - merge  (pre_merge)     — tier-3: the heaviest, thorough gate — a clean full
//     lint + typecheck + build + tests run, the merge-queue authority.
// `unit`-as-a-cheap-test in the fast tier is GONE: tests are tier-2+ only.
export const DEFAULT_CI_CONFIG: CiConfigV1 = Object.freeze(
  CiConfigV1.parse({
    version: 1,
    bootstrap: { run: "pnpm install --frozen-lockfile" },
    tiers: {
      fast: [
        { name: "lint", run: "pnpm lint" },
        { name: "typecheck", run: "pnpm typecheck" },
      ],
      slow: [
        { name: "build", run: "pnpm build" },
        { name: "test", run: JUNIT_TEST_RUN },
      ],
      merge: [
        { name: "lint", run: "pnpm lint" },
        { name: "typecheck", run: "pnpm typecheck" },
        { name: "build", run: "pnpm build" },
        { name: "test", run: JUNIT_TEST_RUN },
      ],
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

function orderedTierNames(config: CiConfigV1): string[] {
  const extras = Object.keys(config.tiers)
    .filter((name) => name !== "fast" && name !== "slow")
    .sort((a, b) => a.localeCompare(b));
  return ["fast", "slow", ...extras];
}

export { SUPPORTED_CI_CONFIG_VERSIONS };
