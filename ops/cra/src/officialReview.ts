import type { CraConfig } from "./config.js";
import type { DiscoveredReview } from "./discovery.js";
import { githubTokenEnvironment } from "./githubApp.js";
import { execute, executeChecked, type CommandExecutor } from "./process.js";
import { buildReviewMarker, bodyMatchesMarker, type ReviewMarkerKey } from "./reviewMarker.js";
import type { NormalizedFinding, ReviewVerdict, TriageResult } from "./triage.js";

const API_VERSION = "2022-11-28";
const SEVERITY_ORDER = ["P0", "P1", "P2", "P3"] as const;

export interface OfficialReviewResult {
  // False when an existing review already carried the marker for this head: the
  // idempotent no-op that a re-poll produces.
  readonly posted: boolean;
  readonly reviewId: number | null;
  readonly verdict: ReviewVerdict;
}

interface ReviewComment {
  readonly path: string;
  readonly line: number;
  readonly side: "LEFT" | "RIGHT";
  readonly body: string;
}

function findingLine(finding: NormalizedFinding): string {
  const location = finding.locatable ? ` (${finding.path}:${String(finding.line)})` : "";
  return `- **${finding.severity}** ${finding.title}${location}: ${finding.evidence}`;
}

function buildBody(marker: string, verdict: ReviewVerdict, triage: TriageResult): string {
  const header =
    verdict === "APPROVE"
      ? "The linked issue is done and proved. Approving. Any P2/P3 items below become claimable follow-up issues after merge."
      : "The linked issue is NOT done. Requesting changes — P0/P1 findings must be repaired on this branch.";
  const sections: string[] = [marker, header];
  for (const severity of SEVERITY_ORDER) {
    const inSeverity = triage.findings.filter((finding) => finding.severity === severity);
    if (inSeverity.length === 0) continue;
    sections.push(`### ${severity}\n${inSeverity.map((finding) => findingLine(finding)).join("\n")}`);
  }
  if (triage.findings.length === 0) sections.push("No findings.");
  return sections.join("\n\n");
}

// Locatable findings become inline comments anchored to a changed line; general or
// missing-code findings remain summarized in the body with exact evidence.
function buildComments(triage: TriageResult): ReviewComment[] {
  const comments: ReviewComment[] = [];
  for (const finding of triage.findings) {
    if (finding.locatable && finding.path !== null && finding.line !== null) {
      comments.push({
        path: finding.path,
        line: finding.line,
        side: finding.side ?? "RIGHT",
        body: `**${finding.severity}** ${finding.title}\n\n${finding.body}`,
      });
    }
  }
  return comments;
}

export class OfficialReviewPoster {
  public constructor(
    private readonly config: CraConfig,
    private readonly token: string,
    private readonly executor: CommandExecutor = execute,
  ) {}

  // Posts EXACTLY ONE official review bound to the audited head SHA, or no-ops when
  // an existing review already carries the (pr, head, rubric) marker.
  public async post(
    key: ReviewMarkerKey,
    triage: TriageResult,
    existingReviews: readonly DiscoveredReview[],
  ): Promise<OfficialReviewResult> {
    const marker = buildReviewMarker(key);
    const already = existingReviews.find(
      (review) => review.author === this.config.github.expectedLogin && bodyMatchesMarker(review.body, key),
    );
    if (already !== undefined) {
      return { posted: false, reviewId: already.databaseId, verdict: triage.verdict };
    }
    const payload = {
      commit_id: key.headSha,
      event: triage.verdict,
      body: buildBody(marker, triage.verdict, triage),
      comments: buildComments(triage),
    };
    const [owner, name] = this.config.repository.split("/") as [string, string];
    const result = await executeChecked(this.executor, {
      command: this.config.commands.gh,
      args: [
        "api",
        "--method",
        "POST",
        "-H",
        "Accept: application/vnd.github+json",
        "-H",
        `X-GitHub-Api-Version: ${API_VERSION}`,
        `/repos/${owner}/${name}/pulls/${key.pr}/reviews`,
        "--input",
        "-",
      ],
      env: githubTokenEnvironment(this.token),
      input: JSON.stringify(payload),
      timeoutMs: 60_000,
    });
    const response: unknown = JSON.parse(result.stdout);
    const reviewId = this.assertPostedReview(response, key);
    return { posted: true, reviewId, verdict: triage.verdict };
  }

  // Read-after-write: confirm the review landed on the exact audited head with the
  // requested verdict before local state advances. Anything else fails loud.
  private assertPostedReview(response: unknown, key: ReviewMarkerKey): number {
    if (typeof response !== "object" || response === null) throw new Error("review response was not an object");
    const record = response as Record<string, unknown>;
    const id = record["id"];
    const commitId = record["commit_id"];
    const state = record["state"];
    if (typeof id !== "number") throw new Error("review response missing numeric id");
    if (commitId !== key.headSha) {
      throw new Error(`review landed on ${String(commitId)}, expected audited head ${key.headSha}`);
    }
    if (state !== "APPROVED" && state !== "CHANGES_REQUESTED") {
      throw new Error(`unexpected review state ${String(state)}`);
    }
    return id;
  }
}
