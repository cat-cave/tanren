// FRAGMENT CROSS-RUNTIME MISMATCH HARNESS (task #72 —
// docs/roadmap/templating-system.md §FRAGMENTS).
//
// Pre-task-#72 the composer SILENTLY accepted a cross-runtime mismatch: a
// `config.runtime = ruby-bundler` paired with `frontend-react-router` (which
// declares `dependsOn: [runtime-node-pnpm]`) composed without throwing because
// `addPackageJsonDep` / `addPackageJsonDevDep` land in an internal map and
// `processDeps` early-returns when `!vfs.has("package.json")` — node-only deps
// were silently dropped. The matrix-coverage harness's
// `INCOMPATIBLE_COMBINATIONS` list was a "skip these" workaround.
//
// Task #72 made the composer pre-flight the cross-runtime dependsOn graph (see
// `dependencyRuntimeCheck.ts` + the `composeTemplate` call site) and throw
// `TemplateComposeError("dependency_runtime_mismatch", ...)` with a structured
// `payload` naming { fragmentId, requiredRuntime, activeRuntime }. The list is
// now a "MUST throw" assertion: this harness drives every excluded combo through
// the composer + asserts the deterministic throw + payload shape.
//
// PER-ENTRY ASSERTIONS:
//   a) compose throws `TemplateComposeError` (no silent acceptance).
//   b) `.phase === "dependency_runtime_mismatch"` (the new phase discriminator).
//   c) `.fragmentId` names the FIRST fragment the pre-flight encounters in
//      compose-phase order (`pickFirstMatchingRule` mirrors this).
//   d) `.payload` is the well-formed `DependencyRuntimeMismatchPayload`:
//      `payload.fragmentId === <expected>`, `payload.requiredRuntime ===
//      <expected>`, `payload.activeRuntime === "runtime-<config.runtime>"`.
//   e) the message names "dependsOn" so a glob over CI logs catches the class.
//
// The matrix-coverage harness (`templateFragmentMatrixCoverage.test.ts`) keeps
// FILTERING these out of its "compose cleanly" loop using the shared
// `isIncompatibleCombination` predicate. The two harnesses read the SAME
// `INCOMPATIBLE_COMBINATIONS` list (via `tests/helpers/templateFragmentIncompatibles.ts`)
// so a new runtime-dependent fragment registers ONE entry and both pick it up.

import { describe, expect, it } from "vitest";
import {
  composeTemplate,
  loadFragmentLibrary,
  TemplateComposeError,
  type TemplateConfig,
} from "../src/engine/templates/index.js";
import {
  INCOMPATIBLE_COMBINATIONS,
  type NormalizedCombo,
  pickFirstMatchingRule,
} from "./helpers/templateFragmentIncompatibles.js";

/** Throw a descriptive error so the failing test names the combo + broken
 * invariant. Centralized so every failure message in this file uses the same shape. */
function fail(message: string): never {
  throw new Error(message);
}

/** Build a minimal NormalizedCombo that triggers a specific INCOMPATIBLE_COMBINATIONS
 * rule. The rule names the offending fragment; we place it in the right slot, set
 * the active runtime to the OPPOSITE of the rule's `requiredRuntime`, and leave
 * every other axis empty so the combo exercises ONE mismatch at a time. */
function comboForRule(rule: (typeof INCOMPATIBLE_COMBINATIONS)[number]): NormalizedCombo {
  // Today the only `requiredRuntime` is `runtime-node-pnpm`; the only opposite
  // runtime is `ruby-bundler`. A future runtime axis (rust-cargo, go-mod) will
  // surface here as a missing case; the new test would fail loud.
  const opposite = rule.requiredRuntime === "runtime-node-pnpm" ? "ruby-bundler" : "node-pnpm";
  const base: NormalizedCombo = { runtime: opposite, deploy: "none", addons: [], examples: [] };
  switch (rule.phase) {
    case "frontend":
      return { ...base, frontend: rule.fragmentId.replace(/^frontend-/u, "") };
    case "backend":
      return { ...base, backend: rule.fragmentId.replace(/^backend-/u, "") };
    case "db":
      return { ...base, db: rule.fragmentId.replace(/^db-/u, "") };
    case "auth":
      return { ...base, auth: rule.fragmentId.replace(/^auth-/u, "") };
    case "addon":
      return { ...base, addons: [rule.fragmentId.replace(/^addon-/u, "")] };
    case "example":
      return { ...base, examples: [rule.fragmentId.replace(/^example-/u, "")] };
    case "deploy":
      return { ...base, deploy: rule.fragmentId.replace(/^deploy-/u, "") };
    default:
      throw new Error(`comboForRule: rule.phase="${rule.phase}" has no slot to place "${rule.fragmentId}".`);
  }
}

function comboToConfig(combo: NormalizedCombo, slug: string): TemplateConfig {
  return {
    slug,
    runtime: combo.runtime,
    ...(combo.frontend === undefined ? {} : { frontend: combo.frontend }),
    ...(combo.backend === undefined ? {} : { backend: combo.backend }),
    ...(combo.db === undefined ? {} : { db: combo.db }),
    ...(combo.auth === undefined ? {} : { auth: combo.auth }),
    deploy: combo.deploy,
    addons: [...combo.addons],
    examples: [...combo.examples],
  };
}

interface MismatchAssertion {
  readonly expectedFragmentId: string;
  readonly expectedRequiredRuntime: string;
  readonly expectedActiveRuntime: string;
  readonly captured: TemplateComposeError;
}

async function captureCompose(config: TemplateConfig): Promise<unknown> {
  const library = loadFragmentLibrary();
  try {
    await composeTemplate(config, library);
  } catch (err) {
    return err;
  }
  return undefined;
}

function assertMismatch(
  slug: string,
  raw: unknown,
  expectedActive: string,
  rule: (typeof INCOMPATIBLE_COMBINATIONS)[number],
): MismatchAssertion {
  if (raw === undefined) {
    fail(
      `combo "${slug}" composed without throwing — the composer's pre-flight failed to reject ` +
        `the cross-runtime mismatch (${rule.reason}).`,
    );
  }
  if (!(raw instanceof TemplateComposeError)) {
    fail(`combo "${slug}" threw ${String(raw)} (not a TemplateComposeError).`);
  }
  if (raw.phase !== "dependency_runtime_mismatch") {
    fail(
      `combo "${slug}" threw TemplateComposeError with phase="${raw.phase}" ` +
        `(expected "dependency_runtime_mismatch").`,
    );
  }
  if (raw.fragmentId !== rule.fragmentId) {
    fail(
      `combo "${slug}" TemplateComposeError.fragmentId="${raw.fragmentId ?? "<undefined>"}" ` +
        `(expected "${rule.fragmentId}").`,
    );
  }
  const payload = raw.payload;
  if (payload === undefined) {
    fail(`combo "${slug}" TemplateComposeError carried no payload (expected the structured mismatch).`);
  }
  if (payload.fragmentId !== rule.fragmentId) {
    fail(`combo "${slug}" payload.fragmentId="${payload.fragmentId}" (expected "${rule.fragmentId}").`);
  }
  if (payload.requiredRuntime !== rule.requiredRuntime) {
    fail(`combo "${slug}" payload.requiredRuntime="${payload.requiredRuntime}" (expected "${rule.requiredRuntime}").`);
  }
  if (payload.activeRuntime !== expectedActive) {
    fail(`combo "${slug}" payload.activeRuntime="${payload.activeRuntime}" (expected "${expectedActive}").`);
  }
  return {
    expectedFragmentId: rule.fragmentId,
    expectedRequiredRuntime: rule.requiredRuntime,
    expectedActiveRuntime: expectedActive,
    captured: raw,
  };
}

describe("template-fragment composer — cross-runtime dependsOn mismatch MUST throw (task #72)", () => {
  it("there is at least one incompatible combination to test", () => {
    // If a future PR makes EVERY runtime-dependent fragment stack-agnostic, the
    // INCOMPATIBLE_COMBINATIONS list goes to zero — at which point this whole
    // suite becomes vestigial and can be removed. Until then, at least one entry
    // proves the pre-flight is exercised.
    expect(INCOMPATIBLE_COMBINATIONS.length).toBeGreaterThan(0);
  });

  for (const rule of INCOMPATIBLE_COMBINATIONS) {
    const slug = `mismatch__${rule.fragmentId}__active-${rule.requiredRuntime === "runtime-node-pnpm" ? "ruby-bundler" : "node-pnpm"}`;
    it(`rejects "${rule.fragmentId}" paired with the opposite of ${rule.requiredRuntime} (${rule.reason})`, async () => {
      const combo = comboForRule(rule);
      const config = comboToConfig(combo, slug);
      const captured = await captureCompose(config);
      const expectedActive = `runtime-${combo.runtime}`;
      const result = assertMismatch(slug, captured, expectedActive, rule);
      expect(result.captured.message).toMatch(/dependsOn/u);
      expect(result.captured.message).toContain(result.expectedFragmentId);
      expect(result.captured.message).toContain(result.expectedRequiredRuntime);
      expect(result.captured.message).toContain(result.expectedActiveRuntime);
    });
  }

  // A combo that matches MULTIPLE rules (e.g. ruby + remix + postgres-prisma +
  // biome): the composer's pre-flight walks fragments in `compose()` order and
  // throws on the FIRST cross-runtime fragment encountered. `pickFirstMatchingRule`
  // mirrors that order — this test pins the deterministic-throw contract.
  it("a combo that matches multiple rules throws naming the FIRST fragment in compose-phase order", async () => {
    const slug = "multi-mismatch__ruby-bundler__remix__postgres-prisma__addons-biome";
    const config: TemplateConfig = {
      slug,
      runtime: "ruby-bundler",
      frontend: "remix",
      db: "postgres-prisma",
      deploy: "none",
      addons: ["biome"],
      examples: [],
    };
    const captured = await captureCompose(config);
    const combo: NormalizedCombo = {
      runtime: "ruby-bundler",
      frontend: "remix",
      db: "postgres-prisma",
      deploy: "none",
      addons: ["biome"],
      examples: [],
    };
    const rule = pickFirstMatchingRule(combo);
    if (rule === undefined) fail("test setup: the multi-mismatch combo matched zero rules");
    assertMismatch(slug, captured, "runtime-ruby-bundler", rule);
    expect(rule.fragmentId).toBe("frontend-remix");
  });
});
