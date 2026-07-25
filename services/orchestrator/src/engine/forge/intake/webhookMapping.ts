// P1d autonomous intake — webhook payload → `IngestedItem` mapping
// (autonomy-engine.md §1d). A push event arrives on a receiver route; this maps
// the provider's payload into the SAME `IngestedItem` the pull connectors emit,
// so the downstream triage → auto-route/inbox path is identical for push + pull.
//
// GitHub issues are wired. Additional providers must supply both a payload mapper
// and exact integration authority; a mapper is never credential authority.

import { z } from "zod";
import { ActiveGitHubIssuesConfig, GithubIssueTitle, type IngestedItem, type InboxSource } from "../inbox/types.js";

/** A mapped event: the action GitHub reports + the raw item to ingest, or a skip. */
export type WebhookMapResult = { kind: "ingest"; item: IngestedItem } | { kind: "skip"; reason: string };

// The GitHub `issues` event payload fields we read. `action` distinguishes
// opened/edited/reopened (we ingest) from closed/deleted (we skip).
const Nonempty = z.string().trim().min(1);
const GithubIssueEventSchema = z
  .object({
    action: Nonempty,
    issue: z
      .object({
        number: z.number().int().positive(),
        title: GithubIssueTitle,
        body: z.string().nullable().optional(),
        updated_at: z.string().nullable().optional(),
        labels: z.array(z.union([Nonempty, z.object({ name: Nonempty }).passthrough()])).optional(),
        pull_request: z.object({}).passthrough().optional(),
      })
      .passthrough(),
    repository: z
      .object({
        owner: z.object({ login: Nonempty }).passthrough(),
        name: Nonempty,
      })
      .passthrough(),
  })
  .passthrough();
export type GithubIssueEvent = z.infer<typeof GithubIssueEventSchema>;
type GithubWebhookSource = Pick<InboxSource, "kind" | "config" | "projectId">;
export const decodeGithubIssueEvent = (payload: unknown) => ({ data: GithubIssueEventSchema.parse(payload) });
export class GithubWebhookScopeMismatchError extends Error {}
export function githubWebhookExternalId(event: GithubIssueEvent, source: GithubWebhookSource): string {
  if (source.kind !== "issues" || source.config === null)
    throw new GithubWebhookScopeMismatchError("GitHub webhook source has no repository scope");
  const config = ActiveGitHubIssuesConfig.parse(source.config);
  if (
    event.repository.owner.login.toLowerCase() !== config.owner ||
    event.repository.name.toLowerCase() !== config.repo
  )
    throw new GithubWebhookScopeMismatchError("GitHub webhook repository does not match its configured source");
  return `gh-${config.owner}/${config.repo}#${event.issue.number}`;
}

// Actions that represent a live, ingest-worthy issue. A closed/deleted issue is
// a no-op (it never becomes new work); the upsert keeps any prior candidate.
const INGEST_ACTIONS = new Set(["opened", "edited", "reopened", "labeled"]);

function severityFromLabels(labels: ReadonlyArray<string>): IngestedItem["severity"] {
  const lowered = labels.map((l) => l.toLowerCase());
  if (lowered.some((l) => l.includes("bug") || l.includes("regression") || l.includes("critical"))) return "fail";
  if (lowered.some((l) => l.includes("warn") || l.includes("perf"))) return "warn";
  return "info";
}

/**
 * Map a GitHub `issues` webhook payload to an `IngestedItem`. PRs (which also
 * arrive on the issues surface) and non-ingest actions are skipped. The
 * `externalId` matches the pull connector's (`gh-owner/repo#number`) so a push
 * and a later poll of the same issue UPSERT the same candidate — push + poll are
 * idempotent against each other.
 */
export function mapGithubIssueWebhook(payload: unknown, source: GithubWebhookSource): WebhookMapResult {
  const event = decodeGithubIssueEvent(payload).data;
  const externalId = githubWebhookExternalId(event, source);
  if (event.issue.pull_request !== undefined) return { kind: "skip", reason: "pull request, not an issue" };
  if (!INGEST_ACTIONS.has(event.action)) return { kind: "skip", reason: `action not ingestable: ${event.action}` };

  const labels = (event.issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  return {
    kind: "ingest",
    item: {
      externalId,
      title: event.issue.title,
      body: (event.issue.body ?? "").slice(0, 8000),
      severity: severityFromLabels(labels),
      projectId: source.projectId,
    },
  };
}
