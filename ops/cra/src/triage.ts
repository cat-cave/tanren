import type { VerifiedAuditReport } from "./auditAdapter.js";
import type { AuditFinding, FindingCategory, FindingSeverity } from "./auditReport.js";

// Supervisor-owned P0-P3 triage under the DONENESS model. Severity is a statement
// about whether the ORIGINAL issue is done, not how expensive a fix looks:
//   P0 — any acceptance/completion gap, destructive regression, failed/unconfirmable
//        negative control, fail-open security boundary, or wrong direction.
//   P1 — acceptance present but a fundamental implementation/standards/security
//        defect makes it unfit to land on this branch.
//   P2/P3 — the original issue is fully done and proved; claimable betterment/ratchet.
// Any P0/P1 -> REQUEST_CHANGES (the issue is NOT done). Only P2/P3 (or none) -> APPROVE.

export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES";

export interface NormalizedFinding {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly category: FindingCategory | "process";
  readonly severity: FindingSeverity;
  readonly locatable: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly side: "LEFT" | "RIGHT" | null;
  readonly evidence: string;
  // True when the supervisor forced the severity (e.g. an acceptance-concerning
  // finding raised to P0), independent of the worker's suggestion.
  readonly forced: boolean;
}

export interface TriageResult {
  readonly verdict: ReviewVerdict;
  readonly findings: readonly NormalizedFinding[];
  readonly counts: Readonly<Record<FindingSeverity, number>>;
}

// Categories that are always completion/fitness blockers regardless of the worker's
// suggested severity: a destructive regression or a fail-open security boundary is
// never a mere betterment.
const FORCED_P0_CATEGORIES: ReadonlySet<FindingCategory> = new Set(["completion", "regression_deletion"]);

function finalSeverity(finding: AuditFinding): { severity: FindingSeverity; forced: boolean } {
  if (finding.concerns === "acceptance") return { severity: "P0", forced: finding.suggestedSeverity !== "P0" };
  if (FORCED_P0_CATEGORIES.has(finding.category)) return { severity: "P0", forced: finding.suggestedSeverity !== "P0" };
  // Security defects block: at least P1 (a fail-open boundary the worker rates P0
  // stays P0 via the concerns/category arms above).
  if (finding.category === "security" && finding.suggestedSeverity !== "P0") {
    return { severity: "P1", forced: finding.suggestedSeverity !== "P1" };
  }
  return { severity: finding.suggestedSeverity, forced: false };
}

function normalizeWorkerFinding(finding: AuditFinding): NormalizedFinding {
  const { severity, forced } = finalSeverity(finding);
  const locatable = finding.evidence.path !== null && finding.evidence.line !== null;
  return {
    id: finding.id,
    title: finding.title,
    body: finding.body,
    category: finding.category,
    severity,
    locatable,
    path: finding.evidence.path,
    line: finding.evidence.line,
    side: finding.evidence.side,
    evidence: finding.evidence.detail,
    forced,
  };
}

function synthesized(
  id: string,
  title: string,
  body: string,
  evidence: string,
  severity: FindingSeverity = "P0",
): NormalizedFinding {
  return {
    id,
    title,
    body,
    category: "process",
    severity,
    locatable: false,
    path: null,
    line: null,
    side: null,
    evidence,
    forced: true,
  };
}

// Completion gaps the supervisor synthesizes from the verified report even when the
// worker filed no finding for them: unmet acceptance traces, unconfirmed mandatory
// negative controls, unaccounted live/test deletions (the mq-16 class), and an
// unconfirmable cross-model independence check on an agent-authored PR.
function synthesizeGaps(verified: VerifiedAuditReport): NormalizedFinding[] {
  const gaps: NormalizedFinding[] = [];
  verified.report.acceptanceTraces.forEach((trace, index) => {
    if (!trace.satisfied) {
      gaps.push(
        synthesized(
          `acceptance-gap-${index}`,
          "Acceptance statement not satisfied",
          `The acceptance statement "${trace.statement}" is not met by this PR.`,
          trace.evidence,
        ),
      );
    }
  });
  for (const verification of verified.controlVerifications) {
    if (verification.mandatory && !verification.confirmed) {
      gaps.push(
        synthesized(
          `control-unconfirmed-${verification.id}`,
          "Mandatory negative control not confirmed",
          `The mandatory negative control ${verification.id} was not confirmed to reject a bad input.`,
          verification.detail,
        ),
      );
    }
  }
  verified.report.deletionAccounting.forEach((entry, index) => {
    if (!entry.justified) {
      gaps.push(
        synthesized(
          `deletion-unaccounted-${index}`,
          `Unaccounted ${entry.isTest ? "test" : "production"} deletion`,
          `${entry.path} deletes ${entry.deletedLines} ${entry.isTest ? "test" : "production"} line(s) without justified replacement coverage.`,
          entry.justification,
        ),
      );
    }
  });
  if (!verified.independence.confirmed) {
    // Only an agent-authored PR whose provenance cannot be confirmed independent is
    // a completion gap; a confirmed cross-model mismatch is reported by reason.
    gaps.push(
      synthesized(
        "independence-unconfirmed",
        "Cross-model audit independence not confirmed",
        "The audit worker could not be confirmed independent of the contributor.",
        verified.independence.reason,
      ),
    );
  }
  return gaps;
}

export function triage(verified: VerifiedAuditReport): TriageResult {
  const findings = [...verified.report.findings.map(normalizeWorkerFinding), ...synthesizeGaps(verified)];
  const counts: Record<FindingSeverity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const verdict: ReviewVerdict = counts.P0 > 0 || counts.P1 > 0 ? "REQUEST_CHANGES" : "APPROVE";
  return { verdict, findings, counts };
}
