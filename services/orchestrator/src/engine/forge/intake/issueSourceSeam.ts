// The intake poller's `IssueSource` seam impl (engineSeams.ts) — the purpose-based
// seam through which intake reads issues, with the GitHub credential resolved the
// SAME way the rest of the engine resolves it: an App installation token when the
// org has installed the App, ELSE the org's default static GitHub token. This
// replaces the prior App-token-ONLY minting in `bootIntake.ts`, which silently
// produced NO intake connector when the App was absent (the binding
// no-silent-fallbacks doctrine: a required-but-missing credential is a LOUD
// fail-closed error, never a quiet degrade to no poller).
//
// Distinction the seam enforces:
//   • intake NOT configured for a project/org → no GitHub `issues` source listed →
//     no poller runs over it (the legitimate "no intake" case — no error).
//   • intake CONFIGURED (a github `issues` source exists) BUT the credential
//     cannot be resolved (App not installed AND no org-default static token) → a
//     LOUD fail-closed error naming the missing credential, never a silent skip.
//
// Non-GitHub issue sources (linear/jira) and error sources (sentry) carry their
// OWN per-source token ref in their config, so they do not depend on the org's
// GitHub credential; only a GitHub-provider `issues` source needs this resolution.

import type pg from "pg";
import type { SecretStore } from "../../contracts/secretStore.js";
import type { GitHubHttpClient } from "../../providers/github.js";
import type { GithubAppTokenMinter } from "../../providers/githubAppTokenMinter.js";
import { loadOrgDefaultGithubCredentialRef, loadOrgGithubAppInstallation } from "../../credentials/orgGithubApp.js";
import {
  MissingGithubCredentialRefError,
  NoGithubCredentialConfiguredError,
} from "../../credentials/githubTokenResolver.js";
import { IntakeSourceAuthError } from "../inbox/connectorErrors.js";
import { buildInboxConnectorMap, type InboxSource, type SourceConnector } from "../inbox/index.js";

/**
 * Thrown when a project/org HAS a GitHub `issues` intake source configured but no
 * GitHub credential can be resolved for that org: the App is not installed AND the
 * org has set no default static GitHub token. Per the no-silent-fallbacks
 * doctrine this is a LOUD fail-closed configuration error (the operator must
 * install the App or set the org-default `github_token`), NOT a silent no-poller.
 */
export class IntakeGithubCredentialMissingError extends Error {
  readonly retriable = false as const;
  readonly orgId: string;
  readonly sourceId: string;

  constructor(orgId: string, sourceId: string) {
    super(
      `intake source ${sourceId} (org ${orgId}) is a configured GitHub issues source but no GitHub credential ` +
        `resolves for the org: no App installation and no org-default github_token ` +
        `(organizations.config.defaultCredentials.github_token). ` +
        `Install the GitHub App or set the org-default github_token.`,
    );
    this.name = "IntakeGithubCredentialMissingError";
    this.orgId = orgId;
    this.sourceId = sourceId;
  }
}

/**
 * Whether `error` is a credential-RESOLUTION failure — a configured source whose
 * GitHub credential cannot be resolved, on EITHER path:
 *   • the EAGER org-default path — {@link IntakeGithubCredentialMissingError}
 *     (no App installed AND no org-default static token), AND
 *   • the LAZY source-owned `config.staticRef` path — resolved later, inside the
 *     connector's `fetch`, where `resolveGithubToken` raises
 *     {@link NoGithubCredentialConfiguredError} (no ref at all) or
 *     {@link MissingGithubCredentialRefError} (the ref points at nothing), AND
 *   • the LIVE auth-rejected path — a connector's HTTP fetch comes back 401/403
 *     ({@link IntakeSourceAuthError}): the token resolved but the source denied it
 *     (expired/revoked/insufficient scope). Same class of misconfiguration — a
 *     LOUD fail-closed re-throw, not a swallowed "this source never ingests".
 *
 * The intake poller's `tick()` uses this single predicate so a configured GitHub
 * source whose credential cannot be resolved — by ANY path — is a LOUD
 * fail-closed re-throw, never swallowed as an ordinary per-source transient. A
 * shared predicate (not a per-type check) keeps a future credential-error type
 * from silently slipping back into the swallowed path: add it here once and both
 * the eager and lazy paths stay loud. Genuinely transient errors (network, 5xx,
 * rate-limit) are NOT in this class and remain per-source transients.
 */
export function isCredentialResolutionError(error: unknown): boolean {
  return (
    error instanceof IntakeGithubCredentialMissingError ||
    error instanceof NoGithubCredentialConfiguredError ||
    error instanceof MissingGithubCredentialRefError ||
    error instanceof IntakeSourceAuthError
  );
}

export interface BuildIntakeConnectorMapDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  githubHttp: GitHubHttpClient;
  // The shared App-token minter (installation-token cache). Threaded into the
  // GitHub issues connector for the App-installation path; absent is FINE for an
  // org on the static-token path (it does not silently disable intake).
  githubAppMinter?: GithubAppTokenMinter;
}

/**
 * Whether a source is a GitHub-provider `issues` source — the only source whose
 * polling depends on the org's GitHub credential. A GitHub source carries kind
 * `issues` with either no `provider` (github is the default) or `provider:
 * "github"`; linear/jira issues sources and sentry error sources carry their own
 * per-source token ref. A source that already pins its OWN `config.staticRef`
 * supplies its credential directly and so does not require the org-default.
 */
function isGithubIssuesSourceNeedingOrgCredential(source: InboxSource): boolean {
  if (source.kind !== "issues") return false;
  const config = source.config as { provider?: unknown; staticRef?: unknown };
  const provider = config.provider;
  const isGithub = provider === undefined || provider === "github";
  if (!isGithub) return false;
  // A source pinning its own static ref supplies its credential — no org-default needed.
  if (typeof config.staticRef === "string" && config.staticRef.length > 0) return false;
  return true;
}

/**
 * Build the intake connector map for ONE org, resolving the GitHub credential the
 * SAME way the rest of the engine does — App installation token when installed,
 * ELSE the org's default static GitHub token (threaded into the connector as its
 * `staticRef`). The resolution is EXPLICIT and fail-closed:
 *   • `githubSource` names the org's configured GitHub `issues` source (when one
 *     exists) so a missing credential raises {@link IntakeGithubCredentialMissingError}
 *     against that source — a LOUD failure, never a silent no-connector.
 *   • when NO GitHub source needs the org credential (only linear/jira/sentry, or
 *     a source pinning its own ref, or no intake configured at all), the map is
 *     built without an org-default github ref — the legitimate "no GitHub intake"
 *     case, no error.
 */
export async function buildIntakeConnectorMapForOrg(
  deps: BuildIntakeConnectorMapDeps,
  orgId: string,
  sources: ReadonlyArray<InboxSource>,
): Promise<ReadonlyMap<string, SourceConnector>> {
  const githubSource = sources.find((source) => isGithubIssuesSourceNeedingOrgCredential(source));
  const installation = await loadOrgGithubAppInstallation(deps.pool, orgId);
  const staticRef = installation === undefined ? await loadOrgDefaultGithubCredentialRef(deps.pool, orgId) : undefined;

  // Configured-but-missing → LOUD fail-closed. A GitHub issues source exists for
  // this org, yet neither an App installation nor an org-default static token
  // resolves: the poller would otherwise mint no connector and the source would
  // silently never ingest. Name the missing credential and throw.
  if (githubSource !== undefined && installation === undefined && (staticRef === undefined || staticRef === "")) {
    throw new IntakeGithubCredentialMissingError(orgId, githubSource.id);
  }

  return buildInboxConnectorMap({
    secrets: deps.secrets,
    githubHttp: deps.githubHttp,
    ...(installation === undefined ? {} : { installation }),
    ...(staticRef === undefined ? {} : { defaultGithubStaticRef: staticRef }),
    ...(deps.githubAppMinter === undefined ? {} : { minter: deps.githubAppMinter }),
  });
}
