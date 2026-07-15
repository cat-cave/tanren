import type { ProjectContext } from "../contracts/integrationProvisioner.js";

/**
 * The hard cap on a deploy-app name (the lowest common denominator across
 * Vercel and Fly). Fly validates names at no more than 30 characters.
 */
export const DEPLOY_APP_NAME_MAX_LEN = 30;

const DEPLOY_APP_NAME_HASH_LEN = 6;

function sanitizeNameSegment(raw: string): string {
  return raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
}

/** Six-character deterministic collision-disambiguator for truncated names. */
function shortHash(input: string): string {
  let hash = 0x811c_9dc5;
  for (const codePoint of input) {
    hash = Math.imul(hash ^ (codePoint.codePointAt(0) ?? 0), 0x0100_0193);
  }
  const unsigned = Math.trunc(hash) + 2 ** 32 * Number(Math.trunc(hash) < 0);
  return unsigned.toString(36).padStart(DEPLOY_APP_NAME_HASH_LEN, "0").slice(0, DEPLOY_APP_NAME_HASH_LEN);
}

/**
 * Produce the provider app name for a project. The mandatory org-slug prefix
 * namespaces Fly's global app-name space and is also applied to Vercel so both
 * arms obey one rule. Long project segments are truncated with a deterministic
 * suffix; the load-bearing org prefix is never dropped.
 */
export function deployAppName(projectCtx: ProjectContext): string {
  const orgSlug = sanitizeNameSegment(projectCtx.orgSlug);
  if (orgSlug === "") {
    throw new Error(
      "deployAppName: ProjectContext.orgSlug is required + must contain hostname-safe " +
        "characters — the deploy-app namespacing rule (task #27) cannot apply without it. " +
        "The provisioning engine resolves the org slug via OrganizationsStore.getLogin before " +
        "constructing the context; this throw means a caller is bypassing that wiring.",
    );
  }

  const baseProjectName = projectCtx.name ?? projectCtx.projectId;
  const projectSlug = sanitizeNameSegment(baseProjectName);
  const safeProjectSlug = projectSlug === "" ? sanitizeNameSegment(`tanren-${projectCtx.projectId}`) : projectSlug;
  const naive = `${orgSlug}-${safeProjectSlug}`;
  if (naive.length <= DEPLOY_APP_NAME_MAX_LEN) {
    return naive;
  }

  const projectBudget = DEPLOY_APP_NAME_MAX_LEN - (orgSlug.length + 1) - (1 + DEPLOY_APP_NAME_HASH_LEN);
  if (projectBudget < 1) {
    throw new Error(
      `deployAppName: org slug '${orgSlug}' is too long (${String(orgSlug.length)} chars) — the namespaced app ` +
        `name '<orgSlug>-<projectName>-<6charHash>' must fit in ${String(DEPLOY_APP_NAME_MAX_LEN)} chars total ` +
        `(Fly's app-name cap). Rename the org to a shorter login.`,
    );
  }

  const truncated = safeProjectSlug.slice(0, projectBudget).replaceAll(/-+$/gu, "");
  const projectPart = truncated === "" ? "x" : truncated;
  return `${orgSlug}-${projectPart}-${shortHash(naive)}`;
}
