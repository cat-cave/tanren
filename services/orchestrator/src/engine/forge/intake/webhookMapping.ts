// P1d autonomous intake — webhook payload → `IngestedItem` mapping
// (autonomy-engine.md §1d). A push event arrives on a receiver route; this maps
// the provider's payload into the SAME `IngestedItem` the pull connectors emit,
// so the downstream triage → auto-route/inbox path is identical for push + pull.
//
// GitHub issues are wired. Additional providers must supply both a payload mapper
// and exact integration authority; a mapper is never credential authority.

import { z } from "zod";
import type { IngestedItem } from "../inbox/types.js";

/** A mapped event: the action GitHub reports + the raw item to ingest, or a skip. */
export type WebhookMapResult = { kind: "ingest"; item: IngestedItem } | { kind: "skip"; reason: string };

// §3.6 issue-loop hardening: the candidate `title` column caps at 300 chars
// (inbox/types.ts `Candidate.title.max(300)`). A GitHub issue title can be longer;
// left untruncated it WRITES into the candidate row fine but then CRASHES the
// `Candidate` zod decode on read-back — AFTER the row landed, so the candidate is
// stranded undecodable. Truncate at the source (the mapper) so the persisted title
// always satisfies the schema. Kept just under the cap with an ellipsis marker.
const TITLE_MAX = 300;
function truncateTitle(title: string): string {
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1)}…`;
}

// The GitHub `issues` event payload fields we read. `action` distinguishes
// opened/edited/reopened (we ingest) from closed/deleted (we skip).
const GithubIssueEventSchema = z
  .object({
    action: z.string().min(1),
    issue: z
      .object({
        number: z.number().int().positive(),
        title: z.string().min(1),
        body: z.string().nullable().optional(),
        updated_at: z.string().nullable().optional(),
        labels: z.array(z.union([z.string().min(1), z.object({ name: z.string().min(1) }).passthrough()])).optional(),
        pull_request: z.object({}).passthrough().optional(),
      })
      .passthrough(),
    repository: z
      .object({
        owner: z.object({ login: z.string().min(1) }).passthrough(),
        name: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();
export type GithubIssueEvent = z.infer<typeof GithubIssueEventSchema>;
export const decodeGithubIssueEvent = (payload: unknown) => ({ data: GithubIssueEventSchema.parse(payload) });

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
export function mapGithubIssueWebhook(payload: unknown, projectId: string | null): WebhookMapResult {
  const event = decodeGithubIssueEvent(payload).data;
  if (event.issue.pull_request !== undefined) return { kind: "skip", reason: "pull request, not an issue" };
  if (!INGEST_ACTIONS.has(event.action)) return { kind: "skip", reason: `action not ingestable: ${event.action}` };

  const labels = (event.issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  return {
    kind: "ingest",
    item: {
      externalId: `gh-${owner}/${repo}#${event.issue.number}`,
      title: truncateTitle(event.issue.title),
      body: (event.issue.body ?? "").slice(0, 8000),
      severity: severityFromLabels(labels),
      projectId,
    },
  };
}
