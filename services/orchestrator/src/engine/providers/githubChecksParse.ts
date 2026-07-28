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

export function parseRequiredContexts(value: unknown): string[] {
  return parseRequiredCheckPayload(value).contexts;
}

/** Parse the exact required context → GitHub App identity bindings. */
export function parseRequiredCheckAppIds(value: unknown): Record<string, number> {
  return parseRequiredCheckPayload(value).appIds;
}

function parseRequiredCheckPayload(value: unknown): { contexts: string[]; appIds: Record<string, number> } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("GitHub required-status-checks response was not an object");
  }
  const object = value as Record<string, unknown>;
  const checks = object["checks"];
  const contexts = object["contexts"];
  if (checks !== undefined && !Array.isArray(checks)) {
    throw new TypeError("GitHub required-status-checks response had a non-array checks field");
  }
  if (contexts !== undefined && !Array.isArray(contexts)) {
    throw new TypeError("GitHub required-status-checks response had a non-array contexts field");
  }
  if (checks === undefined && contexts === undefined) {
    throw new TypeError("GitHub required-status-checks response missing checks or contexts");
  }

  const appIds: Record<string, number> = {};
  const appBindings = new Map<string, number | null | undefined>();
  const checkNames = Array.isArray(checks)
    ? checks.map((entry) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
          throw new TypeError("GitHub required check was not an object");
        }
        const row = entry as Record<string, unknown>;
        const context = row["context"];
        if (typeof context !== "string" || context.trim() === "") {
          throw new TypeError("GitHub required check missing context");
        }
        const appId = row["app_id"];
        if (
          appId !== undefined &&
          appId !== null &&
          (typeof appId !== "number" || !Number.isSafeInteger(appId) || appId < 0)
        ) {
          throw new TypeError(`GitHub required check ${context} had an invalid app_id`);
        }
        if (appBindings.has(context) && appBindings.get(context) !== appId) {
          throw new Error(`GitHub required check ${context} had conflicting app_id bindings`);
        }
        appBindings.set(context, appId);
        if (typeof appId === "number") appIds[context] = appId;
        return { context, appId };
      })
    : undefined;
  if (checkNames !== undefined) {
    const names = checkNames.map((check) => check.context);
    if (new Set(names).size !== names.length) {
      throw new Error("GitHub required checks contained duplicate contexts");
    }
  }

  const contextNames = Array.isArray(contexts)
    ? contexts.map((context) => {
        if (typeof context !== "string" || context.trim() === "") {
          throw new TypeError("GitHub required contexts contained an invalid context");
        }
        return context;
      })
    : undefined;
  if (contextNames !== undefined && new Set(contextNames).size !== contextNames.length) {
    throw new Error("GitHub required contexts contained duplicate contexts");
  }

  const namesFromChecks = checkNames?.map((check) => check.context);
  if (namesFromChecks !== undefined && contextNames !== undefined && !sameContexts(namesFromChecks, contextNames)) {
    throw new Error("GitHub required checks and contexts disagreed");
  }
  return { contexts: namesFromChecks ?? contextNames ?? [], appIds };
}

function sameContexts(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((context, index) => context === sortedRight[index]);
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
