// P1d autonomous intake — webhook payload → `IngestedItem` mapping
// (autonomy-engine.md §1d). A push event arrives on a receiver route; this maps
// the provider's payload into the SAME `IngestedItem` the pull connectors emit,
// so the downstream triage → auto-route/inbox path is identical for push + pull.
//
// GitHub issues are wired; Sentry + Linear carry the SHAPE (the receiver dispatch
// + the mapper signature) so adding their real receivers is a payload mapper, not
// a new pipeline.

import { z } from "zod";
import type { IngestedItem } from "../inbox/types.js";

/** A mapped event: the action GitHub reports + the raw item to ingest, or a skip. */
export type WebhookMapResult = { kind: "ingest"; item: IngestedItem } | { kind: "skip"; reason: string };

// The GitHub `issues` event payload fields we read. `action` distinguishes
// opened/edited/reopened (we ingest) from closed/deleted (we skip).
const GithubIssueEvent = z
  .object({
    action: z.string(),
    issue: z
      .object({
        number: z.number(),
        title: z.string(),
        body: z.string().nullable().optional(),
        labels: z.array(z.union([z.string(), z.object({ name: z.string().optional() }).passthrough()])).optional(),
        pull_request: z.unknown().optional(),
      })
      .passthrough(),
    repository: z
      .object({
        owner: z.object({ login: z.string() }).passthrough(),
        name: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

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
  const parsed = GithubIssueEvent.safeParse(payload);
  if (!parsed.success) return { kind: "skip", reason: "payload is not a github issues event" };
  const event = parsed.data;
  if (event.issue.pull_request !== undefined) return { kind: "skip", reason: "pull request, not an issue" };
  if (!INGEST_ACTIONS.has(event.action)) return { kind: "skip", reason: `action not ingestable: ${event.action}` };

  const labels = (event.issue.labels ?? [])
    .map((l) => (typeof l === "string" ? l : (l.name ?? "")))
    .filter((l): l is string => l.length > 0);
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  return {
    kind: "ingest",
    item: {
      externalId: `gh-${owner}/${repo}#${event.issue.number}`,
      title: event.issue.title,
      body: (event.issue.body ?? "").slice(0, 8000),
      severity: severityFromLabels(labels),
      projectId,
    },
  };
}
