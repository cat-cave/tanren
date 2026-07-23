import { z } from "zod";
import type { CraConfig } from "./config.js";
import { githubTokenEnvironment } from "./githubApp.js";
import { execute, executeChecked, type CommandExecutor } from "./process.js";
import type { PrState } from "./stateSchemas.js";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/u);
const actorSchema = z.object({ login: z.string() }).nullable();
const pageInfoSchema = z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() });
const activitySchema = z.object({ author: actorSchema, createdAt: z.string(), body: z.string().default("") });
const commitSchema = z.object({
  commit: z.object({ committedDate: z.string(), author: z.object({ user: actorSchema }).nullable() }),
});
const reviewSchema = z.object({
  id: z.string(),
  databaseId: z.number().int().nullable(),
  author: actorSchema,
  state: z.string(),
  submittedAt: z.string().nullable(),
  body: z.string(),
  commit: z.object({ oid: shaSchema }).nullable(),
});
const checkSchema = z.object({
  __typename: z.string(),
  name: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  context: z.string().optional(),
  state: z.string().optional(),
});
const issueSchema = z.object({
  number: z.number().int().positive(),
  state: z.string(),
  blockedBy: z.object({
    nodes: z.array(z.object({ number: z.number().int().positive(), state: z.string() })),
    pageInfo: pageInfoSchema,
  }),
});
const pullRequestSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  author: actorSchema,
  baseRefName: z.string(),
  baseRefOid: shaSchema,
  headRefOid: shaSchema,
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  closingIssuesReferences: z.object({ nodes: z.array(issueSchema), pageInfo: pageInfoSchema }),
  comments: z.object({ nodes: z.array(activitySchema), pageInfo: pageInfoSchema }),
  commits: z.object({ nodes: z.array(commitSchema), pageInfo: pageInfoSchema }),
  reviews: z.object({ nodes: z.array(reviewSchema), pageInfo: pageInfoSchema }),
  statusCheckRollup: z
    .object({ contexts: z.object({ nodes: z.array(checkSchema), pageInfo: pageInfoSchema }) })
    .nullable(),
});
const responseSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({ nodes: z.array(pullRequestSchema), pageInfo: pageInfoSchema }),
    }),
  }),
  errors: z.array(z.unknown()).optional(),
});

export interface DiscoveredCheck {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly kind: "check_run" | "status_context";
}

export interface DiscoveredReview {
  readonly id: string;
  readonly databaseId: number | null;
  readonly author: string | null;
  readonly state: string;
  readonly submittedAt: string | null;
  readonly body: string;
  readonly commitSha: string | null;
}

export interface DiscoveredPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly isDraft: boolean;
  readonly author: string | null;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly mergeStateStatus: string;
  readonly reviewDecision: string | null;
  readonly closingIssues: readonly {
    number: number;
    state: string;
    blockers: readonly { number: number; state: string }[];
    dependenciesReady: boolean;
  }[];
  readonly checks: readonly DiscoveredCheck[];
  readonly reviews: readonly DiscoveredReview[];
  readonly firstAuthorActivityAt: string;
  readonly lastAuthorActivityAt: string;
}

const DISCOVERY_QUERY = `query CraDiscovery($owner:String!,$name:String!,$cursor:String) {
  repository(owner:$owner,name:$name) {
    pullRequests(first:50,after:$cursor,states:OPEN,orderBy:{field:CREATED_AT,direction:ASC}) {
      nodes {
        number title body state isDraft createdAt updatedAt baseRefName baseRefOid headRefOid mergeStateStatus reviewDecision
        author { login }
        closingIssuesReferences(first:20) { nodes { number state blockedBy(first:50) { nodes { number state } pageInfo { hasNextPage endCursor } } } pageInfo { hasNextPage endCursor } }
        comments(last:100) { nodes { author { login } createdAt body } pageInfo { hasNextPage endCursor } }
        commits(last:100) { nodes { commit { committedDate author { user { login } } } } pageInfo { hasNextPage endCursor } }
        reviews(last:100) { nodes { id databaseId author { login } state submittedAt body commit { oid } } pageInfo { hasNextPage endCursor } }
        statusCheckRollup { contexts(first:100) { nodes { __typename ... on CheckRun { name status conclusion } ... on StatusContext { context state } } pageInfo { hasNextPage endCursor } } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

function assertComplete(pr: z.infer<typeof pullRequestSchema>): void {
  const connections = [pr.closingIssuesReferences, pr.comments, pr.commits, pr.reviews];
  if (connections.some((connection) => connection.pageInfo.hasNextPage)) {
    throw new Error(`PR #${pr.number} discovery connection exceeded its fail-closed page limit`);
  }
  for (const issue of pr.closingIssuesReferences.nodes) {
    if (issue.blockedBy.pageInfo.hasNextPage)
      throw new Error(`issue #${issue.number} blockers exceeded the page limit`);
  }
  if (pr.statusCheckRollup?.contexts.pageInfo.hasNextPage === true) {
    throw new Error(`PR #${pr.number} checks exceeded the page limit`);
  }
}

function normalize(pr: z.infer<typeof pullRequestSchema>): DiscoveredPullRequest {
  assertComplete(pr);
  const author = pr.author?.login ?? null;
  const authorActivity = [pr.createdAt];
  for (const comment of pr.comments.nodes) {
    if (comment.author?.login === author && isSubstantiveAuthorReply(comment.body)) {
      authorActivity.push(comment.createdAt);
    }
  }
  for (const commit of pr.commits.nodes) {
    if (commit.commit.author?.user?.login === author) authorActivity.push(commit.commit.committedDate);
  }
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    isDraft: pr.isDraft,
    author,
    baseBranch: pr.baseRefName,
    baseSha: pr.baseRefOid,
    headSha: pr.headRefOid,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    closingIssues: pr.closingIssuesReferences.nodes.map((issue) => ({
      number: issue.number,
      state: issue.state,
      blockers: issue.blockedBy.nodes,
      dependenciesReady: issue.blockedBy.nodes.every((blocker) => blocker.state === "CLOSED"),
    })),
    checks: (pr.statusCheckRollup?.contexts.nodes ?? []).map((check) =>
      check["__typename"] === "CheckRun"
        ? {
            name: check.name ?? "",
            status: check.status ?? "UNKNOWN",
            conclusion: check.conclusion ?? null,
            kind: "check_run",
          }
        : {
            name: check.context ?? "",
            status: check.state ?? "UNKNOWN",
            conclusion: check.state ?? null,
            kind: "status_context",
          },
    ),
    reviews: pr.reviews.nodes.map((review) => ({
      id: review.id,
      databaseId: review.databaseId,
      author: review.author?.login ?? null,
      state: review.state,
      submittedAt: review.submittedAt,
      body: review.body,
      commitSha: review.commit?.oid ?? null,
    })),
    firstAuthorActivityAt: pr.createdAt,
    lastAuthorActivityAt: [...authorActivity].sort().at(-1) ?? pr.createdAt,
  };
}

// Bot churn, reactions, and label-only discussion must not buy another seven days.
// A substantive reply either supplies an ETA or responds to findings/fixes in a
// structured way; a new commit/head is tracked independently above.
export function isSubstantiveAuthorReply(body: string): boolean {
  return (
    /\bETA\b|\bby (?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/iu.test(body) ||
    /\b(?:P[0-3]|finding|requested change)\b[\s\S]{0,80}\b(?:fixed|addressed|resolved|plan|will)\b/iu.test(body) ||
    /(?:^|\n)\s*[-*]\s+\[[ xX]\]\s+\S/u.test(body)
  );
}

export class GithubDiscovery {
  public constructor(
    private readonly config: CraConfig,
    private readonly token: string,
    private readonly executor: CommandExecutor = execute,
  ) {}

  public async listOpenPullRequests(): Promise<DiscoveredPullRequest[]> {
    const [owner, name] = this.config.repository.split("/") as [string, string];
    const discovered: DiscoveredPullRequest[] = [];
    let cursor: string | null = null;
    do {
      const args = ["api", "graphql", "-f", `query=${DISCOVERY_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
      if (cursor !== null) args.push("-F", `cursor=${cursor}`);
      const result = await executeChecked(this.executor, {
        command: this.config.commands.gh,
        args,
        env: githubTokenEnvironment(this.token),
        timeoutMs: 60_000,
      });
      const raw: unknown = JSON.parse(result.stdout);
      const response = responseSchema.parse(raw);
      if (response.errors !== undefined && response.errors.length > 0)
        throw new Error("GitHub GraphQL returned errors");
      const connection = response.data.repository.pullRequests;
      discovered.push(...connection.nodes.map(normalize));
      cursor = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      if (connection.pageInfo.hasNextPage && cursor === null)
        throw new Error("GitHub pagination omitted an end cursor");
    } while (cursor !== null);
    return discovered;
  }
}

export function selectReviewCandidates(
  pullRequests: readonly DiscoveredPullRequest[],
  states: ReadonlyMap<number, PrState>,
  rubricVersion: string,
): DiscoveredPullRequest[] {
  return pullRequests.filter((pr) => {
    if (pr.isDraft) return false;
    const state = states.get(pr.number);
    return (
      state === undefined ||
      state.lastReviewedHeadSha !== pr.headSha ||
      state.rubricVersion !== rubricVersion ||
      state.auditStatus === "in_progress" ||
      state.auditStatus === "failed"
    );
  });
}
