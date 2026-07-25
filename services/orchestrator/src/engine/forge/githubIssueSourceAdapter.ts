import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { ActiveGitHubIssuesConfig, type InboxSource } from "./inbox/index.js";
import { resolveGithubToken } from "../credentials/githubTokenResolver.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import { decodeGithubIssueEvent, githubWebhookExternalId, type GithubIssueEvent } from "./intake/webhookMapping.js";
import {
  ingestIssueObservation,
  type IssueObservation,
  type IssueSourceAdapter,
  type IssueSourceIngestResult,
  type SourceSyncReadback,
  type SourceSyncReceipt,
  type SourceSyncRequest,
} from "./issueSourceAdapter.js";

const SyncIssue = z
  .object({ number: z.number().int().positive(), state: z.enum(["open", "closed"]), updated_at: z.string().optional() })
  .passthrough();
const SyncComment = z
  .object({ id: z.number().int().positive(), body: z.string(), updated_at: z.string().optional() })
  .passthrough();

export interface GitHubIssueSourceAdapterDeps {
  pool: pg.Pool;
  secrets: Parameters<typeof resolveGithubToken>[0]["secrets"];
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  defaultStaticRef?: string;
}

function labels(issue: GithubIssueEvent["issue"]): string[] {
  return (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
}

function severity(labelNames: ReadonlyArray<string>): IssueObservation["severity"] {
  const values = labelNames.map((label) => label.toLowerCase());
  if (values.some((label) => label.includes("bug") || label.includes("regression") || label.includes("critical"))) {
    return "fail";
  }
  return values.some((label) => label.includes("warn") || label.includes("perf")) ? "warn" : "info";
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

function revision(payload: unknown, updatedAt: string | null | undefined): string {
  const value = updatedAt === undefined || updatedAt === null ? canonical(payload) : updatedAt;
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function repositoryPath(owner: string, repo: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}${suffix}`;
}

function issueNumber(externalKey: string): number {
  const match = /^gh-[^/]+\/[^#]+#(\d+)$/u.exec(externalKey);
  if (match === null) throw new Error(`invalid GitHub issue key: ${externalKey}`);
  return Number(match[1]);
}

function actionStatus(action: string): IssueObservation["status"] | undefined {
  if (action === "closed") return "closed";
  if (action === "deleted") return "deleted";
  if (action === "reopened") return "reopened";
  if (["opened", "labeled"].includes(action)) return "open";
  if (action === "edited") return "edited";
  return undefined;
}

function normalizeWebhook(
  payload: unknown,
  source: InboxSource,
  deliveryId: string | null,
): IssueObservation | undefined {
  const parsed = decodeGithubIssueEvent(payload);
  if (parsed.data.issue.pull_request !== undefined) return undefined;
  const status = actionStatus(parsed.data.action);
  if (status === undefined) return undefined;
  if (source.kind !== "issues" || source.config === null) return undefined;
  const externalKey = githubWebhookExternalId(parsed.data, source);
  return {
    orgId: source.orgId,
    sourceId: source.id,
    ...(source.projectId === null ? {} : { projectId: source.projectId }),
    externalKey,
    providerObjectId: externalKey,
    providerRevision: revision(payload, parsed.data.issue.updated_at),
    status,
    severity: severity(labels(parsed.data.issue)),
    title: parsed.data.issue.title.slice(0, 300),
    body: (parsed.data.issue.body ?? "").slice(0, 8000),
    deliveryId,
    context: { provider: "github", action: parsed.data.action },
  };
}

/**
 * Record the issue-loop observation from bh-3's already-persisted webhook
 * delivery. This deliberately does not persist, claim, or sweep a webhook row:
 * `webhookProcessor` is the one idempotent production intake path for those
 * responsibilities, and invokes this only after it has claimed the delivery.
 */
export async function ingestGithubWebhookObservation(
  pool: pg.Pool,
  source: InboxSource,
  event: { payload: unknown; deliveryId: string | null },
): Promise<IssueSourceIngestResult | undefined> {
  const observation = normalizeWebhook(event.payload, source, event.deliveryId);
  return observation === undefined ? undefined : ingestIssueObservation(pool, observation);
}

export class GithubIssueSourceAdapter implements IssueSourceAdapter {
  readonly provider = "github";

  constructor(private readonly deps: GitHubIssueSourceAdapterDeps) {}

  ingest(pool: pg.Pool, observation: IssueObservation): Promise<IssueSourceIngestResult> {
    return ingestIssueObservation(pool, observation);
  }

  async sync(input: SourceSyncRequest): Promise<SourceSyncReceipt> {
    const { path, resolved } = await this.syncContext(input);
    if (input.outbox.operation === "comment") {
      const body = commentBody(input);
      const response = await this.deps.githubHttp.request({
        method: "POST",
        path: `${path}/comments`,
        token: resolved.token,
        refreshToken: resolved.refresh,
        retryTransient: false,
        body: { body },
      });
      if (response.status < 200 || response.status >= 300)
        throw new Error(`GitHub issue comment failed: HTTP ${response.status}`);
      const comment = SyncComment.parse(response.body);
      return { providerRevision: revision(comment, comment.updated_at) };
    }
    const state = input.outbox.operation === "close" ? "closed" : "open";
    const response = await this.deps.githubHttp.request({
      method: "PATCH",
      path,
      token: resolved.token,
      refreshToken: resolved.refresh,
      body: { state },
    });
    if (response.status < 200 || response.status >= 300)
      throw new Error(`GitHub issue ${input.outbox.operation} failed: HTTP ${response.status}`);
    const issue = SyncIssue.parse(response.body);
    return { providerRevision: revision(issue, issue.updated_at) };
  }

  async readback(input: SourceSyncRequest): Promise<SourceSyncReadback> {
    const { path, resolved } = await this.syncContext(input);
    if (input.outbox.operation === "comment") {
      const response = await this.deps.githubHttp.request({
        method: "GET",
        path: `${path}/comments`,
        token: resolved.token,
        refreshToken: resolved.refresh,
      });
      if (response.status !== 200) throw new Error(`GitHub issue comment readback failed: HTTP ${response.status}`);
      const matching = z
        .array(SyncComment)
        .parse(response.body)
        .find((comment) => comment.body === commentBody(input));
      if (matching === undefined) return { providerRevision: revision(response.body, null), desiredState: "open" };
      return { providerRevision: revision(matching, matching.updated_at), desiredState: "comment_recorded" };
    }
    const response = await this.deps.githubHttp.request({
      method: "GET",
      path,
      token: resolved.token,
      refreshToken: resolved.refresh,
    });
    if (response.status !== 200)
      throw new Error(`GitHub issue ${input.outbox.operation} readback failed: HTTP ${response.status}`);
    const issue = SyncIssue.parse(response.body);
    return { providerRevision: revision(issue, issue.updated_at), desiredState: issue.state };
  }

  private async syncContext(input: SourceSyncRequest): Promise<{
    path: string;
    resolved: Awaited<ReturnType<typeof resolveGithubToken>>;
  }> {
    if (input.source.kind !== "issues" || input.source.config === null)
      throw new Error("GitHub source config is unavailable");
    const config = ActiveGitHubIssuesConfig.parse(input.source.config);
    const resolved = await resolveGithubToken({
      secrets: this.deps.secrets,
      orgId: input.source.orgId,
      ...(this.deps.githubAppMinter === undefined ? {} : { minter: this.deps.githubAppMinter }),
      ...(this.deps.defaultStaticRef === undefined ? {} : { staticRef: this.deps.defaultStaticRef }),
    });
    return {
      path: repositoryPath(config.owner, config.repo, `/issues/${issueNumber(input.loop.externalKey)}`),
      resolved,
    };
  }
}

function commentBody(input: SourceSyncRequest): string {
  const body = input.outbox.payload["body"];
  if (typeof body !== "string" || body.length === 0)
    throw new Error("GitHub comment sync requires a non-empty body payload");
  return body;
}
