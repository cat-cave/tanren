// ds-4 Slice B sub-node #3 — the PRODUCTION pixel render pass.
//
// Runs the pixel harness (podman screenshot) + visual-diff oracle over the SAME
// scenario matrix the a11y pass judges, and returns pixel checkpoints that merge into
// the ONE run-level design_render verdict the land gate binds. This is the wiring that
// makes the pixel path FIRE in a real compose (it is NOT a dead library) — invoked by
// `verifyComposedDesignSystemRender` ONLY when the opt-in visual-verification knob is on.
//
// FAIL-CLOSED throughout:
//   · infra absent (podman/image missing) → EVERY scenario is an inconclusive (`unknown`)
//     checkpoint → blocks. An opted-in project whose container infra is absent sees
//     blocked, never a silent skip that passes.
//   · a scenario whose component source is missing from the catalog → inconclusive.
//   · a capture/diff failure or an absent baseline → the oracle returns inconclusive →
//     `unknown` checkpoint → blocks. Absence is never a pass.

import type { CasArtifactRef, CasByteStore } from "../../contracts/cas.js";
import type { VisualComparisonRules } from "../../contracts/runtimeVerificationAdapters.js";
import type { DesignRenderScenario } from "../system/designTargetAdapter.js";
import type { DesignRenderCheckpoint } from "./designRenderVerdict.js";
import { checkpointFromPixelVerdict, pixelCheckpointId } from "./pixelRenderCheckpoint.js";
import { PixelRenderCaptureHarness } from "./pixelRenderCaptureHarness.js";
import type { PixelRenderRunner } from "./pixelRenderContracts.js";
import { PixelVisualDiffOracle } from "./visualDiffOracle.js";

/**
 * Resolves the accepted regression baseline screenshot for a scenario (the prior
 * release's captured screenshot), or `null` when none exists yet (first compose). A
 * `null` baseline is fail-closed inconclusive in the oracle — never a pass.
 */
export interface PixelBaselineResolver {
  resolve(scenarioKey: string): Promise<CasArtifactRef | null>;
}

/** The injected pixel wiring the composition root builds when the knob is enabled. */
export interface PixelVerificationWiring {
  readonly runner: PixelRenderRunner;
  readonly baselineResolver: PixelBaselineResolver;
  readonly rules: VisualComparisonRules;
  /** Fail-closed infra probe — false → every scenario inconclusive (blocked), never skipped. */
  readonly available: () => Promise<boolean>;
}

export interface PixelRenderScenarioPassInput {
  readonly orgId: string;
  readonly cas: CasByteStore;
  readonly designContractVersion: string;
  readonly pixel: PixelVerificationWiring;
  /** The catalog component index (component key → source path). */
  readonly components: ReadonlyMap<string, { readonly key: string; readonly sourcePath: string }>;
  /** The materialized source files (path → bytes). */
  readonly sourceByPath: ReadonlyMap<string, { readonly path: string; readonly bytes: Uint8Array }>;
  readonly scenarios: readonly DesignRenderScenario[];
}

/**
 * Produce the pixel checkpoints for a compose. Each carries the `::pixel`-suffixed id so
 * it coexists with the same scenario's a11y checkpoint under one gate.
 */
export async function runPixelRenderScenarios(
  input: PixelRenderScenarioPassInput,
): Promise<readonly DesignRenderCheckpoint[]> {
  // FAIL-CLOSED: if the render worker is not runnable here, every scenario is inconclusive
  // (blocks) — an opted-in project whose infra is absent is NOT silently skipped.
  if (!(await input.pixel.available())) {
    return input.scenarios.map((scenario) =>
      inconclusivePixelCheckpoint(scenario.scenarioKey, "render-worker unavailable (podman/image absent)"),
    );
  }

  const harness = new PixelRenderCaptureHarness(input.cas, input.pixel.runner);
  const oracle = new PixelVisualDiffOracle(input.cas);
  const checkpoints: DesignRenderCheckpoint[] = [];

  for (const scenario of input.scenarios) {
    const component = input.components.get(scenario.component);
    const file = component === undefined ? undefined : input.sourceByPath.get(component.sourcePath);
    if (component === undefined || file === undefined) {
      checkpoints.push(inconclusivePixelCheckpoint(scenario.scenarioKey, "component source missing from catalog"));
      continue;
    }

    const capture = await harness.capture({
      orgId: input.orgId,
      scenario,
      componentSource: new TextDecoder().decode(file.bytes),
      componentExportName: pascalCase(component.key),
      designContractVersion: input.designContractVersion,
      children: humanize(component.key),
    });
    const baseline = await input.pixel.baselineResolver.resolve(scenario.scenarioKey);
    const verdict = await oracle.judge({ orgId: input.orgId, capture, baseline, rules: input.pixel.rules });
    checkpoints.push(checkpointFromPixelVerdict(verdict));
  }

  return checkpoints;
}

/** An inconclusive (`unknown`) pixel checkpoint — blocks a required section, never a pass. */
function inconclusivePixelCheckpoint(scenarioKey: string, _reason: string): DesignRenderCheckpoint {
  return { checkpointId: pixelCheckpointId(scenarioKey), verdict: "unknown", failingRuleIds: [] };
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
