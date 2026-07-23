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

// Independent evidence the SUPERVISOR holds (not the worker's self-report). Today
// that is the PR diff, from which deletion accounting is recomputed.
export interface SupervisorEvidence {
  readonly diff: string;
}

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
function synthesizeGaps(verified: VerifiedAuditReport, evidence: SupervisorEvidence): NormalizedFinding[] {
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
    } else if (!citesVerifiableEvidence(trace.evidence)) {
      // The supervisor cannot fully re-run acceptance, but it refuses to take a bare
      // "satisfied" on trust: a satisfied claim MUST cite a concrete test/command/
      // file. An unverifiable claim is treated as an unmet acceptance gap (P0).
      gaps.push(
        synthesized(
          `acceptance-unverifiable-${index}`,
          "Acceptance claimed satisfied without verifiable evidence",
          `The acceptance statement "${trace.statement}" is claimed satisfied but cites no verifiable test, command, or file evidence.`,
          trace.evidence,
        ),
      );
    }
  });
  for (const verification of verified.controlVerifications) {
    // A fail-open is a fail-open: ANY unconfirmed EXECUTED control forces P0 whether
    // or not it was flagged mandatory (the crux fail-open). Unconfirmed MANDATORY
    // controls of any kind also force P0 (the rubric's "not run / cannot be
    // confirmed" clause). Only a non-mandatory inspected control may go unblocked.
    const forces = !verification.confirmed && (verification.kind === "executed" || verification.mandatory);
    if (forces) {
      gaps.push(
        synthesized(
          `control-unconfirmed-${verification.id}`,
          "Negative control not confirmed to reject a bad input",
          `The ${verification.kind} negative control ${verification.id} was not independently confirmed to reject a bad input.`,
          verification.detail,
        ),
      );
    }
  }
  for (const check of verified.report.unresolvedChecks) {
    // An audit cannot APPROVE over an unresolved/failed required check.
    gaps.push(
      synthesized(
        `unresolved-check-${check.name}`,
        "Unresolved required CI check",
        `Required check ${check.name} is ${check.status}: an audit cannot approve over an unresolved check.`,
        check.reason,
      ),
    );
  }
  gaps.push(...deletionGaps(verified, evidence));
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

// Deletion accounting is INDEPENDENTLY RECOMPUTED from the diff — the supervisor
// never relies solely on the worker's claim (the mq-16 class). A worker-declared
// entry left unjustified is P0; a deletion the worker OMITTED entirely (present in
// the diff, absent from accounting) is also P0.
function deletionGaps(verified: VerifiedAuditReport, evidence: SupervisorEvidence): NormalizedFinding[] {
  const gaps: NormalizedFinding[] = [];
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
  const declared = new Set(verified.report.deletionAccounting.map((entry) => entry.path));
  for (const [path, info] of recomputeDeletions(evidence.diff)) {
    if (info.deletedLines === 0 || declared.has(path)) continue;
    gaps.push(
      synthesized(
        `deletion-recomputed-${path}`,
        `Unaccounted ${info.isTest ? "test" : "production"} deletion (supervisor-recomputed)`,
        `The diff deletes ${info.deletedLines} line(s) in ${path} but the worker's deletion accounting omits it entirely.`,
        "recomputed from the PR diff",
      ),
    );
  }
  return gaps;
}

export function triage(verified: VerifiedAuditReport, evidence: SupervisorEvidence): TriageResult {
  const findings = [...verified.report.findings.map(normalizeWorkerFinding), ...synthesizeGaps(verified, evidence)];
  const counts: Record<FindingSeverity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const verdict: ReviewVerdict = counts.P0 > 0 || counts.P1 > 0 ? "REQUEST_CHANGES" : "APPROVE";
  return { verdict, findings, counts };
}

const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$/iu;

function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERN.test(path);
}

// A satisfied-acceptance claim must cite something concrete the supervisor could in
// principle check: a test/command keyword, a runner invocation, a file path, or a
// filename with an extension. Bare prose ("looks done") does not qualify.
const CITATION_PATTERN =
  /\b(test|spec|check|vitest|jest|pytest|pnpm|npm|just|node|cargo|go|make)\b|[\w.-]+\/[\w./-]+|\.[a-z]{2,4}\b/iu;

function citesVerifiableEvidence(evidence: string): boolean {
  return CITATION_PATTERN.test(evidence);
}

// Recompute deleted-line counts per file directly from the unified diff. Deletions
// on a removed file (`+++ /dev/null`) attribute to the old path.
function recomputeDeletions(diff: string): Map<string, { deletedLines: number; isTest: boolean }> {
  const deletions = new Map<string, { deletedLines: number; isTest: boolean }>();
  let oldPath: string | null = null;
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      oldPath = stripDiffPath(line.slice(4));
      current = null;
    } else if (line.startsWith("+++ ")) {
      const newPath = stripDiffPath(line.slice(4));
      current = newPath ?? oldPath;
      if (current !== null && !deletions.has(current)) {
        deletions.set(current, { deletedLines: 0, isTest: isTestPath(current) });
      }
    } else if (line.startsWith("-") && !line.startsWith("---") && current !== null) {
      const entry = deletions.get(current);
      if (entry !== undefined) entry.deletedLines += 1;
    }
  }
  return deletions;
}

function stripDiffPath(raw: string): string | null {
  const value = raw.trim();
  if (value === "/dev/null") return null;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}
