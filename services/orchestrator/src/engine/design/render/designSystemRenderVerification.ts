// ds-4 sub-node #3 — the PRODUCTION render-verification pass over a composed web
// design system. This is what makes the ds-4 chain FIRE in a real run: after
// `composeProjectWebDesignSystem` publishes the system, this renders the catalog's
// components browser-free (sub-node #1 harness) and judges their a11y audit against
// the project's `accessibilityPosture` (sub-node #2 oracle), then aggregates one
// run-level design-render outcome (designRenderVerdict.ts) the native gate binds.
//
// HONEST SCOPE: the a11y pass renders via React SSR + jsdom + axe — no browser. Catalog
// components that need an external-dep primitive (a `@radix-ui/*` import that will not
// bundle browser-free) surface as a `render_failed(bundle)`; with the pixel knob OFF they
// are EXCLUDED (a11y-only honest scope), with it ON the pixel pass picks them up and judges
// them fail-closed. Every component that DOES render browser-free is judged for real; a real
// axe violation at/above the posture bar is a `failed_visual` checkpoint.
//
// ds-4 Slice B — the PIXEL path is now WIRED (not a dead library): when the project's
// opt-in `visualVerification` knob is enabled, this pass ALSO runs the containerized
// (podman + Playwright) screenshot harness + the real pixel visual-diff oracle over the
// SAME scenarios, and merges the pixel checkpoints (carrying the real `diffRatio`) into the
// ONE run-level verdict the land gate binds. FAIL-CLOSED: infra absent / absent baseline /
// capture failure → inconclusive (blocks), never a silent skip. Knob off → a11y-only, zero
// behavior change, no podman invocation.

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
import { runPixelRenderScenarios, type PixelVerificationWiring } from "./pixelRenderScenarioPass.js";
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
  /**
   * OPTIONAL pixel (browser screenshot + visual-diff) verification wiring. UNDEFINED →
   * the a11y-only path runs EXACTLY as before (zero behavior change, no podman
   * invocation) — the composition root leaves it undefined unless the project's opt-in
   * `visualVerification` knob is enabled. When present, pixel checkpoints merge into the
   * SAME fail-closed run-level verdict.
   */
  readonly pixel?: PixelVerificationWiring;
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
  const a11yAdvisory = deriveA11ySeverityBar(standard).kind === "informational";
  const pixelEnabled = input.pixel !== undefined;

  // Advisory a11y posture AND no pixel knob → the design system declares no bar → not
  // required (the a11y-only default behavior; zero change when the pixel knob is off).
  if (a11yAdvisory && !pixelEnabled) {
    return notApplicableDesignRenderVerification(standard);
  }

  const sourceByPath = new Map(input.build.files.map((file) => [file.path, file] as const));
  const componentByKey = new Map(
    input.build.catalog.components.map((component) => [component.key, component] as const),
  );

  const checkpoints: DesignRenderCheckpoint[] = [];
  let excludedCount = 0;

  // The browser-free a11y pass runs unless the a11y posture is advisory (an enabled pixel
  // knob does NOT force an a11y bar — the two passes are independent evidence kinds).
  if (!a11yAdvisory) {
    const harness = new BrowserFreeRenderCaptureHarness(input.cas);
    const oracle = new RenderA11yVerdictOracle(input.cas);
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
      // external-dep primitive). When the pixel knob is ON, the pixel pass picks the
      // scenario up (below) and judges it fail-closed, so it is NOT excluded-as-done here;
      // when OFF, keep the honest a11y-only exclusion (the render-worker sub-node's job).
      if (capture.kind === "render_failed" && capture.stage === "bundle") {
        if (!pixelEnabled) excludedCount += 1;
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
  }

  // The pixel (browser screenshot + visual-diff) pass — ONLY when the opt-in knob wired it.
  // Its checkpoints merge into the SAME aggregate, so a pixel `failed_visual` (or a
  // fail-closed inconclusive) blocks the land gate alongside the a11y verdict.
  if (input.pixel !== undefined) {
    const pixelCheckpoints = await runPixelRenderScenarios({
      orgId: input.orgId,
      cas: input.cas,
      designContractVersion: input.designContractVersion,
      pixel: input.pixel,
      components: componentByKey,
      sourceByPath,
      scenarios: input.scenarios,
    });
    checkpoints.push(...pixelCheckpoints);
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
