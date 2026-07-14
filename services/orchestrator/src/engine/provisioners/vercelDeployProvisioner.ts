// VercelDeployProvisioner — `IntegrationProvisioner` for provider kind
// `deploy.vercel`. Creates/finds a Vercel PROJECT under the org's team grant so
// the built product can be deployed, and captures the preview-URL pattern + a
// deployment ref. All HTTP goes through the injectable `DeployHttpTransport`, so
// the full lifecycle is unit-tested against a scripted fake with NO live Vercel
// calls or credentials in CI.
//
// NAMESPACING (task #27): every project this provisioner creates is named
// `<tanrenOrgSlug>-<projectName>` (see `deployAppName` in `deployProvisioner.ts`).
// Vercel project names are scoped to a team, but we still namespace here so the
// same single rule applies to BOTH supported deploy backends — and the rule is
// load-bearing on Fly (its global namespace). A duplicate-name reject (409/422)
// AFTER prefixing FAILS LOUD here — there is no automatic suffix-retry. The
// Tanren org slug is required on `ProjectContext.orgSlug` (resolved by
// `provisioningEngine` via `OrganizationsStore.getLogin` before this provisioner
// is called).
//
// API surface used (Vercel REST):
//   - GET  /v9/projects[?teamId=…]    → list the team's projects (discover)
//   - POST /v9/projects[?teamId=…]    → create a project under the team (provision)
//   - POST /v13/deployments[?teamId=…] → TRIGGER a build + release of a git ref
// Team scoping: the org grant's metadata may carry `teamId` (Vercel team) and/or
// `slug`; when present they are threaded as the `teamId` query param + used to
// shape the preview-URL pattern. The org grant's `credentialRef` resolves to the
// Vercel team token (a bearer) — resolved by the base, never held here.
//
// Preview-URL pattern (CONVERGED on the dashboard's `derivePreviewUrl`): Vercel
// serves a DETERMINISTIC per-branch preview at
//   https://<project>-git-<branch>[-<team-slug>].vercel.app
// We capture that with a `{branch}` placeholder (the same token the dashboard
// substitutes) — NOT a `*` wildcard, which the dashboard could not resolve.
//
// Deploy trigger: `triggerDeploy` POSTs `/v13/deployments` with a `gitSource` in the
// v13 github variant (`{ type:"github", org, repo, ref, sha }` — org=owner, repo=bare
// name, sha=the merged commit), so Vercel pulls the merged commit and builds + releases
// it. It returns the live deployment id + the resolved deployment URL.

import { createHash } from "node:crypto";
import type { OrgGrant, ProjectContext } from "../contracts/integrationProvisioner.js";
import { fixedPointRuleJudgment } from "../workflow/convergenceDetector.js";
import { retryUntilConverged, type AttemptSignature } from "../workflow/retryUntilConverged.js";
import {
  DeployProvisioner,
  type DeployApp,
  type DeployArtifactIdentity,
  type DeployEnvVar,
  type DeploymentStatus,
  type DeployProviderApi,
  type DeployProvisionerDeps,
  type DeployResult,
  type DeploySource,
} from "./deployProvisioner.js";

const VERCEL_API_BASE = "https://api.vercel.com";
export const VERCEL_PROVIDER_KIND = "deploy.vercel";

interface VercelProject {
  id: string;
  name: string;
}

interface VercelProjectsListResponse {
  projects?: VercelProject[];
  /**
   * Continuation-token pagination: `next` is the token to pass as the `from` query
   * param to fetch the next page (null/absent when the list is exhausted). Without
   * following this, a team with more projects than one page returns would HIDE the
   * target app behind the page boundary → a spurious "unknown app" deploy failure.
   */
  pagination?: { next?: number | string | null };
}

type JsonRecord = Record<string, unknown>;

function jsonRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : {};
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value !== "");
}

function deploymentUrl(raw: string | undefined): string {
  return raw === undefined ? "" : raw.startsWith("http") ? raw : `https://${raw}`;
}

/** Read the Vercel team id (if any) from the org grant metadata. */
function teamId(grant: OrgGrant): string | undefined {
  const value = grant.metadata["teamId"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Read the Vercel team slug (if any) — shapes the preview-URL pattern. */
function teamSlug(grant: OrgGrant): string | undefined {
  const value = grant.metadata["slug"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Compose the team-scoped Vercel preview-URL pattern for a project. Uses the
 * DETERMINISTIC git-branch preview form (`<project>-git-<branch>-<scope>`) with a
 * `{branch}` placeholder — the SAME token the dashboard's `derivePreviewUrl`
 * substitutes — so a rendered preview URL resolves directly (no `*` wildcard).
 */
function previewUrlPattern(grant: OrgGrant, projectName: string): string {
  const slug = teamSlug(grant);
  const suffix = slug === undefined ? "" : `-${slug}`;
  return `https://${projectName}-git-{branch}${suffix}.vercel.app`;
}

/**
 * Split a `owner/name` repo slug into the Vercel gitSource `org` (owner) + `repo`
 * (bare name). The v13 github gitSource variant requires the owner and the bare
 * repo name as SEPARATE fields — passing the full `owner/name` as `repo` is the
 * shape Vercel rejects. A slug without exactly one `/` is a wiring bug — fail LOUD.
 */
function splitRepoSlug(slug: string): { org: string; name: string } {
  const parts = slug.split("/");
  const org = parts[0];
  const name = parts[1];
  if (parts.length !== 2 || org === undefined || org === "" || name === undefined || name === "") {
    throw new Error(`vercel deploy: repo slug '${slug}' is not a valid 'owner/name' (cannot build the gitSource)`);
  }
  return { org, name };
}

/** Append `teamId=` when the grant carries a team id (joined with `&` if the path already has a query). */
function scoped(grant: OrgGrant, path: string): string {
  const team = teamId(grant);
  const url = `${VERCEL_API_BASE}${path}`;
  if (team === undefined) {
    return url;
  }
  const sep = path.includes("?") ? "&" : "?";
  return `${url}${sep}teamId=${encodeURIComponent(team)}`;
}

class VercelDeployApi implements DeployProviderApi {
  readonly providerKind = VERCEL_PROVIDER_KIND;

  constructor(private readonly transport: DeployProvisionerDeps["transport"]) {}

  async listApps(grant: OrgGrant, token: string): Promise<DeployApp[]> {
    // PAGINATED: follow `pagination.next` (passed back as the `from` query token) across
    // every page so a team with more projects than one page returns is fully listed —
    // an unpaginated single page would HIDE the target app and yield a spurious "unknown
    // app" deploy failure.
    //
    // PROGRESS-BASED, NOT COUNTED (audit C3 F1 + feedback_no_timeouts_progress_based): the
    // pager runs UNBOUNDED while the cursor ADVANCES. A cursor that changes = progress; a
    // cursor that repeats byte-identically across attempts = a genuinely stuck provider (a
    // pathological pagination echo). The fixed-point rule fires on the FIRST repeat via
    // `retryUntilConverged` + `reproducedIdenticalWork` (both `failureSignature` and
    // `workSignature` key on the current cursor, so an immediate repeat is proof of no new
    // information). A legitimately-large team (>100 pages) is fully listed; a broken
    // pagination surface fails LOUD with the stuck cursor in the diagnostic.
    const apps: DeployApp[] = [];
    let from: string | undefined;
    // The next cursor observed on the previous attempt (the input `from` of the next call).
    // Its identity is the ONLY convergence signal — advancing = progress, repeated = stuck.
    let previousCursor: string | undefined;

    const outcome = await retryUntilConverged<DeployApp[]>({
      attempt: async (_history): Promise<{ result: DeployApp[]; signature: AttemptSignature; done: boolean }> => {
        const path = from === undefined ? "/v9/projects" : `/v9/projects?from=${encodeURIComponent(from)}`;
        const response = await this.transport.request({
          method: "GET",
          url: scoped(grant, path),
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) {
          // A non-2xx from Vercel is a LOUD hard failure (never "failed after N pages") —
          // thrown out of the loop entirely, before any convergence assessment.
          throw new Error(`vercel list projects failed: ${response.status} ${response.text}`);
        }
        const body = (response.json ?? {}) as VercelProjectsListResponse;
        for (const project of body.projects ?? []) {
          apps.push({
            appId: project.id,
            name: project.name,
            previewUrlPattern: previewUrlPattern(grant, project.name),
          });
        }
        const next = body.pagination?.next;
        if (next === undefined || next === null || next === "") {
          // Genuine end-of-list: the provider signalled exhaustion. Return DONE.
          return {
            result: apps,
            signature: { failureSignature: "vercel-projects-page", workSignature: "__terminal__" },
            done: true,
          };
        }
        const nextCursor = String(next);
        // Key BOTH failure and work signatures on the returned cursor: a byte-identical
        // repeat across successive attempts trips `reproducedIdenticalWork` (an immediate-
        // neighbor fixed point — the fastest read of a genuinely stuck pager). A cursor
        // that changes = progress (the natural pagination advance).
        const signature: AttemptSignature = {
          failureSignature: "vercel-projects-page",
          workSignature: nextCursor,
        };
        previousCursor = nextCursor;
        from = nextCursor;
        return { result: apps, signature, done: false };
      },
      // No agent to consult at a pager fixed point: the rigorous rule stands in — escalate
      // ONLY at a PROVEN identical-cursor recurrence, with a human-actionable diagnosis
      // naming the stuck cursor.
      judge: (history) =>
        fixedPointRuleJudgment(history, () => {
          const stuckCursor = history.at(-1)?.workSignature ?? previousCursor ?? "unknown";
          return `vercel list projects: pagination cursor '${stuckCursor}' did not advance (the provider echoed the same 'next' token — pagination is stuck)`;
        }),
      // No backoff: pages are read back-to-back. A paced spacing here would only slow the
      // list, never bound it.
    });

    if (outcome.kind === "escalate") {
      // A PROVEN stuck pager — the cursor never advanced. LOUD, with the stuck cursor as
      // evidence (the same shape the old cap threw, only sharper: it names the WHY).
      throw new Error(outcome.reason);
    }
    return outcome.result;
  }

  async createApp(grant: OrgGrant, token: string, name: string, _projectCtx: ProjectContext): Promise<DeployApp> {
    const response = await this.transport.request({
      method: "POST",
      url: scoped(grant, "/v9/projects"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: { name },
    });
    if (!response.ok) {
      // 409 "project already exists" on an ALREADY-NAMESPACED name (task #27) means
      // the same Tanren org tried to provision the same projectName twice — itself
      // a derive-side idempotency/race bug. HALT LOUD (no silent suffix-retry) —
      // see the mirror comment in `flyDeployProvisioner.createApp`.
      if (response.status === 409 || response.status === 422) {
        throw new Error(
          `vercel create project '${name}' failed (${String(response.status)}): ${response.text}. ` +
            `The deploy-app namespacing rule (task #27) already prefixed this name with the org slug, ` +
            `so a duplicate-name reject here means a re-derive race within the SAME org under the SAME ` +
            `project name (re-derive with a distinct project name) OR a stale Vercel project the discover ` +
            `step missed. NOT a fallback: there is no automatic suffix-retry.`,
        );
      }
      throw new Error(`vercel create project failed: ${response.status} ${response.text}`);
    }
    const project = response.json as VercelProject | undefined;
    if (project?.id === undefined || project.name === undefined) {
      throw new Error(`vercel create project returned no id/name: ${response.text}`);
    }
    return {
      appId: project.id,
      name: project.name,
      previewUrlPattern: previewUrlPattern(grant, project.name),
    };
  }

  async setEnvVars(grant: OrgGrant, token: string, appId: string, vars: ReadonlyArray<DeployEnvVar>): Promise<void> {
    // Vercel env upsert: POST /v10/projects/{id}/env with `?upsert=true` so a
    // re-attach updates the existing var rather than 409ing on a duplicate key.
    // `target: ["production"]` scopes the var to the deployed (production) runtime
    // — the runtime-scoped App-Environment entries map to the production deploy.
    for (const variable of vars) {
      const response = await this.transport.request({
        method: "POST",
        url: scoped(grant, `/v10/projects/${encodeURIComponent(appId)}/env?upsert=true`),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: { key: variable.key, value: variable.value, type: "encrypted", target: ["production"] },
      });
      if (!response.ok) {
        // The error text is provider-supplied (status + provider message); the
        // VALUE we sent is never interpolated into the thrown message.
        throw new Error(`vercel set env '${variable.key}' failed: ${response.status} ${response.text}`);
      }
    }
  }

  async triggerDeploy(grant: OrgGrant, token: string, app: DeployApp, source: DeploySource): Promise<DeployResult> {
    // POST /v13/deployments with a `gitSource` so Vercel pulls the MERGED commit and
    // builds + releases it. `name` ties the deployment to the existing project;
    // `target: production` releases it as the live deploy. Vercel returns the
    // deployment id + the resolved deployment URL.
    //
    // gitSource shape (v13 github variant, per the live REST reference): the github
    // variant is `{ type:"github", org, repo, ref, sha }` — `org` is the repo OWNER,
    // `repo` is the BARE repo name (NOT `owner/name`), `ref` the branch/ref, and the
    // COMMIT goes in `sha`. The merged source's `repo` is the `owner/name` slug, so we
    // split it into `org`/`repo`. The merged commit SHA pins the exact build: it is set
    // as `sha` AND as `ref` (Vercel accepts a SHA as a ref; the run's PR branch is
    // squash-deleted, so the SHA is the only durable handle to the merged commit).
    const { org, name: repoName } = splitRepoSlug(source.repo);
    const response = await this.transport.request({
      method: "POST",
      url: scoped(grant, "/v13/deployments"),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: {
        name: app.name,
        project: app.appId,
        target: "production",
        gitSource: { type: "github", org, repo: repoName, ref: source.ref, sha: source.ref },
      },
    });
    if (!response.ok) {
      throw new Error(`vercel trigger deploy for '${app.appId}' failed: ${response.status} ${response.text}`);
    }
    const body = (response.json ?? {}) as { id?: string; url?: string; readyState?: string; status?: string };
    if (body.id === undefined || body.url === undefined) {
      throw new Error(`vercel trigger deploy for '${app.appId}' returned no id/url: ${response.text}`);
    }
    // Vercel's `url` is the bare host (no scheme); normalize to an https origin so
    // the resolved URL is directly renderable.
    const url = deploymentUrl(body.url);
    return { deploymentId: body.id, url, state: body.readyState ?? body.status ?? "QUEUED" };
  }

  async destroyApp(grant: OrgGrant, token: string, app: DeployApp): Promise<void> {
    // DELETE /v9/projects/{id} — Vercel's project-destroy. IDEMPOTENT per the task
    // #78 compensation contract: 404 ⇒ the project is already gone (success).
    // Other failures propagate LOUD so the compensation walker records the
    // rollback gap. Vercel keys a project by its STABLE id (not name) in the path;
    // the team scope is threaded as the `teamId` query param via `scoped`.
    const response = await this.transport.request({
      method: "DELETE",
      url: scoped(grant, `/v9/projects/${encodeURIComponent(app.appId)}`),
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok || response.status === 404) {
      return;
    }
    throw new Error(`vercel destroy project '${app.appId}' failed: ${response.status} ${response.text}`);
  }

  async resolveArtifactIdentity(
    grant: OrgGrant,
    token: string,
    app: DeployApp,
    deploymentId: string,
  ): Promise<DeployArtifactIdentity> {
    const response = await this.transport.request({
      method: "GET",
      url: scoped(grant, `/v13/deployments/${encodeURIComponent(deploymentId)}`),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`vercel resolve artifact for '${deploymentId}' failed: ${response.status} ${response.text}`);
    }

    const body = jsonRecord(response.json);
    const meta = jsonRecord(body["meta"]);
    const build = jsonRecord(body["build"]);
    const buildMeta = jsonRecord(build["meta"]);
    const gitSource = jsonRecord(body["gitSource"]);
    const explicitDigest = firstString(
      body["artifactDigest"],
      meta["artifactDigest"],
      build["artifactDigest"],
      buildMeta["artifactDigest"],
    );
    const genericDigest = firstString(body["digest"], meta["digest"], build["digest"], buildMeta["digest"]);
    const checksum = firstString(body["checksum"], meta["checksum"], build["checksum"], buildMeta["checksum"]);
    let artifactDigest =
      explicitDigest ??
      (genericDigest?.startsWith("sha512:") === true ? undefined : genericDigest) ??
      (checksum?.startsWith("sha256:") === true ? checksum : undefined);

    if (artifactDigest === undefined) {
      const sourceSha = firstString(
        meta["githubCommitSha"],
        meta["gitlabCommitSha"],
        meta["bitbucketCommitSha"],
        meta["gitCommitSha"],
        buildMeta["githubCommitSha"],
        buildMeta["gitCommitSha"],
        gitSource["sha"],
      );
      if (sourceSha === undefined) {
        throw new Error(
          `vercel resolve artifact for '${deploymentId}' on '${app.appId}' returned neither a sha256 digest nor a source sha`,
        );
      }
      const hex = createHash("sha256").update(`${deploymentId}:${sourceSha}`).digest("hex");
      artifactDigest = `sha256:${hex}`;
    }

    const explicitProviderChecksum = firstString(
      body["providerChecksum"],
      meta["providerChecksum"],
      build["providerChecksum"],
      buildMeta["providerChecksum"],
      body["sha512"],
      meta["sha512"],
      build["sha512"],
      buildMeta["sha512"],
    );
    const providerChecksum =
      explicitProviderChecksum ??
      (genericDigest?.startsWith("sha512:") === true ? genericDigest : undefined) ??
      (checksum?.startsWith("sha256:") === true ? undefined : checksum) ??
      null;
    return { artifactDigest, providerChecksum };
  }

  async promoteToProduction(
    grant: OrgGrant,
    token: string,
    app: DeployApp,
    deploymentId: string,
  ): Promise<DeployResult> {
    return this.transitionProduction(grant, token, app, deploymentId, "promote");
  }

  async rollbackToDeployment(
    grant: OrgGrant,
    token: string,
    app: DeployApp,
    targetDeploymentId: string,
  ): Promise<DeployResult> {
    return this.transitionProduction(grant, token, app, targetDeploymentId, "rollback");
  }

  async teardownDeployment(grant: OrgGrant, token: string, _app: DeployApp, deploymentId: string): Promise<void> {
    const response = await this.transport.request({
      method: "DELETE",
      url: scoped(grant, `/v13/deployments/${encodeURIComponent(deploymentId)}`),
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.ok || response.status === 404) {
      return;
    }
    throw new Error(`vercel teardown deployment '${deploymentId}' failed: ${response.status} ${response.text}`);
  }

  async getDeployment(
    grant: OrgGrant,
    token: string,
    _app: DeployApp,
    deploymentId: string,
  ): Promise<DeploymentStatus> {
    // GET /v13/deployments/{id} → the deployment's `readyState` (Vercel's lifecycle:
    // QUEUED → BUILDING → READY, or ERROR / CANCELED on failure). The verify poll
    // collapses that into the ready/failed terminals it waits on.
    const response = await this.transport.request({
      method: "GET",
      url: scoped(grant, `/v13/deployments/${encodeURIComponent(deploymentId)}`),
      headers: { authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      throw new Error(`vercel get deployment '${deploymentId}' failed: ${response.status} ${response.text}`);
    }
    const body = (response.json ?? {}) as { url?: string; readyState?: string; status?: string };
    const state = body.readyState ?? body.status ?? "QUEUED";
    const url = deploymentUrl(body.url);
    return {
      state,
      terminalReady: state === "READY",
      terminalFailed: state === "ERROR" || state === "CANCELED",
      url,
    };
  }

  private async transitionProduction(
    grant: OrgGrant,
    token: string,
    app: DeployApp,
    deploymentId: string,
    operation: "promote" | "rollback",
  ): Promise<DeployResult> {
    const response = await this.transport.request({
      method: "POST",
      url: scoped(
        grant,
        `/v10/projects/${encodeURIComponent(app.appId)}/${operation}/${encodeURIComponent(deploymentId)}`,
      ),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(
        `vercel ${operation} deployment '${deploymentId}' on '${app.appId}' failed: ${response.status} ${response.text}`,
      );
    }
    const status = await this.getDeployment(grant, token, app, deploymentId);
    if (status.url === "") {
      throw new Error(`vercel ${operation} deployment '${deploymentId}' returned no production URL`);
    }
    return { deploymentId, url: status.url, state: status.state };
  }
}

/** The Vercel deploy provisioner (`deploy.vercel`). */
export class VercelDeployProvisioner extends DeployProvisioner {
  constructor(deps: DeployProvisionerDeps) {
    super(new VercelDeployApi(deps.transport), deps);
  }
}
