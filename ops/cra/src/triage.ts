import type { VerifiedAuditReport } from "./auditAdapter.js";
import type { AuditFinding, FindingCategory, FindingSeverity } from "./auditReport.js";
import type { DiscoveredCheck } from "./discovery.js";

// Supervisor-owned P0-P3 triage under the DONENESS model.
//
// TRUST BOUNDARY: the worker's report is ADVISORY. Its findings ADD to triage, but
// NONE of its self-reported fields can confirm, clear, or suppress a gate. Every
// gate-critical condition below is computed by the supervisor from GROUND TRUTH:
//   - deletions      -> parsed from the real unified diff (worker accounting ignored)
//   - CI checks      -> real GitHub check states (worker `unresolvedChecks` ignored)
//   - acceptance     -> cited evidence must resolve to a real file the supervisor
//                       can locate in the tree (worker keyword prose is not enough)
//   - verification   -> ONE trusted, config-sourced command the supervisor ran in
//                       the sandbox (never a worker-supplied command)
//   - independence   -> computed from PR provenance
// Any P0/P1 -> REQUEST_CHANGES. Only P2/P3 (or none) -> APPROVE.

export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES";

// The GROUND TRUTH the supervisor computed itself — never derived from the worker's
// report.
export interface SupervisorEvidence {
  // The real unified diff (from git in the verified worktree).
  readonly diff: string;
  // The real required-check states fetched from GitHub (CRA-03 discovery).
  readonly requiredChecks: readonly DiscoveredCheck[];
  // Files the supervisor knows exist (the worktree tree and/or changed files), used
  // to resolve acceptance citations.
  readonly knownFiles: readonly string[];
  // Net live-code deletion (deleted minus added live lines) at or above this many
  // lines blocks — the supervisor's mq-16 gate. Sourced from config.audit.deletionGate.
  readonly liveDeletionThreshold: number;
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
  // True when the supervisor computed/forced the severity, independent of any worker
  // suggestion (all supervisor gate findings are forced).
  readonly forced: boolean;
}

export interface TriageResult {
  readonly verdict: ReviewVerdict;
  readonly findings: readonly NormalizedFinding[];
  readonly counts: Readonly<Record<FindingSeverity, number>>;
}

// ---- Advisory worker findings (ADD only) -----------------------------------------

const FORCED_P0_CATEGORIES: ReadonlySet<FindingCategory> = new Set(["completion", "regression_deletion"]);

function finalSeverity(finding: AuditFinding): { severity: FindingSeverity; forced: boolean } {
  if (finding.concerns === "acceptance") return { severity: "P0", forced: finding.suggestedSeverity !== "P0" };
  if (FORCED_P0_CATEGORIES.has(finding.category)) return { severity: "P0", forced: finding.suggestedSeverity !== "P0" };
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

// ---- Supervisor-computed gates (cannot be cleared by the worker) ------------------

function synthesizeGates(verified: VerifiedAuditReport, evidence: SupervisorEvidence): NormalizedFinding[] {
  return [
    ...verificationGate(verified),
    ...deletionGate(evidence),
    ...checkGate(evidence),
    ...acceptanceGate(verified, evidence),
    ...independenceGate(verified),
    ...workerAdmittedFailOpen(verified),
  ];
}

// The supervisor's own trusted verification (a config-sourced command it ran in the
// sandbox). A run that could not happen is unproven acceptance (P0); a run that
// failed means the PR fails its own acceptance on a clean checkout (P1).
function verificationGate(verified: VerifiedAuditReport): NormalizedFinding[] {
  if (!verified.sandbox.ran) {
    return [
      synthesized(
        "verification-unrun",
        "Trusted acceptance verification could not run",
        "The supervisor's trusted verification command did not complete in the sandbox, so acceptance is unproven.",
        verified.sandbox.detail,
      ),
    ];
  }
  if (!verified.sandbox.passed) {
    return [
      synthesized(
        "verification-failed",
        "PR fails the trusted acceptance verification",
        "The supervisor ran the trusted verification command on the PR head in the sandbox and it failed.",
        verified.sandbox.detail,
        "P1",
      ),
    ];
  }
  return [];
}

// Deletions are computed from the REAL diff; the worker's `deletionAccounting` is
// ignored for the gate (it cannot suppress a deletion the diff shows). Net test-line
// regression blocks; net live deletion at/above the configured threshold blocks.
function deletionGate(evidence: SupervisorEvidence): NormalizedFinding[] {
  const stats = computeDiffStats(evidence.diff);
  let deletedTest = 0;
  let addedTest = 0;
  let deletedLive = 0;
  let addedLive = 0;
  for (const file of stats.values()) {
    if (file.isTest) {
      deletedTest += file.deleted;
      addedTest += file.added;
    } else {
      deletedLive += file.deleted;
      addedLive += file.added;
    }
  }
  const gaps: NormalizedFinding[] = [];
  if (deletedTest > addedTest) {
    gaps.push(
      synthesized(
        "deletion-test-regression",
        "Net test deletion (supervisor-computed)",
        `The diff deletes ${deletedTest} test line(s) and adds only ${addedTest}: a net test-count regression. Deleting tests cannot be self-cleared by the audit worker (the mq-16 class).`,
        "computed from the PR diff",
        "P1",
      ),
    );
  }
  if (deletedLive - addedLive >= evidence.liveDeletionThreshold) {
    gaps.push(
      synthesized(
        "deletion-live-substantial",
        "Substantial net live-code deletion (supervisor-computed)",
        `The diff removes a net ${deletedLive - addedLive} live-code line(s) (>= ${evidence.liveDeletionThreshold}). Substantial deletion cannot be cleared by the worker's accounting; the worker may EXPLAIN it, but it does not lift the gate.`,
        "computed from the PR diff",
        "P1",
      ),
    );
  }
  return gaps;
}

// Required-check states come from GitHub (ground truth). Any non-success required
// check blocks; the worker's `unresolvedChecks` field is not consulted.
function checkGate(evidence: SupervisorEvidence): NormalizedFinding[] {
  return evidence.requiredChecks
    .filter(isBlockingCheck)
    .map((check) =>
      synthesized(
        `check-${check.name}`,
        "Required CI check not passing",
        `Required check ${check.name} is ${check.status}/${check.conclusion ?? "none"} per GitHub. An audit cannot approve over a non-passing required check.`,
        "fetched from GitHub check states",
        "P1",
      ),
    );
}

// Acceptance cannot be self-cleared by the worker. An unmet trace is P0. A satisfied
// trace must cite evidence the supervisor can resolve to a real file in the tree;
// keyword prose ("just looks good") does not qualify.
function acceptanceGate(verified: VerifiedAuditReport, evidence: SupervisorEvidence): NormalizedFinding[] {
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
    } else if (!locatesRealFile(trace.evidence, evidence.knownFiles)) {
      gaps.push(
        synthesized(
          `acceptance-unverifiable-${index}`,
          "Acceptance claimed satisfied without locatable evidence",
          `The acceptance statement "${trace.statement}" is claimed satisfied but its evidence names no file the supervisor can locate in the tree.`,
          trace.evidence,
        ),
      );
    }
  });
  return gaps;
}

function independenceGate(verified: VerifiedAuditReport): NormalizedFinding[] {
  if (verified.independence.confirmed) return [];
  return [
    synthesized(
      "independence-unconfirmed",
      "Cross-model audit independence not confirmed",
      "The audit worker could not be confirmed independent of the contributor.",
      verified.independence.reason,
    ),
  ];
}

// The worker may only SELF-INCRIMINATE via its report: a mandatory control it itself
// reports as not-rejected is an admitted fail-open boundary (P0). It cannot use the
// same field to clear anything.
function workerAdmittedFailOpen(verified: VerifiedAuditReport): NormalizedFinding[] {
  return verified.report.negativeControls
    .filter((control) => control.mandatory && !control.rejected)
    .map((control) =>
      synthesized(
        `control-admitted-failopen-${control.id}`,
        "Worker reports a mandatory fail-closed boundary did not reject",
        `The worker's own report marks mandatory negative control ${control.id} as not rejected: an admitted fail-open on a critical boundary.`,
        control.observedResult,
      ),
    );
}

export function triage(verified: VerifiedAuditReport, evidence: SupervisorEvidence): TriageResult {
  const findings = [...verified.report.findings.map(normalizeWorkerFinding), ...synthesizeGates(verified, evidence)];
  const counts: Record<FindingSeverity, number> = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const verdict: ReviewVerdict = counts.P0 > 0 || counts.P1 > 0 ? "REQUEST_CHANGES" : "APPROVE";
  return { verdict, findings, counts };
}

// ---- Ground-truth helpers --------------------------------------------------------

const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$/iu;

function isTestPath(path: string): boolean {
  return TEST_PATH_PATTERN.test(path);
}

function isBlockingCheck(check: DiscoveredCheck): boolean {
  if (check.kind === "status_context") return check.status.toUpperCase() !== "SUCCESS";
  if (check.status.toUpperCase() !== "COMPLETED") return true;
  const conclusion = (check.conclusion ?? "").toUpperCase();
  return conclusion !== "SUCCESS" && conclusion !== "NEUTRAL" && conclusion !== "SKIPPED";
}

// A satisfied-acceptance claim must NAME a file the supervisor can locate. Extract
// filename-with-extension tokens and match them (by suffix) against the known tree.
const FILE_TOKEN_PATTERN = /[\w][\w./-]*\.[A-Za-z]{1,6}\b/gu;

function locatesRealFile(evidence: string, knownFiles: readonly string[]): boolean {
  const tokens = evidence.match(FILE_TOKEN_PATTERN);
  if (tokens === null) return false;
  return tokens.some((token) =>
    knownFiles.some((file) => file === token || file.endsWith(`/${token}`) || file.endsWith(token)),
  );
}

interface FileDelta {
  added: number;
  deleted: number;
  isTest: boolean;
}

// Compute added/deleted line counts per file directly from the unified diff.
function computeDiffStats(diff: string): Map<string, FileDelta> {
  const stats = new Map<string, FileDelta>();
  let oldPath: string | null = null;
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      oldPath = stripDiffPath(line.slice(4));
      current = null;
    } else if (line.startsWith("+++ ")) {
      current = stripDiffPath(line.slice(4)) ?? oldPath;
      if (current !== null && !stats.has(current))
        stats.set(current, { added: 0, deleted: 0, isTest: isTestPath(current) });
    } else if (current !== null) {
      const entry = stats.get(current);
      if (entry === undefined) continue;
      if (line.startsWith("-") && !line.startsWith("---")) entry.deleted += 1;
      else if (line.startsWith("+") && !line.startsWith("+++")) entry.added += 1;
    }
  }
  return stats;
}

function stripDiffPath(raw: string): string | null {
  const value = raw.trim();
  if (value === "/dev/null") return null;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}
