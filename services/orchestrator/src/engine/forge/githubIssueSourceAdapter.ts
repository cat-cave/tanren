import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import { ActiveGitHubIssuesConfig, type InboxSource } from "./inbox/index.js";
import { resolveGithubToken } from "../credentials/githubTokenResolver.js";
import type { GitHubHttpClient } from "../providers/github.js";
import type { GithubAppTokenMinter } from "../providers/githubAppTokenMinter.js";
import {
  ingestIssueObservation,
  type IssueObservation,
  type IssueSourceAdapter,
  type IssueSourceIngestResult,
  type SourceSyncReceipt,
  type SourceSyncRequest,
} from "./issueSourceAdapter.js";

const GithubIssue = z
  .object({
    action: z.string(),
    issue: z
      .object({
        number: z.number().int().positive(),
        title: z.string().min(1),
        body: z.string().nullable().optional(),
        updated_at: z.string().nullable().optional(),
        labels: z.array(z.union([z.string(), z.object({ name: z.string().optional() }).passthrough()])).optional(),
        pull_request: z.unknown().optional(),
      })
      .passthrough(),
    repository: z.object({ owner: z.object({ login: z.string() }).passthrough(), name: z.string() }).passthrough(),
  })
  .passthrough();

const SyncIssue = z
  .object({ number: z.number().int().positive(), state: z.enum(["open", "closed"]), updated_at: z.string().optional() })
  .passthrough();

export interface GitHubIssueSourceAdapterDeps {
  pool: pg.Pool;
  secrets: Parameters<typeof resolveGithubToken>[0]["secrets"];
  githubHttp: GitHubHttpClient;
  githubAppMinter?: GithubAppTokenMinter;
  defaultStaticRef?: string;
}

function labels(issue: z.infer<typeof GithubIssue>["issue"]): string[] {
  return (issue.labels ?? [])
    .map((label) => (typeof label === "string" ? label : (label.name ?? "")))
    .filter((label) => label.length > 0);
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
  const parsed = GithubIssue.safeParse(payload);
  if (!parsed.success || parsed.data.issue.pull_request !== undefined) return undefined;
  const status = actionStatus(parsed.data.action);
  if (status === undefined) return undefined;
  if (source.kind !== "issues" || source.config === null) return undefined;
  const sourceConfig = ActiveGitHubIssuesConfig.parse(source.config);
  const owner = parsed.data.repository.owner.login;
  const repo = parsed.data.repository.name;
  if (
    owner.toLowerCase() !== sourceConfig.owner.toLowerCase() ||
    repo.toLowerCase() !== sourceConfig.repo.toLowerCase()
  ) {
    throw new Error("GitHub webhook repository does not match its configured source");
  }
  const externalKey = `gh-${owner}/${repo}#${parsed.data.issue.number}`;
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
    if (input.outbox.operation !== "close")
      throw new Error(`unsupported GitHub source sync operation: ${input.outbox.operation}`);
    if (input.source.kind !== "issues" || input.source.config === null)
      throw new Error("GitHub source config is unavailable");
    const config = ActiveGitHubIssuesConfig.parse(input.source.config);
    const resolved = await resolveGithubToken({
      secrets: this.deps.secrets,
      orgId: input.source.orgId,
      ...(this.deps.githubAppMinter === undefined ? {} : { minter: this.deps.githubAppMinter }),
      ...(this.deps.defaultStaticRef === undefined ? {} : { staticRef: this.deps.defaultStaticRef }),
    });
    const path = repositoryPath(config.owner, config.repo, `/issues/${issueNumber(input.loop.externalKey)}`);
    const patch = await this.deps.githubHttp.request({
      method: "PATCH",
      path,
      token: resolved.token,
      refreshToken: resolved.refresh,
      body: { state: "closed" },
    });
    if (patch.status < 200 || patch.status >= 300) throw new Error(`GitHub issue close failed: HTTP ${patch.status}`);
    const readback = await this.deps.githubHttp.request({
      method: "GET",
      path,
      token: resolved.token,
      refreshToken: resolved.refresh,
    });
    if (readback.status !== 200) throw new Error(`GitHub issue close readback failed: HTTP ${readback.status}`);
    const issue = SyncIssue.parse(readback.body);
    if (issue.state !== "closed") throw new Error("GitHub issue close readback did not verify closed state");
    return { providerRevision: revision(issue, issue.updated_at) };
  }
}
