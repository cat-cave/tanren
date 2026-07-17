// shared run-context loading for the review + merge stages. Both
// stages need the same run row (PR URL, project config → mergeIntegration,
// org App installation). Kept in one place so reviewPolling.ts and
// mergeDispatch.ts stay focused and under the 500-line cap.

import { createHash } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  bindOrgGithubCredentialRefs,
  migrateOrgConfig,
  type OrgGithubAppInstallation,
} from "../../config/orgConfig.js";
import {
  bindProjectGithubCredentialRefs,
  migrateProjectConfig,
  type ProjectConfigV1,
} from "../../config/projectConfig.js";
import type { GovernancePosture, MergeIntegration, ReviewPolicy } from "../../config/shared.js";
import { normalizeStaticGithubRef } from "../../credentials/githubToken.js";
import { canonicalOrgGithubCredentialRef } from "../../credentials/refNamespace.js";

export type RunStateClient = Pick<pg.Pool | pg.PoolClient, "query">;

/**
 * the conventional login Tanren's own pushes carry when no org App is
 * installed. The GitHub App bot login is `<app-slug>[bot]`; absent a configured
 * slug we fall back to this so external-change detection still has a Tanren
 * identity to compare against.
 */
export const DEFAULT_TANREN_LOGIN = "tanren[bot]";

export interface ReviewMergeRunContext {
  runId: string;
  specId: string;
  projectId: string;
  /**
   * The run's tenant key (`runs.org_id`, NOT NULL on the table — every loaded run
   * resolves a real org). Surfaced on the context so every downstream tenant write
   * (event-store append, integration upserts, etc.) stamps `org_id` directly rather
   * than re-derive it via a SELECT-join subquery. v68 fix: the prior eventStore
   * shape derived org_id from `(SELECT org_id FROM projects WHERE project_id = $4)`
   * — an org-scoped append with no project, or a project lookup that returned no
   * rows, landed `org_id` NULL and RLS denied. Explicit `orgId` eliminates that.
   */
  orgId: string;
  prUrl: string;
  /** The PR's base branch (project default), for conflict-event payloads. */
  baseBranch: string;
  /**
   * The PR's HEAD branch (the run's `runs.branch`) — the ref whose head sha the
   * §5h `CodeHost`-derived freshness signal compares against the base. `""` for a
   * run that has not recorded a branch (the freshness probe then reports `unknown`).
   */
  headBranch: string;
  /** Resolved per-repo merge integration (project config). */
  mergeIntegration: MergeIntegration;
  /** external-push governance posture (project config). */
  governancePosture: GovernancePosture;
  /**
   * AUDIT-EVIDENCE BASELINE: the config SCHEMA version in effect for this run's
   * merge decision. Stamped onto the governing `merge.completed` / `gate.verdict`
   * audit envelope (`AuditEnvelope.policyVersion`, a numeric schema-version record).
   * NOTE (gv-3): this is the config SCHEMA version (a literal `1` today), NOT the
   * proof-reuse / TOCTOU identity — that is {@link policyIdentity}. The two are kept
   * distinct: the audit envelope records the schema version; the authority keys its
   * proof on the effective-policy content hash.
   */
  policyVersion: number;
  /**
   * gv-3 — the REAL governance policy identity for this run's merge decision: a
   * content hash over the EFFECTIVE governance policy (posture / review policy /
   * audit posture / merge integration / budget). This is the identity stamped into
   * `authority_decisions.policy_version` and folded into the MergeAuthority proof key
   * (`proofRoot` / the mq-eval evaluation id), REPLACING the schema-literal `version`
   * (always `1`) that made policy-sensitive proof reuse + TOCTOU protection illusory.
   * A posture change (e.g. `auditPosture` balanced→strict, `reviewPolicy` auto→human)
   * yields a DIFFERENT identity, so a stale proof for a now-changed policy is refused.
   * An interim real fingerprint pending the full versioned governance revision system
   * (docs/roadmap/mission-complete/nodes/governance.md); content-addressed, never a
   * fabricated constant.
   */
  policyIdentity: string;
  /**
   * Whether the review stage requires a human verdict before merge (project
   * config). `auto` short-circuits the review poll to an approved verdict;
   * `human` (the default) preserves the GitHub-polling behavior.
   */
  reviewPolicy: ReviewPolicy;
  /**
   * GitHub logins that represent Tanren's own pushes on this repo.
   * External-change detection treats any other contributor as non-Tanren.
   *
   * MERGE-SAFETY (self-identity): this is the ADDITIVE belt-and-suspenders set —
   * the default bot login plus any operator-configured `governanceTanrenLogins`.
   * The AUTHORITATIVE entry is the login the merge stage resolves from the ACTIVE
   * credential (`resolveActorIdentity`) and merges in at `evaluatePosture`, so the
   * identity set agrees with the login the runner's commits actually carry.
   */
  tanrenLogins: ReadonlyArray<string>;
  /**
   * MERGE-HARDENING (GAP #3): the configurable PLATFORM / KNOWN-AUTOMATION committer
   * login set, ADDITIVE to the built-in `web-flow`. On an AUTONOMOUS tier (reviewPolicy
   * `auto`/`simulated` + `native_queue`) a posture BLOCK whose external committers are
   * ALL in this set is AUTO-APPROVED rather than stranding a done-run spec into a
   * 3×-churn→park. NOT Tanren's own identity; on the `human` tier these still block.
   */
  platformLogins: ReadonlyArray<string>;
  /** App installation, when the org has installed the App (preferred token). */
  installation?: OrgGithubAppInstallation;
  /** Static GitHub credential ref (fallback when no App is installed). */
  staticCredentialRef?: string;
}

export class ReviewMergeRunNotFoundError extends Error {
  constructor(runId: string) {
    super(`run not found for review/merge: ${runId}`);
  }
}

export class ReviewMergePullRequestNotFoundError extends Error {
  constructor(runId: string) {
    super(`run has no pull request URL for review/merge: ${runId}`);
  }
}

export class ReviewMergeRunLineageMismatchError extends Error {
  constructor(runId: string) {
    super(`run ownership lineage does not match for review/merge: ${runId}`);
  }
}

/**
 * Options for {@link loadReviewMergeRunContext}.
 *
 * `resolvedGithubCredentialRef` is the GitHub credential ref the run already
 * resolved for the PR-creation + CI-poll steps (`resolveCredentialsForRun` →
 * project RECORD `githubCredentialRef` → org default). The review/merge stage
 * MUST resolve its token from the SAME source as those steps, so the run path
 * threads this in. When present it wins over the project-config-JSONB lookup;
 * absent (e.g. an out-of-band caller with no pre-resolved ref) it falls back to
 * the config-JSONB ref. `projects link --github-credential-ref` writes the
 * project RECORD column, NOT the config JSONB, so the JSONB-only path returned
 * undefined and the resolver fell back to a (removed) static default ref.
 */
export interface LoadReviewMergeRunContextOptions {
  resolvedGithubCredentialRef?: string;
}

/**
 * Build the context options from a stage input that carries an optional
 * `resolvedGithubCredentialRef`. Shared by the review + merge stages so the
 * exactOptionalPropertyTypes spread lives in one place.
 */
export function contextOptionsFor(input: { resolvedGithubCredentialRef?: string }): LoadReviewMergeRunContextOptions {
  return input.resolvedGithubCredentialRef === undefined
    ? {}
    : { resolvedGithubCredentialRef: input.resolvedGithubCredentialRef };
}

export async function loadReviewMergeRunContext(
  pool: RunStateClient,
  runId: string,
  options: LoadReviewMergeRunContextOptions = {},
): Promise<ReviewMergeRunContext> {
  const result = await pool.query(
    // org_id is the run's tenant key (NOT NULL on `runs`); surfaced on the context so
    // every downstream tenant write (event-store append) stamps it directly (v68 fix).
    `SELECT r.run_id, r.spec_id, r.project_id, r.org_id, r.pr_url, r.branch,
            p.config, p.default_branch, p.org_id AS project_org_id,
            s.org_id AS spec_org_id, s.project_id AS spec_project_id,
            o.config AS org_config
     FROM runs r
     LEFT JOIN projects p ON p.project_id = r.project_id
     LEFT JOIN specs s ON s.spec_id = r.spec_id
     LEFT JOIN organizations o ON o.id = r.org_id
     WHERE r.run_id = $1`,
    [runId],
  );
  const rawRow = result.rows[0];
  if (rawRow === undefined) {
    throw new ReviewMergeRunNotFoundError(runId);
  }
  const row = ReviewMergeRunRow.parse(rawRow);
  if (row.project_org_id !== row.org_id || row.spec_org_id !== row.org_id || row.spec_project_id !== row.project_id) {
    throw new ReviewMergeRunLineageMismatchError(runId);
  }
  if (row.pr_url === null) {
    throw new ReviewMergePullRequestNotFoundError(runId);
  }
  const projectConfig = bindProjectGithubCredentialRefs(migrateProjectConfig(row.config), row.org_id);
  const installation =
    row.org_config === null || row.org_config === undefined
      ? undefined
      : bindOrgGithubCredentialRefs(migrateOrgConfig(row.org_config), row.org_id).github_app;
  const staticCredentialRef = resolvedStaticCredentialRef(
    options.resolvedGithubCredentialRef,
    projectConfig,
    row.org_id,
  );
  return {
    runId: row.run_id,
    specId: row.spec_id,
    projectId: row.project_id,
    orgId: row.org_id,
    prUrl: row.pr_url,
    baseBranch: row.default_branch ?? "main",
    headBranch: row.branch ?? "",
    mergeIntegration: projectConfig.mergeIntegration,
    governancePosture: projectConfig.governancePosture,
    policyVersion: projectConfig.version,
    policyIdentity: computeMergePolicyIdentity(projectConfig),
    reviewPolicy: projectConfig.reviewPolicy,
    tanrenLogins: tanrenLoginsFor(projectConfig.governanceTanrenLogins),
    platformLogins: projectConfig.governancePlatformLogins ?? [],
    installation,
    ...(staticCredentialRef !== undefined && { staticCredentialRef }),
  };
}

/**
 * Pick the static GitHub credential ref the review/merge stage resolves its
 * token from. The run-resolved ref (the same one the PR-creation + CI-poll steps
 * used) wins; otherwise fall back to the project-config-JSONB ref for out-of-band
 * callers that did not pre-resolve.
 */
function resolvedStaticCredentialRef(
  resolvedRef: string | undefined,
  config: ProjectConfigV1,
  orgId: string,
): string | undefined {
  if (typeof resolvedRef === "string" && resolvedRef.trim() !== "") {
    return canonicalOrgGithubCredentialRef({ orgId, supplied: resolvedRef, kind: "github_token" });
  }
  return normalizeStaticGithubRef(config.credentials?.githubCredentialRef);
}

/**
 * gv-3 — derive the REAL governance policy identity for a project's merge decision. A
 * deterministic content hash over the EFFECTIVE governance policy fields the MergeAuthority
 * + governance path actually gate on (config schema version, governance posture, review
 * policy, merge integration, the audit posture DORA knob, and the budget envelope). It
 * REPLACES the schema-literal `config.version` (always `1`) as the proof-reuse / TOCTOU
 * identity: two projects/postures hash differently, and changing a project's posture yields
 * a new identity — so the authority never reuses a proof produced under a different policy.
 *
 * Content-addressed + honest: this is NOT a fabricated constant and does NOT pretend to be
 * an immutable governance revision number — it is a fingerprint of the policy in force,
 * an interim real identity pending the full versioned governance revision system. The
 * canonical form fixes field ORDER (no key-sort dependence) so the SAME policy always
 * hashes to the SAME identity.
 */
export function computeMergePolicyIdentity(config: ProjectConfigV1): string {
  const canonical = JSON.stringify([
    ["schemaVersion", config.version],
    ["governancePosture", config.governancePosture],
    ["reviewPolicy", config.reviewPolicy],
    ["mergeIntegration", config.mergeIntegration],
    [
      "auditPosture",
      {
        blockReviewAt: config.auditPosture.blockReviewAt,
        p2p3Handling: config.auditPosture.p2p3Handling,
        autonomousRemediation: config.auditPosture.autonomousRemediation ?? false,
      },
    ],
    ["budget", config.budget ?? null],
  ]);
  return `policy-sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * The ADDITIVE belt-and-suspenders logins Tanren's own pushes carry — the default
 * bot login plus any operator-configured `governanceTanrenLogins` (optional; empty
 * by default — the apex path needs ZERO config). The AUTHORITATIVE login is the one
 * the merge stage resolves from the active credential (`resolveActorIdentity`) and
 * merges into the identity set at `evaluatePosture`. The old bogus `app/<appId>`
 * entry is GONE — it was never a real GitHub login (the App bot login is
 * `<app-slug>[bot]`, now resolved live). De-duplication happens downstream in
 * `tanrenIdentity`.
 */
function tanrenLoginsFor(configured: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  return [DEFAULT_TANREN_LOGIN, ...(configured ?? [])];
}

// Typed row decode (no raw `as` cast — the architecture check forbids those in
// workflow code; we parse the SQL row through a Zod schema instead).
const ReviewMergeRunRow = z.object({
  run_id: z.string(),
  spec_id: z.string(),
  project_id: z.string(),
  // runs.org_id is NOT NULL on the table — every loaded run resolves a real org.
  org_id: z.string(),
  project_org_id: z.string().nullable(),
  spec_org_id: z.string().nullable(),
  spec_project_id: z.string().nullable(),
  pr_url: z.string().nullable(),
  branch: z.string().nullish(),
  config: z.unknown(),
  default_branch: z.string().nullable(),
  org_config: z.unknown(),
});
