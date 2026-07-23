import { createHash } from "node:crypto";
import type { NormalizedFinding } from "./triage.js";

export interface FindingIssueContext {
  readonly repository: string;
  readonly pr: number;
  readonly headSha: string;
  readonly reviewId: number;
  readonly bucketLabel: string;
  readonly blockedBy: readonly number[];
}

export interface CreatedFindingIssue {
  readonly number: number;
  readonly marker: string;
  readonly findingId: string;
}

export interface FindingIssueCreate {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

export interface FindingIssueGateway {
  findByMarker(marker: string): Promise<number | null>;
  create(input: FindingIssueCreate): Promise<number>;
  listBlockedBy(issue: number): Promise<readonly number[]>;
  issueDatabaseId(issue: number): Promise<number>;
  addBlockedBy(issue: number, blockerDatabaseId: number): Promise<void>;
}

function markerFor(context: FindingIssueContext, finding: NormalizedFinding): string {
  const markerId =
    /^[A-Za-z0-9_.-]+$/u.test(finding.id) && !finding.id.includes("--")
      ? finding.id
      : `sha256-${createHash("sha256").update(finding.id).digest("hex")}`;
  return `CRA-Finding: ${context.repository}#${context.pr}/${context.headSha}/${markerId}`;
}

function issueType(finding: NormalizedFinding): "bug" | "enhancement" {
  return ["correctness", "regression_deletion", "security"].includes(finding.category) ? "bug" : "enhancement";
}

function issueBody(context: FindingIssueContext, finding: NormalizedFinding, marker: string): string {
  const positive = finding.fixDirection ?? finding.body;
  return [
    `<!-- ${marker} -->`,
    "## Summary",
    finding.body,
    "",
    `Evidence: ${finding.evidence}`,
    `Source: ${context.repository}#${context.pr}, CRA review ${context.reviewId}, head \`${context.headSha}\`.`,
    "",
    "## Acceptance",
    `- ${positive}`,
    `- Negative control: reproduce the pre-fix failure described by finding \`${finding.id}\` and prove it is rejected or no longer occurs.`,
  ].join("\n");
}

// Route only deferred findings. Blocking P0/P1 findings can never be laundered into
// follow-up issues, even if a caller accidentally includes them.
export async function routeDeferredFindings(
  gateway: FindingIssueGateway,
  context: FindingIssueContext,
  findings: readonly NormalizedFinding[],
): Promise<CreatedFindingIssue[]> {
  const routed: CreatedFindingIssue[] = [];
  for (const finding of findings) {
    if ((finding.severity !== "P2" && finding.severity !== "P3") || finding.concerns !== "new_work") continue;
    const marker = markerFor(context, finding);
    let number = await gateway.findByMarker(marker);
    if (number === null) {
      number = await gateway.create({
        title: `[${finding.severity}] ${finding.title}`,
        body: issueBody(context, finding, marker),
        labels: [issueType(finding), context.bucketLabel, finding.severity],
      });
    }
    const existingBlockers = new Set(await gateway.listBlockedBy(number));
    for (const blocker of [...new Set(context.blockedBy)].sort((left, right) => left - right)) {
      if (existingBlockers.has(blocker)) continue;
      await gateway.addBlockedBy(number, await gateway.issueDatabaseId(blocker));
      existingBlockers.add(blocker);
    }
    routed.push({ number, marker, findingId: finding.id });
  }
  return routed;
}
