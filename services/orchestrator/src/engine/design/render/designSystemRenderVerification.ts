// ds-4 sub-node #3 — the PRODUCTION render-verification pass over a composed web
// design system. This is what makes the ds-4 chain FIRE in a real run: after
// `composeProjectWebDesignSystem` publishes the system, this renders the catalog's
// components browser-free (sub-node #1 harness) and judges their a11y audit against
// the project's `accessibilityPosture` (sub-node #2 oracle), then aggregates one
// run-level design-render outcome (designRenderVerdict.ts) the native gate binds.
//
// HONEST SCOPE (browser-free slice): the harness renders via React SSR + jsdom + axe
// — no browser. Catalog components that need an external-dep primitive (a `@radix-ui/*`
// import that will not bundle browser-free) surface as a `render_failed(bundle)` and are
// EXCLUDED (the render-worker sub-node's job) — never counted as a spurious block. Every
// component that DOES render browser-free is judged for real; a real axe violation at/above
// the posture bar is a `failed_visual` checkpoint. A component is rendered with its own
// human label as accessible content (its minimal realistic render state) — the honest
// minimum for an a11y audit, never a fabricated verdict.

import type { CasByteStore } from "../../contracts/cas.js";
import type { DesignAccessibilityPosture } from "../system/designContractV2.js";
import type { DesignRenderScenario } from "../system/designTargetAdapter.js";
import { BrowserFreeRenderCaptureHarness } from "./browserFreeRenderCaptureHarness.js";
import {
  aggregateDesignRenderOutcome,
  checkpointVerdictFromOracle,
  notApplicableDesignRenderVerification,
  type DesignRenderCheckpoint,
  type DesignRenderVerification,
} from "./designRenderVerdict.js";
import { deriveA11ySeverityBar, RenderA11yVerdictOracle } from "./renderVerdictOracle.js";

/** The structural subset of the built web artifact this pass renders from — the catalog's
 * component keys + source paths, and the materialized source file bytes. The real
 * `WebArtifactBuildResult` satisfies it structurally; tests construct a minimal build. */
export interface RenderableComponentBuild {
  readonly catalog: { readonly components: readonly { readonly key: string; readonly sourcePath: string }[] };
  readonly files: readonly { readonly path: string; readonly bytes: Uint8Array }[];
}

export interface DesignSystemRenderVerificationInput {
  readonly orgId: string;
  readonly cas: CasByteStore;
  /** The built web artifact (catalog + component source files) to render from. */
  readonly build: RenderableComponentBuild;
  /** The risk-selected scenario matrix (component × theme × viewport …) to verify. */
  readonly scenarios: readonly DesignRenderScenario[];
  /** The project's a11y bar — the oracle judges each captured audit against it. */
  readonly accessibilityPosture: DesignAccessibilityPosture;
  /** The design-contract version this verification is keyed to (CAS provenance). */
  readonly designContractVersion: string;
}

/**
 * Render + judge the composed system's scenario matrix into ONE run-level outcome.
 *
 * A posture of "none"/advisory (`informational` bar) short-circuits to `not_applicable`
 * WITHOUT rendering: an advisory design system is composed but imposes no a11y bar, so
 * it never blocks a merge. Any REAL bar (enforced OR a declared-but-unmappable standard)
 * renders every scenario; an unmappable standard flows through the oracle as
 * `inconclusive` (fail-closed, never a silent pass).
 */
export async function verifyComposedDesignSystemRender(
  input: DesignSystemRenderVerificationInput,
): Promise<DesignRenderVerification> {
  const standard = input.accessibilityPosture.standard;
  // Advisory posture: the design system exists but declares no a11y bar → not required.
  if (deriveA11ySeverityBar(standard).kind === "informational") {
    return notApplicableDesignRenderVerification(standard);
  }

  const harness = new BrowserFreeRenderCaptureHarness(input.cas);
  const oracle = new RenderA11yVerdictOracle(input.cas);
  const sourceByPath = new Map(input.build.files.map((file) => [file.path, file] as const));
  const componentByKey = new Map(
    input.build.catalog.components.map((component) => [component.key, component] as const),
  );

  const checkpoints: DesignRenderCheckpoint[] = [];
  let excludedCount = 0;

  for (const scenario of input.scenarios) {
    const component = componentByKey.get(scenario.component);
    const file = component === undefined ? undefined : sourceByPath.get(component.sourcePath);
    if (component === undefined || file === undefined) {
      // The catalog does not carry this scenario's component source — cannot render it
      // browser-free; exclude (the render-worker sub-node), never a spurious block.
      excludedCount += 1;
      continue;
    }

    const capture = await harness.capture({
      orgId: input.orgId,
      scenario,
      componentSource: new TextDecoder().decode(file.bytes),
      componentExportName: pascalCase(component.key),
      designContractVersion: input.designContractVersion,
      // Render the component with its own human label as accessible content — the minimal
      // realistic render state an a11y audit needs. NOT a fabricated verdict.
      children: humanize(component.key),
    });

    // A `bundle`-stage failure means the component is not browser-free renderable (an
    // external-dep primitive) → the render-worker sub-node's job. Exclude it.
    if (capture.kind === "render_failed" && capture.stage === "bundle") {
      excludedCount += 1;
      continue;
    }

    const verdict = await oracle.judge({
      orgId: input.orgId,
      capture,
      accessibilityPosture: input.accessibilityPosture,
    });
    checkpoints.push({
      checkpointId: scenario.scenarioKey,
      verdict: checkpointVerdictFromOracle(verdict.outcome),
      failingRuleIds: verdict.failingViolations.map((violation) => violation.id),
    });
  }

  return aggregateDesignRenderOutcome(standard, checkpoints, excludedCount);
}

/** `dropdown-menu` → `DropdownMenu` (the catalog export name). */
function pascalCase(key: string): string {
  return key
    .split(/[-_]/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

/** `dropdown-menu` → `Dropdown Menu` (the component's human accessible label). */
function humanize(key: string): string {
  return key
    .split(/[-_]/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
