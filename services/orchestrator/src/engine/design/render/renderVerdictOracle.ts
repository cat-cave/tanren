// ds-4 sub-node #2 — the visual/a11y verdict oracle.
//
// Slice A of the A4 chain judges the REAL axe-core a11y audit (produced by the
// sub-node #1 render/capture harness) against the project's
// `DesignContractV2.accessibilityPosture` and issues a `RenderVerdictOutcome`:
//   · passed                      — no real violation at/above the posture's
//                                   severity bar (or the posture is advisory).
//   · failed_visual               — one or more real axe violations at/above the
//                                   bar, with the failing rule ids carried as
//                                   evidence.
//   · inconclusive_infrastructure — the capture failed, the a11y audit is
//                                   absent/unreadable/malformed, or the posture
//                                   names an a11y standard we cannot honestly map
//                                   to an axe impact bar. Fail-closed: absence,
//                                   unreadable evidence, and an un-judgeable bar
//                                   are NEVER a pass.
//
// PIXEL / visual-diff is OUT OF SCOPE — the harness captures DOM + a11y only;
// pixel screenshots are the separate render-worker sub-node. This oracle judges
// the a11y audit ONLY and NEVER fabricates a pixel diff.
//
// SEAM — sub-node #3 (design_render gate wiring) CONSUMES the returned
// `RenderA11yVerdict`: it maps the outcome onto the native gate's `design_render`
// proof unit and persists/enforces it. This oracle issues NO verdict to a gate
// and persists nothing itself.

import { z } from "zod";
import type { CasByteStore, Digest } from "../../contracts/cas.js";
import type { RenderVerdictOutcome } from "../../contracts/runtimeVerificationAdapters.js";
import type { DesignAccessibilityPosture } from "../system/designContractV2.js";
import type { RenderCaptureOutcome } from "./renderCaptureContracts.js";

// ---- axe impact severity ---------------------------------------------------

/** The four axe-core impact levels, ordered least→most severe. */
export type AxeImpact = "minor" | "moderate" | "serious" | "critical";
const AXE_IMPACTS: readonly AxeImpact[] = ["minor", "moderate", "serious", "critical"];

/**
 * The posture→severity mapping. A declared WCAG conformance level maps to the set
 * of axe impact levels that MUST be zero for the render to pass — a stricter
 * conformance level tolerates less:
 *   · A   → { critical }                              (only critical violations fail)
 *   · AA  → { serious, critical }                     (the de-facto product baseline)
 *   · AAA → { minor, moderate, serious, critical }    (zero tolerance)
 * A posture of "none" (or empty) is ADVISORY — violations are informational and
 * never fail. A declared-but-unrecognized standard (e.g. "apple-hig") is
 * `unmappable`: the oracle returns `inconclusive_infrastructure`, never a silent
 * pass, because we cannot honestly judge axe impacts against an unknown bar.
 */
export type A11ySeverityBar =
  | { readonly kind: "informational" }
  | { readonly kind: "enforced"; readonly wcagLevel: "a" | "aa" | "aaa"; readonly failingImpacts: readonly AxeImpact[] }
  | { readonly kind: "unmappable"; readonly standard: string };

const FAILING_IMPACTS_BY_LEVEL: Record<"a" | "aa" | "aaa", readonly AxeImpact[]> = {
  a: ["critical"],
  aa: ["serious", "critical"],
  aaa: [...AXE_IMPACTS],
};

/**
 * Derive the axe impact bar from a posture standard string (free-form, e.g.
 * "wcag-2.2-aa", "wcag2a", "none", "apple-hig"). WCAG is detected by name; the
 * conformance level is the letter token that remains after the "wcag" marker and
 * version digits are stripped. A WCAG standard with no parseable level defaults
 * to AA (the conformance baseline) rather than degrading to advisory.
 */
export function deriveA11ySeverityBar(standard: string): A11ySeverityBar {
  const normalized = standard.trim().toLowerCase();
  if (normalized === "" || normalized === "none") return { kind: "informational" };
  if (!normalized.includes("wcag")) return { kind: "unmappable", standard };
  const levelToken = normalized.replaceAll("wcag", "").replaceAll(/[0-9.\s_+-]/gu, "");
  const wcagLevel: "a" | "aa" | "aaa" = levelToken === "a" ? "a" : levelToken === "aaa" ? "aaa" : "aa";
  return { kind: "enforced", wcagLevel, failingImpacts: FAILING_IMPACTS_BY_LEVEL[wcagLevel] };
}

// ---- verdict record --------------------------------------------------------

/** One axe violation carried as verdict evidence (the failing/informational rule). */
export interface RenderVerdictViolation {
  readonly id: string;
  readonly impact: AxeImpact | null;
  readonly help: string;
  readonly targets: readonly string[];
}

/**
 * The oracle's verdict record. Deliberately NOT the pixel-diff `RenderVerdictRecord`
 * (that carries a `diffRatio`): this is the a11y/DOM verdict and carries the real
 * failing rule ids as evidence. Sub-node #3 maps `outcome` onto the gate.
 */
export interface RenderA11yVerdict {
  readonly outcome: RenderVerdictOutcome;
  readonly scenarioKey: string;
  readonly designContractVersion: string;
  readonly accessibilityStandard: string;
  readonly severityBar: A11ySeverityBar;
  /** The axe engine + version echoed from the judged audit (null when unread). */
  readonly engine: string | null;
  readonly engineVersion: string | null;
  /** The CAS digest of the exact `a11y_audit` bytes judged (null when unread). */
  readonly a11yEvidenceDigest: Digest | null;
  /** The violations at/above the bar — the evidence backing a `failed_visual`. */
  readonly failingViolations: readonly RenderVerdictViolation[];
  /** Violations below the bar / under an advisory posture (recorded, non-failing). */
  readonly informationalViolations: readonly RenderVerdictViolation[];
  /** A human reason, populated for `inconclusive_infrastructure`. */
  readonly reason: string | null;
}

export interface RenderVerdictInput {
  readonly orgId: string;
  /** The harness capture outcome (`captured` or `render_failed`) to judge. */
  readonly capture: RenderCaptureOutcome;
  /** The project's a11y bar, from `DesignContractV2.accessibilityPosture`. */
  readonly accessibilityPosture: DesignAccessibilityPosture;
}

// ---- stored audit schema (fail-closed parse) -------------------------------

const StoredViolationSchema = z.object({
  id: z.string().min(1),
  impact: z.string().nullish(),
  help: z.string().nullish(),
  targets: z.array(z.string()).nullish(),
});

// The load-bearing subset of the harness-serialized a11y audit. `violations` is
// REQUIRED — an audit whose violations we cannot read is inconclusive, never a
// silent clean pass.
const StoredA11yAuditSchema = z
  .object({
    engine: z.string().nullish(),
    engineVersion: z.string().nullish(),
    violations: z.array(StoredViolationSchema),
  })
  .passthrough();

type StoredViolation = z.infer<typeof StoredViolationSchema>;

function toAxeImpact(raw: string | null | undefined): AxeImpact | null {
  return raw !== null && raw !== undefined && (AXE_IMPACTS as readonly string[]).includes(raw)
    ? (raw as AxeImpact)
    : null;
}

function toVerdictViolation(violation: StoredViolation): RenderVerdictViolation {
  return {
    id: violation.id,
    impact: toAxeImpact(violation.impact),
    help: violation.help ?? "",
    targets: violation.targets ?? [],
  };
}

// ---- the oracle ------------------------------------------------------------

/**
 * The a11y verdict oracle. Constructed with the org-scoped `CasByteStore` so it
 * reads the EXACT `a11y_audit` bytes the harness stored (never a re-render, never
 * a fabricated axe result), and judges the real violations against the real
 * posture.
 */
export class RenderA11yVerdictOracle {
  public constructor(private readonly cas: CasByteStore) {}

  public async judge(input: RenderVerdictInput): Promise<RenderA11yVerdict> {
    const standard = input.accessibilityPosture.standard;
    const bar = deriveA11ySeverityBar(standard);
    const { capture } = input;

    // Fail-closed: a failed capture can never be a pass — it is inconclusive.
    if (capture.kind === "render_failed") {
      return this.inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        standard,
        bar,
        null,
        null,
        `render failed at stage '${capture.stage}': ${capture.reason}`,
      );
    }

    const a11yRef = capture.captureRefs.find((ref) => ref.kind === "a11y_audit");
    if (a11yRef === undefined) {
      return this.inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        standard,
        bar,
        null,
        null,
        "captured result carries no a11y_audit evidence ref",
      );
    }

    const digest = a11yRef.casRef.digest;
    let auditText: string;
    try {
      const bytes = await this.cas.get(input.orgId, digest);
      auditText = new TextDecoder().decode(bytes.bytes);
    } catch (error) {
      return this.inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        standard,
        bar,
        null,
        digest,
        `a11y audit bytes are unreadable from CAS: ${describe(error)}`,
      );
    }

    const parsed = parseAudit(auditText);
    if (!parsed.ok) {
      return this.inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        standard,
        bar,
        null,
        digest,
        `a11y audit bytes are malformed: ${parsed.reason}`,
      );
    }
    const audit = parsed.audit;
    const engine = audit.engine ?? null;
    const engineVersion = audit.engineVersion ?? null;
    const violations = audit.violations.map(toVerdictViolation);

    // A declared-but-unmappable standard is fail-closed inconclusive: we will not
    // pass a render we cannot honestly judge against an unknown a11y bar.
    if (bar.kind === "unmappable") {
      return this.inconclusive(
        capture.scenarioKey,
        capture.designContractVersion,
        standard,
        bar,
        engine,
        digest,
        `accessibility posture standard '${standard}' cannot be mapped to an axe impact bar`,
      );
    }

    // Advisory posture ("none"): every violation is informational, never failing.
    if (bar.kind === "informational") {
      return {
        outcome: "passed",
        scenarioKey: capture.scenarioKey,
        designContractVersion: capture.designContractVersion,
        accessibilityStandard: standard,
        severityBar: bar,
        engine,
        engineVersion,
        a11yEvidenceDigest: digest,
        failingViolations: [],
        informationalViolations: violations,
        reason: null,
      };
    }

    // Enforced posture: a violation fails when its impact is at/above the bar, OR
    // when axe could not rate it (a real violation we cannot prove below-bar →
    // conservatively failing).
    const failing: RenderVerdictViolation[] = [];
    const informational: RenderVerdictViolation[] = [];
    for (const violation of violations) {
      if (violationFails(violation.impact, bar.failingImpacts)) failing.push(violation);
      else informational.push(violation);
    }
    return {
      outcome: failing.length > 0 ? "failed_visual" : "passed",
      scenarioKey: capture.scenarioKey,
      designContractVersion: capture.designContractVersion,
      accessibilityStandard: standard,
      severityBar: bar,
      engine,
      engineVersion,
      a11yEvidenceDigest: digest,
      failingViolations: failing,
      informationalViolations: informational,
      reason: null,
    };
  }

  private inconclusive(
    scenarioKey: string,
    designContractVersion: string,
    accessibilityStandard: string,
    severityBar: A11ySeverityBar,
    engine: string | null,
    a11yEvidenceDigest: Digest | null,
    reason: string,
  ): RenderA11yVerdict {
    return {
      outcome: "inconclusive_infrastructure",
      scenarioKey,
      designContractVersion,
      accessibilityStandard,
      severityBar,
      engine,
      engineVersion: null,
      a11yEvidenceDigest,
      failingViolations: [],
      informationalViolations: [],
      reason,
    };
  }
}

/** A violation fails when it is rated at/above the bar, or is unrated (null). */
function violationFails(impact: AxeImpact | null, failingImpacts: readonly AxeImpact[]): boolean {
  if (impact === null) return true;
  return failingImpacts.includes(impact);
}

type ParseAuditResult =
  | { readonly ok: true; readonly audit: z.infer<typeof StoredA11yAuditSchema> }
  | { readonly ok: false; readonly reason: string };

function parseAudit(text: string): ParseAuditResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `not valid JSON: ${describe(error)}` };
  }
  const result = StoredA11yAuditSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, reason: result.error.issues.map((issue) => issue.message).join("; ") };
  }
  return { ok: true, audit: result.data };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
