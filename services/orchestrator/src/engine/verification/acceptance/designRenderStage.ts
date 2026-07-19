/**
 * rv-13 A4: fold the ds-4 run-level DESIGN-RENDER (rendered-visual a11y) verdict into
 * the rv-11 executable-acceptance spine as first-class, false-green-proof acceptance
 * evidence. A behavior whose acceptance declares `visualVerification.required` is not
 * decisively proven by its functional (HTTP/causal) assertions alone — it ALSO demands a
 * passing rendered-visual verdict for the project's composed design system. This stage
 * resolves that verdict (the same `design_render_land_verdicts` row ds-4's producer
 * persists per composed release) and maps it to a fail-closed {@link VisualContribution}
 * the orchestrator applies as a downgrade-only overlay on the behavior's outcome.
 *
 * DISTINCT FROM the ds-4 project land gate (`merge/designRenderLandGate.ts`): that gate
 * asks "does the project's design system meet ITS OWN declared a11y posture" at land time,
 * once per run. THIS stage makes the render verdict a per-BEHAVIOR acceptance verdict — so
 * a behavior that explicitly requires rendered-visual proof gets a real `behavior_verdicts`
 * row (feeding `resolveLandTimeBehaviorGate` → MergeAuthorityV2, exactly like an HTTP
 * behavior). The two are complementary safety layers over the same evidence.
 *
 * FAIL-CLOSED (§0), NEVER a false green. A required rendered-visual behavior is BLOCKED
 * whenever the verdict does not decisively pass:
 *   · a `failed_visual` verdict (a real axe violation at/above the bar) → `failed_visual`.
 *   · an `inconclusive_infrastructure` verdict → inconclusive (blocks).
 *   · a `not_applicable` verdict (the project's posture is advisory "none") → inconclusive:
 *     the behavior DEMANDED visual proof, and an absent bar can never satisfy that demand.
 *   · NO verdict at all (required-but-absent) → inconclusive (absence never authorizes).
 *   · NO reader wired, or a reader that raises → inconclusive (unresolved ≠ observed-pass).
 * Only a genuine `passed` verdict (every rendered scenario decisively cleared) clears.
 */

import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { BehaviorVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";
import {
  readLatestDesignRenderVerdict,
  type DesignRenderVerdictRow,
} from "../../design/render/designRenderVerdictStore.js";

/**
 * The acceptance-plan descriptor that turns on the rv-13 overlay for a behavior. Authored
 * into the behavior's stored acceptance spec (rv-6 plan loader) and carried on the plan.
 */
export interface VisualVerificationRequirement {
  /** When `true`, the behavior demands a passing rendered-visual verdict (fail-closed). */
  readonly required: boolean;
  /** The a11y standard the behavior expects (advisory; surfaced in the block reason). */
  readonly accessibilityStandard?: string;
}

/** The fail-closed visual contribution the orchestrator overlays onto a behavior outcome. */
export type VisualContribution =
  | { readonly kind: "passed"; readonly passedCheckpointCount: number }
  | {
      readonly kind: "failed_visual";
      readonly failingScenarioKey: string;
      readonly failingRuleIds: readonly string[];
    }
  | { readonly kind: "inconclusive"; readonly reason: string };

/**
 * PURE fail-closed map from a persisted run-level design-render verdict (or its absence)
 * to the visual contribution. DB-free so the decision table is unit-tested without Postgres.
 * `undefined` (no verdict for the project) is required-but-absent → inconclusive.
 */
export function evaluateVisualContribution(verdict: DesignRenderVerdictRow | undefined): VisualContribution {
  if (verdict === undefined) {
    return {
      kind: "inconclusive",
      reason: "no design-render verdict exists for the project — a required rendered-visual behavior is unverifiable",
    };
  }
  if (verdict.outcome === "passed") {
    return { kind: "passed", passedCheckpointCount: verdict.checkpoints.filter((c) => c.verdict === "passed").length };
  }
  if (verdict.outcome === "failed_visual") {
    return {
      kind: "failed_visual",
      failingScenarioKey: verdict.failingScenarioKey ?? "unknown",
      failingRuleIds: verdict.failingRuleIds,
    };
  }
  if (verdict.outcome === "not_applicable") {
    return {
      kind: "inconclusive",
      reason:
        `the behavior requires rendered-visual verification but the project's design posture ` +
        `('${verdict.accessibilityStandard}') is advisory (not_applicable) — an absent a11y bar cannot satisfy it`,
    };
  }
  // inconclusive_infrastructure — fail closed (inconclusive ≠ passed).
  return {
    kind: "inconclusive",
    reason:
      `design-render verification for the '${verdict.accessibilityStandard}' posture was inconclusive ` +
      `(no scenario verified clean; not a decisive pass)`,
  };
}

/**
 * Apply the visual contribution as a DOWNGRADE-ONLY overlay on the assertion-derived
 * outcome. It NEVER turns a non-pass into a pass: a `passed` behavior is downgraded when
 * the visual requirement did not decisively pass, and an already-blocked behavior keeps its
 * (more actionable functional) outcome — except that a real `failed_visual` is more decisive
 * than an infra-inconclusive base, so it surfaces as the reported reason.
 */
export function applyVisualGate(
  base: BehaviorVerdictOutcome,
  contribution: VisualContribution,
): BehaviorVerdictOutcome {
  if (contribution.kind === "passed") return base;
  if (base === "passed") {
    return contribution.kind === "failed_visual" ? "failed_visual" : "inconclusive_infrastructure";
  }
  if (
    contribution.kind === "failed_visual" &&
    (base === "inconclusive_infrastructure" || base === "inconclusive_external")
  ) {
    return "failed_visual";
  }
  return base;
}

export interface DesignRenderVerdictReaderInput {
  readonly orgId: string;
  readonly projectId: string;
}

/**
 * Reads the LATEST run-level design-render verdict for a project. The production impl runs
 * org-scoped (RLS); a test impl scripts the row. Returning `undefined` means the project has
 * no persisted verdict (required-but-absent → the stage blocks fail-closed).
 */
export interface DesignRenderVerdictReader {
  readLatest(input: DesignRenderVerdictReaderInput): Promise<DesignRenderVerdictRow | undefined>;
}

/** The org-scoped production reader over ds-4's `design_render_land_verdicts` (RLS-enforced). */
export class PgDesignRenderVerdictReader implements DesignRenderVerdictReader {
  public constructor(private readonly pool: pg.Pool) {}

  public readLatest(input: DesignRenderVerdictReaderInput): Promise<DesignRenderVerdictRow | undefined> {
    return runWithOrgScope(this.pool, input.orgId, (client) =>
      readLatestDesignRenderVerdict(client, input.orgId, input.projectId),
    );
  }
}

export interface DesignRenderStageInput {
  readonly orgId: string;
  readonly projectId: string;
  readonly requirement: VisualVerificationRequirement;
}

/**
 * Resolves a required behavior's rendered-visual contribution from the persisted verdict,
 * fail-closed at every unresolved edge. Only invoked for a plan that declares
 * `visualVerification.required` — the orchestrator skips it entirely otherwise (zero cost).
 */
export class DesignRenderAcceptanceStage {
  public constructor(private readonly reader?: DesignRenderVerdictReader) {}

  public async resolve(input: DesignRenderStageInput): Promise<VisualContribution> {
    if (this.reader === undefined) {
      return {
        kind: "inconclusive",
        reason:
          "no design-render verdict reader is wired — a required rendered-visual behavior cannot be verified " +
          "(unresolved ≠ a pass)",
      };
    }
    let verdict: DesignRenderVerdictRow | undefined;
    try {
      verdict = await this.reader.readLatest({ orgId: input.orgId, projectId: input.projectId });
    } catch (error) {
      return {
        kind: "inconclusive",
        reason: `design-render verdict read failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return evaluateVisualContribution(verdict);
  }
}
