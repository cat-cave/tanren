/**
 * gv-4: client for the stacked-PR retarget safety projection.
 * `GET /orgs/:orgId/projects/:projectId/runs/:runId/stack-retarget`
 */

export interface StackRetargetMember {
  specId: string;
  runId: string;
  branch: string;
  headSha: string;
  merged: boolean;
}

export interface StackRetargetView {
  missionNodeId: "gv-4";
  runId: string;
  projectId: string;
  orgId: string;
  speculative: boolean;
  defaultBranch: string;
  members: StackRetargetMember[];
  mergedSpecIds: string[];
  unmergedAncestors: string[];
  toBase: string;
  remainingStack: Array<{
    specId: string;
    runId: string;
    branch: string;
    headSha: string;
  }>;
}

export type FetchStackRetargetResult =
  | { kind: "ok"; view: StackRetargetView }
  | { kind: "not_found" }
  | { kind: "auth"; status: 401 | 403 }
  | { kind: "unavailable"; reason: "network" | "malformed" | "upstream" };

export interface StackRetargetFetchDeps {
  orchestratorUrl: string;
  headers: Record<string, string>;
  fetchImpl: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeMember(raw: unknown): StackRetargetMember | undefined {
  if (!isRecord(raw)) return undefined;
  const specId = asNonEmptyString(raw["specId"]);
  const runId = typeof raw["runId"] === "string" ? raw["runId"] : undefined;
  const branch = typeof raw["branch"] === "string" ? raw["branch"] : undefined;
  const headSha = typeof raw["headSha"] === "string" ? raw["headSha"] : undefined;
  const merged = typeof raw["merged"] === "boolean" ? raw["merged"] : undefined;
  if (
    specId === undefined ||
    runId === undefined ||
    branch === undefined ||
    headSha === undefined ||
    merged === undefined
  ) {
    return undefined;
  }
  return { specId, runId, branch, headSha, merged };
}

/** Strict decode — rejects wrong mission node, missing fields, or extra silence as unavailable. */
export function decodeStackRetargetView(body: unknown): StackRetargetView | undefined {
  if (!isRecord(body)) return undefined;
  if (body["missionNodeId"] !== "gv-4") return undefined;
  const runId = asNonEmptyString(body["runId"]);
  const projectId = asNonEmptyString(body["projectId"]);
  const orgId = asNonEmptyString(body["orgId"]);
  const defaultBranch = asNonEmptyString(body["defaultBranch"]);
  const toBase = asNonEmptyString(body["toBase"]);
  if (runId === undefined || projectId === undefined || orgId === undefined) return undefined;
  if (defaultBranch === undefined || toBase === undefined) return undefined;
  if (typeof body["speculative"] !== "boolean") return undefined;
  const membersRaw = body["members"];
  const mergedSpecIdsRaw = body["mergedSpecIds"];
  const unmergedAncestorsRaw = body["unmergedAncestors"];
  const remainingStackRaw = body["remainingStack"];
  if (!Array.isArray(membersRaw) || !Array.isArray(mergedSpecIdsRaw) || !Array.isArray(unmergedAncestorsRaw)) {
    return undefined;
  }
  if (!Array.isArray(remainingStackRaw)) return undefined;
  const members: StackRetargetMember[] = [];
  for (const m of membersRaw) {
    const decoded = decodeMember(m);
    if (decoded === undefined) return undefined;
    members.push(decoded);
  }
  if (!mergedSpecIdsRaw.every((id) => typeof id === "string" && id.length > 0)) return undefined;
  if (!unmergedAncestorsRaw.every((id) => typeof id === "string" && id.length > 0)) return undefined;
  return {
    missionNodeId: "gv-4",
    runId,
    projectId,
    orgId,
    speculative: body["speculative"],
    defaultBranch,
    members,
    mergedSpecIds: mergedSpecIdsRaw as string[],
    unmergedAncestors: unmergedAncestorsRaw as string[],
    toBase,
    remainingStack: remainingStackRaw as StackRetargetView["remainingStack"],
  };
}

export async function fetchStackRetarget(
  deps: StackRetargetFetchDeps,
  args: { orgId: string; projectId: string; runId: string },
): Promise<FetchStackRetargetResult> {
  const url =
    `${deps.orchestratorUrl}/orgs/${encodeURIComponent(args.orgId)}` +
    `/projects/${encodeURIComponent(args.projectId)}` +
    `/runs/${encodeURIComponent(args.runId)}/stack-retarget`;
  let res: Response;
  try {
    res = await deps.fetchImpl(url, { headers: deps.headers });
  } catch {
    return { kind: "unavailable", reason: "network" };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: "auth", status: res.status };
  }
  if (res.status === 404) {
    return { kind: "not_found" };
  }
  if (!res.ok) {
    return { kind: "unavailable", reason: "upstream" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "unavailable", reason: "malformed" };
  }
  const view = decodeStackRetargetView(body);
  if (view === undefined) {
    return { kind: "unavailable", reason: "malformed" };
  }
  return { kind: "ok", view };
}
