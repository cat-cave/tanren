import type { VerifiedAuditReport } from "./auditAdapter.js";
import type { AuditFinding, FindingCategory, FindingSeverity } from "./auditReport.js";
import type { DiscoveredCheck } from "./discovery.js";

// Supervisor-owned P0-P3 triage under the DONENESS model.
//
// TRUST BOUNDARY: the worker's report is ADVISORY. Its findings ADD to triage, but
// NO worker-authored field can confirm, clear, or suppress a gate. Every gate below
// is computed by the supervisor from GROUND TRUTH it ASSEMBLED ITSELF (see
// GroundTruthAssembler): the real diff + tree from git, the real branch-protection
// required-check set + head check states from GitHub, and one trusted config-sourced
// verification command run in the sandbox. Where a condition cannot be verified the
// rule is FAIL CLOSED. Any P0/P1 -> REQUEST_CHANGES; only P2/P3 (or none) -> APPROVE.

export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES";

// The GROUND TRUTH the supervisor assembled itself — never accepted from a caller.
export interface SupervisorEvidence {
  // The real unified diff (git diff base...head), from the fetched worktree.
  readonly diff: string;
  // The real worktree tree (git ls-files) — the set of files that actually exist.
  readonly knownFiles: readonly string[];
  // The required-check contexts from GitHub branch protection.
  readonly requiredContexts: readonly string[];
  // The real head check states from GitHub.
  readonly actualChecks: readonly DiscoveredCheck[];
  // Net live-code deletion (deleted minus added live lines) at or above this many
  // lines blocks — the supervisor's mq-16 gate. From config.audit.deletionGate.
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

// ---- Supervisor-computed gates (never cleared by the worker) ---------------------

function synthesizeGates(verified: VerifiedAuditReport, evidence: SupervisorEvidence): NormalizedFinding[] {
  const analysis = analyzeDiff(evidence.diff);
  return [
    ...verificationGate(verified),
    ...deletionGate(analysis, evidence.liveDeletionThreshold),
    ...checkGate(evidence),
    ...acceptanceGate(verified, evidence, analysis),
    ...independenceGate(verified),
    ...workerAdmittedFailOpen(verified),
  ];
}

function verificationGate(verified: VerifiedAuditReport): NormalizedFinding[] {
  if (!verified.sandbox.ran) {
    return [
      synthesized(
        "verification-unrun",
        "Trusted acceptance verification could not run",
        "The supervisor's trusted verification command did not complete in the sandbox (or was vacuous), so acceptance is unproven.",
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

// Deletions are computed from the REAL diff (text hunks, binary deletions, and 100%
// renames). Any net test deletion or removed test file blocks; net live deletion at
// or above threshold, or a binary/rename removal of a live file the supervisor cannot
// line-account, blocks. The worker's deletionAccounting is never consulted.
function deletionGate(analysis: DiffAnalysis, threshold: number): NormalizedFinding[] {
  const gaps: NormalizedFinding[] = [];
  const netTest = analysis.deletedTestLines - analysis.addedTestLines;
  if (netTest > 0 || analysis.removedTestFiles.size > 0) {
    gaps.push(
      synthesized(
        "deletion-test-regression",
        "Test deletion (supervisor-computed)",
        `The diff removes tests (net ${netTest} line(s); ${analysis.removedTestFiles.size} removed test file(s)). Deleting tests cannot be self-cleared by the worker (the mq-16 class).`,
        "computed from the PR diff",
        "P1",
      ),
    );
  }
  const netLive = analysis.deletedLiveLines - analysis.addedLiveLines;
  if (netLive >= threshold || analysis.removedLiveUnmeasured.size > 0) {
    gaps.push(
      synthesized(
        "deletion-live-substantial",
        "Substantial or unmeasurable live-code deletion (supervisor-computed)",
        `The diff removes a net ${netLive} live line(s) (threshold ${threshold}) plus ${analysis.removedLiveUnmeasured.size} binary/100%-rename removal(s). The worker may EXPLAIN it but cannot lift the gate.`,
        "computed from the PR diff",
        "P1",
      ),
    );
  }
  return gaps;
}

// Required checks come from GitHub branch protection (ground truth). Every required
// context must be present and SUCCESS; missing / pending / SKIPPED / NEUTRAL / any
// non-SUCCESS state blocks. An empty required set cannot mean "all clear" — it means
// the supervisor could not confirm a CI gate, which is fail-closed.
function checkGate(evidence: SupervisorEvidence): NormalizedFinding[] {
  if (evidence.requiredContexts.length === 0) {
    return [
      synthesized(
        "checks-unconfirmed",
        "No required checks could be confirmed",
        "Branch protection reported no required checks; the supervisor cannot confirm a CI gate, so it fails closed.",
        "assembled from GitHub branch protection",
        "P1",
      ),
    ];
  }
  const gaps: NormalizedFinding[] = [];
  for (const context of evidence.requiredContexts) {
    const check = evidence.actualChecks.find((candidate) => candidate.name === context);
    if (check === undefined) {
      gaps.push(
        synthesized(
          `check-missing-${context}`,
          "Required CI check missing",
          `Required check ${context} has no result on the audited head.`,
          "assembled from GitHub check states",
          "P1",
        ),
      );
    } else if (!checkPasses(check)) {
      gaps.push(
        synthesized(
          `check-${context}`,
          "Required CI check not passing",
          `Required check ${context} is ${check.status}/${check.conclusion ?? "none"} — not SUCCESS.`,
          "assembled from GitHub check states",
          "P1",
        ),
      );
    }
  }
  return gaps;
}

// Acceptance cannot be worker-cleared. An unmet trace is P0. A satisfied trace is
// cleared ONLY when its evidence names a real repo-relative TEST file that exists in
// the tree AND is part of this PR's diff — tying the claim to a real, PR-included
// test. Keyword prose or a suffix token ("see t.ts") does not clear it.
function acceptanceGate(
  verified: VerifiedAuditReport,
  evidence: SupervisorEvidence,
  analysis: DiffAnalysis,
): NormalizedFinding[] {
  const knownFiles = new Set(evidence.knownFiles);
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
    } else if (!citesRealChangedTest(trace.evidence, knownFiles, analysis.changedFiles)) {
      gaps.push(
        synthesized(
          `acceptance-unverifiable-${index}`,
          "Acceptance claimed satisfied without a real, PR-included test",
          `The acceptance statement "${trace.statement}" cites no repo-relative test file that both exists in the tree and is changed by this PR; the claim is UNPROVEN.`,
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

const TEST_SEGMENTS: ReadonlySet<string> = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);

// Path-SEGMENT based classification (not substring): `contests/` is not a test dir.
function isTestPath(path: string): boolean {
  const segments = path.split("/");
  if (segments.some((segment) => TEST_SEGMENTS.has(segment.toLowerCase()))) return true;
  const base = segments.at(-1) ?? "";
  return /\.(test|spec)\.[a-z0-9]+$/iu.test(base);
}

function checkPasses(check: DiscoveredCheck): boolean {
  if (check.kind === "status_context") return check.status.toUpperCase() === "SUCCESS";
  return check.status.toUpperCase() === "COMPLETED" && (check.conclusion ?? "").toUpperCase() === "SUCCESS";
}

// Repo-relative path tokens: must contain a slash AND a file extension, so a bare
// suffix like "t.ts" is not accepted.
const REPO_PATH_TOKEN = /[\w][\w.-]*(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,6}\b/gu;

function citesRealChangedTest(
  evidence: string,
  knownFiles: ReadonlySet<string>,
  changedFiles: ReadonlySet<string>,
): boolean {
  const tokens = evidence.match(REPO_PATH_TOKEN);
  if (tokens === null) return false;
  return tokens.some((token) => knownFiles.has(token) && isTestPath(token) && changedFiles.has(token));
}

interface DiffAnalysis {
  readonly deletedTestLines: number;
  readonly addedTestLines: number;
  readonly deletedLiveLines: number;
  readonly addedLiveLines: number;
  readonly removedTestFiles: ReadonlySet<string>;
  readonly removedLiveUnmeasured: ReadonlySet<string>;
  readonly changedFiles: ReadonlySet<string>;
}

// Parse the unified diff for line counts, file removals, and the changed-file set.
//
// Attribution is PRE-IMAGE for deletions and POST-IMAGE for additions: deleted lines
// are classified by the OLD (from) path, added lines by the NEW (to) path. This
// closes the partial-rename laundering evasion — renaming a test out of the test tree
// (e.g. `tests/gate.test.ts -> src/gate.ts` at 80%) can NOT reclassify the gutted
// test's deleted lines as live lines. A rename whose source is a test path but whose
// destination is not is a test-file removal at ANY similarity.
function analyzeDiff(diff: string): DiffAnalysis {
  let deletedTestLines = 0;
  let addedTestLines = 0;
  let deletedLiveLines = 0;
  let addedLiveLines = 0;
  const removedTestFiles = new Set<string>();
  const removedLiveUnmeasured = new Set<string>();
  const changedFiles = new Set<string>();

  // oldPath = pre-image (classifies deletions); newPath = post-image (classifies
  // additions). Both come from `---`/`+++`, `rename from/to`, or the `diff --git` line.
  let oldPath: string | null = null;
  let newPath: string | null = null;
  let similarity = 0;

  const markRemoved = (path: string, measured: boolean): void => {
    changedFiles.add(path);
    if (isTestPath(path)) removedTestFiles.add(path);
    else if (!measured) removedLiveUnmeasured.add(path);
  };

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      similarity = 0;
      oldPath = null;
      newPath = null;
      const match = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      if (match !== null) {
        oldPath = match[1] ?? null;
        newPath = match[2] ?? null;
      }
    } else if (line.startsWith("similarity index ")) {
      similarity = Number.parseInt(line.slice("similarity index ".length), 10);
    } else if (line.startsWith("rename from ")) {
      oldPath = line.slice("rename from ".length).trim();
      changedFiles.add(oldPath);
    } else if (line.startsWith("rename to ")) {
      newPath = line.slice("rename to ".length).trim();
      changedFiles.add(newPath);
      // Classify the rename by its OLD path at ANY similarity: a test renamed out of
      // the test tree is a test removal; a pure (100%) live move is an unmeasurable
      // live removal. A test->test rename is a legit move (not flagged here; a gutted
      // body still surfaces via pre-image deleted-test-line attribution below).
      if (isTestPath(oldPath ?? "") && !isTestPath(newPath)) markRemoved(oldPath ?? newPath, true);
      else if (oldPath !== null && !isTestPath(oldPath) && similarity === 100) removedLiveUnmeasured.add(oldPath);
    } else if (line.startsWith("Binary files ")) {
      const match = /^Binary files a\/(.+) and (.+) differ$/u.exec(line);
      if (match !== null && match[1] !== undefined) {
        changedFiles.add(match[1]);
        if (match[2] === "/dev/null") markRemoved(match[1], false);
      }
    } else if (line.startsWith("--- ")) {
      oldPath = stripDiffPath(line.slice(4));
    } else if (line.startsWith("+++ ")) {
      newPath = stripDiffPath(line.slice(4));
      if (newPath !== null) changedFiles.add(newPath);
      else if (oldPath !== null) changedFiles.add(oldPath);
      if (newPath === null && oldPath !== null) markRemoved(oldPath, true);
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      const classifyBy = oldPath ?? newPath;
      if (classifyBy !== null) {
        if (isTestPath(classifyBy)) deletedTestLines += 1;
        else deletedLiveLines += 1;
      }
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      const classifyBy = newPath ?? oldPath;
      if (classifyBy !== null) {
        if (isTestPath(classifyBy)) addedTestLines += 1;
        else addedLiveLines += 1;
      }
    }
  }
  return {
    deletedTestLines,
    addedTestLines,
    deletedLiveLines,
    addedLiveLines,
    removedTestFiles,
    removedLiveUnmeasured,
    changedFiles,
  };
}

function stripDiffPath(raw: string): string | null {
  const value = raw.trim();
  if (value === "/dev/null") return null;
  if (value.startsWith("a/") || value.startsWith("b/")) return value.slice(2);
  return value;
}
