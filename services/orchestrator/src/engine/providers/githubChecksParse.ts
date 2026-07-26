// GitHub check-run / commit-status / ref-SHA / required-context response parsers,
// split out of `github.ts` to keep that file under the 500-line cap. These are pure
// shape-validators over the forge JSON the CI-status reads (`fetchPullRequestChecks` /
// `fetchBranchChecks` / `fetchRequiredContexts`) consume — no behavior, just parsing.

import type { GitHubCheckRun, GitHubCommitStatus } from "./github.js";

/** Parse a `GET /git/ref/heads/{branch}` response body's `object.sha`, or undefined. */
export function parseRefObjectSha(value: unknown): string | undefined {
  const object = (value as { object?: { sha?: unknown } } | undefined)?.object;
  return object !== undefined && typeof object.sha === "string" && object.sha !== "" ? object.sha : undefined;
}

export function parseRequiredContexts(value: unknown): string[] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const object = value as Record<string, unknown>;
  // GitHub returns required contexts in two shapes: a `checks` array carrying
  // per-check `context`, or a flat `contexts` string list. Read the structured
  // `checks` shape first, then the flat `contexts` list.
  const checks = object["checks"];
  if (Array.isArray(checks)) {
    const names = checks
      .map((entry) =>
        typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)["context"] : undefined,
      )
      .filter((name): name is string => typeof name === "string");
    if (names.length > 0) {
      return names;
    }
  }
  const contexts = object["contexts"];
  if (Array.isArray(contexts)) {
    return contexts.filter((name): name is string => typeof name === "string");
  }
  return [];
}

/** Parse the exact required context → GitHub App identity bindings. */
export function parseRequiredCheckAppIds(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const checks = (value as Record<string, unknown>)["checks"];
  if (!Array.isArray(checks)) return {};
  const result: Record<string, number> = {};
  for (const entry of checks) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    const context = row["context"];
    const appId = row["app_id"];
    if (typeof context === "string" && context !== "" && typeof appId === "number" && Number.isInteger(appId)) {
      result[context] = appId;
    }
  }
  return result;
}

export function parseCheckRuns(value: unknown): GitHubCheckRun[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub check-runs response was not an object");
  }
  const checkRuns = (value as Record<string, unknown>)["check_runs"];
  if (!Array.isArray(checkRuns)) {
    throw new TypeError("GitHub check-runs response missing check_runs");
  }
  return checkRuns.map((checkRun) => parseCheckRun(checkRun));
}

function parseCheckRun(value: unknown): GitHubCheckRun {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub check run was not an object");
  }
  const object = value as Record<string, unknown>;
  if (typeof object["name"] !== "string" || typeof object["status"] !== "string") {
    throw new TypeError("GitHub check run missing name or status");
  }
  return {
    name: object["name"],
    status: object["status"],
    conclusion: typeof object["conclusion"] === "string" ? object["conclusion"] : undefined,
    appId:
      typeof object["app"] === "object" &&
      object["app"] !== null &&
      typeof (object["app"] as Record<string, unknown>)["id"] === "number"
        ? ((object["app"] as Record<string, unknown>)["id"] as number)
        : undefined,
    url: typeof object["html_url"] === "string" ? object["html_url"] : undefined,
  };
}

export function parseCommitStatuses(value: unknown): GitHubCommitStatus[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub commit status response was not an object");
  }
  const statuses = (value as Record<string, unknown>)["statuses"];
  if (!Array.isArray(statuses)) {
    throw new TypeError("GitHub commit status response missing statuses");
  }
  return statuses.map((status) => parseCommitStatus(status));
}

function parseCommitStatus(value: unknown): GitHubCommitStatus {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub commit status was not an object");
  }
  const object = value as Record<string, unknown>;
  if (typeof object["context"] !== "string" || typeof object["state"] !== "string") {
    throw new TypeError("GitHub commit status missing context or state");
  }
  return {
    context: object["context"],
    state: object["state"],
    url: typeof object["target_url"] === "string" ? object["target_url"] : undefined,
  };
}
