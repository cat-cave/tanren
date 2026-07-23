import { createHash } from "node:crypto";
import { z } from "zod";
import { auditReportSchema, type FindingSeverity } from "./auditReport.js";
import type { AuditArtifactStore } from "./artifactStore.js";
import type { CraConfig } from "./config.js";
import { githubTokenEnvironment } from "./githubApp.js";
import { GithubIssueReconciler } from "./githubIssueReconciliation.js";
import type {
  MergeAuthorizationInput,
  MergeAuthorizationSnapshot,
  MergeAuthorityGateway,
  MergeCallResult,
  IssueClosureReconciliation,
  MergedPullRequest,
} from "./mergeAuthority.js";
import { execute, executeChecked, type CommandExecutor } from "./process.js";
import { bodyHasMarkerForHead, bodyMatchesMarker } from "./reviewMarker.js";
import type { SingletonLease } from "./singleton.js";
import type { PrStateStore } from "./stateStore.js";

const API_VERSION = "2022-11-28";
const pageInfoSchema = z.object({ hasNextPage: z.boolean() });
const prSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  isDraft: z.boolean(),
  title: z.string(),
  body: z.string(),
  updatedAt: z.string(),
  baseRefName: z.string(),
  baseRefOid: z.string(),
  headRefOid: z.string(),
  mergeStateStatus: z.string(),
  mergeable: z.string(),
  commits: z.object({ totalCount: z.number().int(), pageInfo: pageInfoSchema }),
  closingIssuesReferences: z.object({
    nodes: z.array(
      z.object({
        number: z.number().int().positive(),
        state: z.string(),
        timelineItems: z.object({
          nodes: z.array(
            z.object({
              closer: z
                .object({
                  __typename: z.string(),
                  number: z.number().int().positive().optional(),
                  oid: z.string().optional(),
                })
                .nullable(),
            }),
          ),
          pageInfo: pageInfoSchema,
        }),
        blockedBy: z.object({
          nodes: z.array(z.object({ number: z.number().int().positive(), state: z.string() })),
          pageInfo: pageInfoSchema,
        }),
      }),
    ),
    pageInfo: pageInfoSchema,
  }),
  reviews: z.object({
    nodes: z.array(
      z.object({
        databaseId: z.number().int().nullable(),
        author: z.object({ login: z.string() }).nullable(),
        state: z.string(),
        submittedAt: z.string().nullable(),
        body: z.string(),
        commit: z.object({ oid: z.string() }).nullable(),
      }),
    ),
    pageInfo: pageInfoSchema,
  }),
});
const graphSchema = z.object({
  data: z.object({
    viewer: z.object({ login: z.string() }),
    repository: z.object({ viewerPermission: z.string().nullable(), pullRequest: prSchema.nullable() }),
    rateLimit: z.object({ remaining: z.number().int(), cost: z.number().int() }),
  }),
  errors: z.array(z.unknown()).optional(),
});

const SNAPSHOT_QUERY = `query CraMerge($owner:String!,$name:String!,$pr:Int!) {
  viewer { login }
  repository(owner:$owner,name:$name) {
    viewerPermission
    pullRequest(number:$pr) {
      number state isDraft title body updatedAt baseRefName baseRefOid headRefOid mergeStateStatus mergeable
      commits(last:1) { totalCount nodes { commit { oid } } pageInfo { hasNextPage } }
      closingIssuesReferences(first:20) {
        nodes {
          number state
          timelineItems(first:100,itemTypes:[CLOSED_EVENT]) {
            nodes {
              ... on ClosedEvent {
                closer {
                  __typename
                  ... on PullRequest { number }
                  ... on Commit { oid }
                }
              }
            }
            pageInfo { hasNextPage }
          }
          blockedBy(first:50) { nodes { number state } pageInfo { hasNextPage } }
        }
        pageInfo { hasNextPage }
      }
      reviews(last:100) {
        nodes { databaseId author { login } state submittedAt body commit { oid } }
        pageInfo { hasNextPage }
      }
    }
  }
  rateLimit { remaining cost }
}`;

const requiredSchema = z.object({
  contexts: z.array(z.string()).default([]),
  checks: z.array(z.object({ context: z.string() })).default([]),
});
const checkRunsSchema = z.object({
  check_runs: z.array(z.object({ name: z.string(), status: z.string(), conclusion: z.string().nullable() })),
});
const statusesSchema = z.object({ statuses: z.array(z.object({ context: z.string(), state: z.string() })) });
const rulesetsSchema = z.array(z.object({ id: z.number().int().positive() }).passthrough());

function triagedSeverity(finding: z.infer<typeof auditReportSchema>["findings"][number]): FindingSeverity {
  if (
    finding.concerns === "acceptance" ||
    finding.category === "completion" ||
    finding.category === "regression_deletion"
  )
    return "P0";
  if (finding.category === "security" && finding.suggestedSeverity !== "P0") return "P1";
  return finding.suggestedSeverity;
}

export class GithubMergeGateway implements MergeAuthorityGateway {
  private readonly owner: string;
  private readonly name: string;
  private readonly issueReconciler: GithubIssueReconciler;

  public constructor(
    private readonly config: CraConfig,
    private readonly token: string,
    private readonly artifacts: AuditArtifactStore,
    private readonly states: PrStateStore,
    private readonly lease: SingletonLease,
    private readonly executor: CommandExecutor = execute,
  ) {
    [this.owner, this.name] = config.repository.split("/") as [string, string];
    this.issueReconciler = new GithubIssueReconciler(
      config.repository,
      config.github.expectedLogin,
      async (args, input) => await this.gh(args, input),
    );
  }

  public async readFresh(input: MergeAuthorizationInput): Promise<MergeAuthorizationSnapshot> {
    this.lease.assertHeld();
    const graph = await this.graph(input.pr);
    if (graph.errors !== undefined && graph.errors.length > 0) throw new Error("GitHub GraphQL returned errors");
    const pr = graph.data.repository.pullRequest;
    if (pr === null) throw new Error(`PR #${input.pr} is missing`);
    this.assertComplete(pr);
    const [legacyRequired, checks, rulesets, state, artifact] = await Promise.all([
      this.legacyRequiredContexts(),
      this.checks(pr.headRefOid),
      this.rulesets(),
      this.states.read(input.pr),
      this.artifacts.readReport(input.pr, input.auditedHeadSha, input.rubricVersion),
    ]);
    const required = [...new Set([...legacyRequired, ...rulesets.requiredContexts])].sort();
    if (state === undefined) throw new Error("persistent PR state is missing");
    const report = auditReportSchema.parse(artifact.report);
    const craReviewsForHead = pr.reviews.nodes
      .filter(
        (review) =>
          review.author?.login === this.config.github.expectedLogin &&
          review.commit?.oid === pr.headRefOid &&
          bodyHasMarkerForHead(review.body, input.pr, pr.headRefOid),
      )
      .sort(
        (left, right) =>
          (left.submittedAt ?? "").localeCompare(right.submittedAt ?? "") ||
          (left.databaseId ?? 0) - (right.databaseId ?? 0),
      );
    const latestCraReview = craReviewsForHead.at(-1);
    const review = pr.reviews.nodes.find((candidate) => candidate.databaseId === state?.reviewId);
    const reviewIsCurrent =
      review !== undefined &&
      bodyMatchesMarker(review.body, {
        pr: input.pr,
        headSha: input.auditedHeadSha,
        rubricVersion: input.rubricVersion,
      });
    const reviewBodyBlockingSeverities: FindingSeverity[] =
      review !== undefined && /^### P0$/mu.test(review.body)
        ? ["P0"]
        : review !== undefined && /^### P1$/mu.test(review.body)
          ? ["P1"]
          : [];
    const stateHealthy =
      state.lastReviewedHeadSha === input.auditedHeadSha &&
      state.lastReviewedBaseSha === input.auditedBaseSha &&
      state.auditedIssueNumber === artifact.auditedIssueNumber &&
      state.auditedIssueNumber === input.auditedIssueNumber &&
      state.rubricVersion === input.rubricVersion &&
      state.reviewId === review?.databaseId &&
      state.auditStatus === "completed" &&
      state.disposition === "approved";
    return {
      pr: pr.number,
      repository: this.config.repository,
      state: pr.state,
      isDraft: pr.isDraft,
      baseBranch: pr.baseRefName,
      baseSha: pr.baseRefOid,
      headSha: pr.headRefOid,
      title: pr.title,
      body: pr.body,
      historyVersion: `${pr.updatedAt}:${pr.commits.totalCount}:${pr.headRefOid}`,
      rulesetVersion: rulesets.version,
      mergeStateStatus: pr.mergeStateStatus,
      mergeable: pr.mergeable,
      auditedIssueNumber: artifact.auditedIssueNumber,
      sourceIssues: pr.closingIssuesReferences.nodes.map((issue) => ({
        number: issue.number,
        state: issue.state,
        appropriate: issue.number === artifact.auditedIssueNumber && issue.number === state.auditedIssueNumber,
        blockers: issue.blockedBy.nodes,
      })),
      latestCraReview:
        review === undefined || review.databaseId === null
          ? null
          : {
              id: review.databaseId,
              actor: review.author?.login ?? "",
              state: review.state,
              headSha: review.commit?.oid ?? "",
              rubricVersion: reviewIsCurrent ? input.rubricVersion : "",
              reportValid:
                reviewIsCurrent &&
                report.headSha === input.auditedHeadSha &&
                report.baseSha === input.auditedBaseSha &&
                artifact.auditedIssueNumber === input.auditedIssueNumber &&
                report.rubricVersion === input.rubricVersion,
              latest:
                latestCraReview !== undefined &&
                latestCraReview.databaseId !== null &&
                latestCraReview.databaseId === review.databaseId,
              dismissed: review.state === "DISMISSED",
              findingSeverities: [...report.findings.map(triagedSeverity), ...reviewBodyBlockingSeverities],
              unresolvedRequiredChecks: report.unresolvedChecks.map((check) => check.name),
            },
      requiredContexts: required,
      checks,
      rateLimited: graph.data.rateLimit.remaining <= graph.data.rateLimit.cost,
      health: {
        identity: graph.data.viewer.login === this.config.github.expectedLogin,
        permissions: ["ADMIN", "MAINTAIN", "WRITE"].includes(graph.data.repository.viewerPermission ?? ""),
        singletonLease: this.lease.isHeld(),
        statePersistence: stateHealthy,
        readAfterWrite:
          review !== undefined && review.commit?.oid === input.auditedHeadSha && review.databaseId === state.reviewId,
      },
    };
  }

  public async squashMerge(
    pr: number,
    expectedHeadSha: string,
    commitTitle: string,
    commitMessage: string,
  ): Promise<MergeCallResult> {
    this.lease.assertHeld();
    const response = z.object({ merged: z.boolean(), sha: z.string().nullable() }).parse(
      JSON.parse(
        (
          await this.gh(
            ["api", "--method", "PUT", `/repos/${this.owner}/${this.name}/pulls/${pr}/merge`, "--input", "-"],
            JSON.stringify({
              merge_method: "squash",
              sha: expectedHeadSha,
              commit_title: commitTitle,
              commit_message: commitMessage,
            }),
          )
        ).stdout,
      ),
    );
    return { merged: response.merged, mergeCommitSha: response.sha };
  }

  public async readMerged(pr: number): Promise<MergedPullRequest> {
    const response = z
      .object({
        number: z.number(),
        state: z.string(),
        merged: z.boolean(),
        head: z.object({ sha: z.string() }),
        merge_commit_sha: z.string().nullable(),
      })
      .parse(JSON.parse((await this.gh(["api", `/repos/${this.owner}/${this.name}/pulls/${pr}`])).stdout));
    if (response.number !== pr || !response.merged) {
      return { state: response.state.toUpperCase(), headSha: response.head.sha, mergeCommitSha: null };
    }
    return { state: "MERGED", headSha: response.head.sha, mergeCommitSha: response.merge_commit_sha };
  }

  public async readIssueClosureReconciliation(
    pr: number,
    auditedIssue: number,
    mergeCommitSha: string,
  ): Promise<IssueClosureReconciliation> {
    this.lease.assertHeld();
    const [graph, auditedIssueState] = await Promise.all([
      this.graph(pr),
      this.issueReconciler.readState(auditedIssue),
    ]);
    if (graph.errors !== undefined && graph.errors.length > 0) throw new Error("GitHub GraphQL returned errors");
    const pullRequest = graph.data.repository.pullRequest;
    if (pullRequest === null) throw new Error(`PR #${pr} is missing during issue reconciliation`);
    this.assertComplete(pullRequest);
    const closedByPullRequest = pullRequest.closingIssuesReferences.nodes
      .filter(
        (issue) =>
          issue.state.toUpperCase() === "CLOSED" &&
          issue.timelineItems.nodes.some(
            (event) =>
              (event.closer?.["__typename"] === "PullRequest" && event.closer.number === pr) ||
              (event.closer?.["__typename"] === "Commit" && event.closer.oid === mergeCommitSha),
          ),
      )
      .map((issue) => issue.number);
    return {
      closedByPullRequest,
      auditedIssueState,
    };
  }

  public async reopenWronglyClosedIssue(pr: number, issue: number): Promise<void> {
    this.lease.assertHeld();
    await this.issueReconciler.reopenWronglyClosed(pr, issue);
  }

  public async ensureAuditedIssueClosed(_pr: number, issue: number): Promise<void> {
    this.lease.assertHeld();
    await this.issueReconciler.ensureClosed(issue);
  }

  private async graph(pr: number): Promise<z.infer<typeof graphSchema>> {
    return graphSchema.parse(
      JSON.parse(
        (
          await this.gh([
            "api",
            "graphql",
            "-f",
            `query=${SNAPSHOT_QUERY}`,
            "-F",
            `owner=${this.owner}`,
            "-F",
            `name=${this.name}`,
            "-F",
            `pr=${pr}`,
          ])
        ).stdout,
      ),
    );
  }

  private assertComplete(pr: z.infer<typeof prSchema>): void {
    if (
      pr.commits.pageInfo.hasNextPage ||
      pr.closingIssuesReferences.pageInfo.hasNextPage ||
      pr.reviews.pageInfo.hasNextPage ||
      pr.closingIssuesReferences.nodes.some((issue) => issue.timelineItems.pageInfo.hasNextPage) ||
      pr.closingIssuesReferences.nodes.some((issue) => issue.blockedBy.pageInfo.hasNextPage)
    )
      throw new Error("authorization snapshot pagination was incomplete");
  }

  private async legacyRequiredContexts(): Promise<string[]> {
    const response = requiredSchema.parse(
      JSON.parse(
        (
          await this.gh([
            "api",
            `/repos/${this.owner}/${this.name}/branches/${this.config.baseBranch}/protection/required_status_checks`,
          ])
        ).stdout,
      ),
    );
    return [...new Set([...response.contexts, ...response.checks.map((check) => check.context)])].sort();
  }

  private async checks(head: string) {
    const [runsRaw, statusesRaw] = await Promise.all([
      this.gh([
        "api",
        "--method",
        "GET",
        "--paginate",
        `/repos/${this.owner}/${this.name}/commits/${head}/check-runs`,
        "-f",
        "filter=latest",
        "-f",
        "per_page=100",
      ]),
      this.gh(["api", `/repos/${this.owner}/${this.name}/commits/${head}/status`]),
    ]);
    const runs = checkRunsSchema.parse(JSON.parse(runsRaw.stdout));
    const statuses = statusesSchema.parse(JSON.parse(statusesRaw.stdout));
    return [
      ...runs.check_runs.map((run) => ({ ...run, kind: "check_run" as const })),
      ...statuses.statuses.map((status) => ({
        name: status.context,
        status: status.state,
        conclusion: status.state,
        kind: "status_context" as const,
      })),
    ];
  }

  private async rulesets(): Promise<{ version: string; requiredContexts: string[] }> {
    const summariesRaw = await this.gh([
      "api",
      "--method",
      "GET",
      "--paginate",
      `/repos/${this.owner}/${this.name}/rulesets`,
      "-f",
      "includes_parents=true",
      "-f",
      "per_page=100",
    ]);
    const summaries = rulesetsSchema.parse(JSON.parse(summariesRaw.stdout));
    const details = await Promise.all(
      summaries.map(async (summary) =>
        JSON.parse(
          (
            await this.gh([
              "api",
              "--method",
              "GET",
              `/repos/${this.owner}/${this.name}/rulesets/${summary.id}`,
              "-f",
              "includes_parents=true",
            ])
          ).stdout,
        ),
      ),
    );
    const requiredContexts: string[] = [];
    for (const detail of details) {
      const parsed = z
        .object({
          enforcement: z.string().optional(),
          rules: z.array(
            z.object({
              type: z.string(),
              parameters: z
                .object({
                  required_status_checks: z.array(z.object({ context: z.string() })).optional(),
                })
                .optional(),
            }),
          ),
        })
        .parse(detail);
      for (const rule of parsed.rules) {
        if (parsed.enforcement === "disabled") continue;
        if (rule.type === "required_status_checks") {
          for (const check of rule.parameters?.required_status_checks ?? []) requiredContexts.push(check.context);
        }
      }
    }
    return {
      version: createHash("sha256").update(JSON.stringify(details)).digest("hex"),
      requiredContexts: [...new Set(requiredContexts)].sort(),
    };
  }

  private async gh(args: readonly string[], input?: string) {
    const withVersion = [args[0]!, "-H", `X-GitHub-Api-Version: ${API_VERSION}`, ...args.slice(1)];
    return await executeChecked(this.executor, {
      command: this.config.commands.gh,
      args: withVersion,
      env: githubTokenEnvironment(this.token),
      input,
      timeoutMs: 60_000,
    });
  }
}
