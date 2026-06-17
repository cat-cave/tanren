// Collaborators for the deploy-on-merge watcher, split out of `deployOnMerge.ts` to keep
// that module under the 500-line cap: the verify + LOUD `deploy.failed`/`deploy.verified`
// appenders (the durable-failure recording the watcher composes), plus the small pure
// mappings (deploy audit envelope, repo slug from a PR URL, merged SHA from a
// `merge.completed` payload).

import { runWithJobOrgId, runWithSystemScope } from "@tanren/db";
import type pg from "pg";
import { serviceAuditActor, type AuditEnvelope } from "../events/schemas/audit.js";
import { isTemplateBuildProjectConfig } from "../config/index.js";
import type { EventStore } from "../eventStore.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { DeployHttpTransport } from "../provisioners/deployTransport.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import { buildDeployAdapter } from "../deploy/buildDeployAdapter.js";
import { DIRECT_API_ADAPTER_KIND } from "../deploy/directApiDeployAdapter.js";
import type { UrlReachabilityProbe, VerifyPollPolicy } from "../contracts/deployAdapter.js";
import type { ProjectDeployTarget } from "./deployOnMerge.js";
import { createLogger } from "../observability/logger.js";

const log = createLogger("deploy-on-merge");

// FIXED, non-secret `deploy.failed.reason`s. Deliberately NOT the raw error: it can
// embed provider-supplied HTTP response text (a potential secret), and this reason is
// persisted + public. The full error is preserved via the re-throw (subscriber logs it).
// `verify` = triggered but never proven live; `trigger` = an EXPECTED deploy (a target
// resolved) that could not even be triggered/attached (incomplete config, a missing/lost
// grant, a denied egress target, or the provider build/release failing) — recorded so it
// is just as LOUD + durable (→ a `deploy.failed` warn) as a verify exhaustion, never a
// silent log-only swallow that makes the merge look "done" with no live URL.
const DEPLOY_FAILED_REASON =
  "deploy verification did not reach a live deployment within the bounded retry; see the run logs for provider detail";
const DEPLOY_TRIGGER_FAILED_REASON =
  "an expected deploy could not be triggered or attached for the merged commit; see the run logs for the underlying error";

/** The deploy-path collaborators the verify/append helpers run over (the watcher's deps subset). */
export interface DeployVerifyContext {
  eventStore: EventStore;
  transport: DeployHttpTransport;
  secrets: SecretStore;
  urlProbe?: UrlReachabilityProbe;
  verifyPoll?: VerifyPollPolicy;
}

/**
 * Append the LOUD `deploy.failed` terminal under the org scope (the `reason` is a FIXED,
 * non-secret summary — see the constants). A `verify`-phase failure carries the
 * released-but-unproven deploymentId + attempt count; a `trigger`-phase one reached no
 * deployment, so both are honestly ABSENT.
 */
export async function appendDeployFailed(
  ctx: DeployVerifyContext,
  args: {
    runId: string;
    projectId: string;
    target: ProjectDeployTarget;
    phase: "trigger" | "verify";
    deploymentId?: string;
    attempts?: number;
  },
): Promise<void> {
  await runWithJobOrgId(args.target.orgId, async () => {
    await ctx.eventStore.append({
      runId: args.runId,
      projectId: args.projectId,
      eventType: "deploy.failed",
      payload: {
        provider: args.target.provider,
        appId: args.target.appId,
        phase: args.phase,
        ...(args.deploymentId !== undefined && { deploymentId: args.deploymentId }),
        ...(args.attempts !== undefined && { attempts: args.attempts }),
        reason: args.phase === "verify" ? DEPLOY_FAILED_REASON : DEPLOY_TRIGGER_FAILED_REASON,
        ...deployAuditEnvelope(args.target),
      },
    });
  });
}

/**
 * Append the DURABLE `deploy.skipped` under the org scope — so the operator + run
 * timeline SEE the skip instead of a console-only log line. The `reason` is a fixed
 * code; `detail` is a bounded, non-secret string (the resolution reason / wiring
 * detail). Two reasons (config_incomplete / merge_sha_missing) are emitted BEFORE the
 * watcher fails LOUD; `template_build` is a LEGITIMATE skip (a template-creation build
 * authors a template, not a product, so no product deploy fires) — recorded here so the
 * skip is observable, but the watcher returns WITHOUT throwing on it.
 */
export async function appendDeploySkipped(
  ctx: Pick<DeployVerifyContext, "eventStore">,
  args: {
    runId: string;
    projectId: string;
    orgId: string;
    reason: "config_incomplete" | "merge_sha_missing" | "template_build";
    detail: string;
  },
): Promise<void> {
  await runWithJobOrgId(args.orgId, async () => {
    await ctx.eventStore.append({
      runId: args.runId,
      projectId: args.projectId,
      eventType: "deploy.skipped",
      payload: { projectId: args.projectId, reason: args.reason, detail: args.detail },
    });
  });
}

/**
 * Skip deploy-on-merge for a TEMPLATE-CREATION build. Reads the REAL config-driven
 * `templateBuild` marker (never a repo-name heuristic) off the same `projects` row the
 * deploy-target resolver consults, WITHOUT a strict full-config parse so an unrelated
 * config-shape concern can never mask the signal. A template-build project authors a
 * reusable template, not a running product, so no product deploy fires. Returns `true`
 * after recording a DURABLE OBSERVABLE `deploy.skipped` (reason `template_build`) — a
 * LEGITIMATE skip, NOT a failure (no `deploy.failed`, no throw). Returns `false` for a
 * normal product (it deploys on merge as before). A project with no org cannot scope the
 * tenant `events` write — the `log.info` is then the observable record.
 *
 * IDEMPOTENT (the apex-v35 hot-loop fix): the `deploy.skipped` append carries the `runId`,
 * so it fires a `tanren_run` NOTIFY → re-wakes the post-merge subscriber → re-drives
 * `check()` → would re-append the SAME skip on EVERY pass forever (the
 * 1911-events-in-seconds live hot-loop). So this emits the skip AT MOST ONCE per run: if
 * the run already carries a `template_build` `deploy.skipped`, it returns `true` (still a
 * skip — no deploy) WITHOUT re-appending. The `config_incomplete` / `merge_sha_missing`
 * skips throw, so they cannot self-loop; this matches their once-and-observable intent.
 */
export async function skipTemplateBuildDeploy(
  pool: pg.Pool,
  ctx: Pick<DeployVerifyContext, "eventStore">,
  args: { runId: string; projectId: string },
): Promise<boolean> {
  const row = await runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ config: unknown; org_id: string | null }>(
      "SELECT config, org_id FROM projects WHERE project_id = $1",
      [args.projectId],
    );
    return result.rows[0];
  });
  if (row === undefined || !isTemplateBuildProjectConfig(row.config)) return false;
  log.info("merged template-creation build — skipping deploy-on-merge (a template is not a deployed product)", {
    runId: args.runId,
    projectId: args.projectId,
  });
  // A project with no org cannot scope the tenant `events` write — the `log.info` above is
  // the observable record; nothing to append / dedup.
  if (row.org_id === null) return true;
  // IDEMPOTENCY GATE: emit the durable `deploy.skipped` ONCE. A prior `template_build` skip
  // on this run means the timeline already records it — re-appending would only re-fire the
  // `tanren_run` NOTIFY and self-loop the subscriber.
  if (await alreadyTemplateBuildSkipped(pool, args.runId)) return true;
  const detail =
    `project '${args.projectId}' is a template-creation build — it authors a reusable template, not a ` +
    `running product, so no product deploy is triggered on merge (the template carries a deploy verb for the ` +
    `PRODUCTS later built from it)`;
  await appendDeploySkipped(ctx, {
    runId: args.runId,
    projectId: args.projectId,
    orgId: row.org_id,
    reason: "template_build",
    detail,
  });
  return true;
}

/**
 * Whether this run already carries a `template_build` `deploy.skipped` — the idempotency
 * gate that stops the skip self-looping the run-activity bus (each append fires a
 * `tanren_run` NOTIFY that re-wakes the post-merge subscriber). System-scoped so it reads
 * the run's events regardless of the ambient tenant scope. Matches on the JSONB `reason`
 * so an unrelated skip reason (there is none for a template build today, but defensively)
 * never masks a genuine first emit.
 */
async function alreadyTemplateBuildSkipped(pool: pg.Pool, runId: string): Promise<boolean> {
  return runWithSystemScope(pool, async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM events
         WHERE run_id = $1 AND event_type = 'deploy.skipped' AND payload->>'reason' = 'template_build'
         LIMIT 1`,
      [runId],
    );
    return result.rows[0] !== undefined;
  });
}

/**
 * Verify the just-triggered deploy is live, then record `deploy.verified`. Builds the
 * `direct_api` DeployAdapter, polls to READY + smoke-checks the resolved URL (LOUD throw
 * on failure / never-ready / unreachable), and appends the non-secret proof under the
 * org scope. A disappeared grant mid-flight is a hard error, never a skipped verify.
 */
export async function verifyDeploy(
  ctx: DeployVerifyContext,
  args: {
    runId: string;
    projectId: string;
    target: ProjectDeployTarget;
    providerKind: string;
    deploymentId: string;
    grant: OrgGrant | undefined;
  },
): Promise<void> {
  const { target, grant } = args;
  if (grant === undefined) {
    throw new Error(`deployOnMerge: verify lost the org grant for '${target.provider}' on project '${args.projectId}'`);
  }
  const adapter = buildDeployAdapter(DIRECT_API_ADAPTER_KIND, {
    provisioner: { transport: ctx.transport, secrets: ctx.secrets },
    ...(ctx.urlProbe !== undefined && { urlProbe: ctx.urlProbe }),
    ...(ctx.verifyPoll !== undefined && { poll: ctx.verifyPoll }),
  });
  const verification = await adapter.verify(
    grant,
    { provider: args.providerKind, appId: target.appId },
    args.deploymentId,
  );
  await runWithJobOrgId(target.orgId, async () => {
    await ctx.eventStore.append({
      runId: args.runId,
      projectId: args.projectId,
      eventType: "deploy.verified",
      payload: {
        provider: target.provider,
        appId: target.appId,
        deploymentId: args.deploymentId,
        url: verification.url,
        state: verification.state,
        smokeStatus: verification.smokeStatus,
        ...deployAuditEnvelope(target),
      },
    });
  });
}

/**
 * AUDIT-EVIDENCE BASELINE: the audit envelope stamped onto the governing deploy
 * events. Deploy-on-merge is autonomous (no human), so the initiating actor is the
 * SERVICE with no approving actor; the policy version is the project's governance
 * config revision. Shared by trigger + verify so they carry an identical envelope.
 */
export function deployAuditEnvelope(target: ProjectDeployTarget): AuditEnvelope {
  return { policyVersion: target.policyVersion, initiatingActor: serviceAuditActor };
}

/** Derive `owner/name` from a GitHub PR URL (`https://github.com/owner/name/pull/N`). */
export function repoSlugFromPrUrl(prUrl: string): string | undefined {
  const match = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/u.exec(prUrl);
  return match === null ? undefined : `${match[1]}/${match[2]}`;
}

/** The merged commit SHA from a `merge.completed` payload (optional field). */
export function mergeShaFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const sha = (payload as Record<string, unknown>)["mergeSha"];
  return typeof sha === "string" && sha.trim() !== "" ? sha : undefined;
}
