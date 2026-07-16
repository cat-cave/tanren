// Collaborators for the deploy-on-merge watcher, split out of `deployOnMerge.ts` to keep
// that module under the 500-line cap: the verify + LOUD `deploy.failed`/`deploy.verified`
// appenders (the durable-failure recording the watcher composes), plus the small pure
// mappings (deploy audit envelope, repo slug from a PR URL, merged SHA from a
// `merge.completed` payload).

import { runWithJobOrgId } from "@tanren/db";
import { serviceAuditActor, type AuditEnvelope } from "../events/schemas/audit.js";
import type { EventStore } from "../eventStore.js";
import type { SecretStore } from "../contracts/secretStore.js";
import type { DeployHttpTransport } from "../provisioners/deployTransport.js";
import type { OrgGrant } from "../contracts/integrationProvisioner.js";
import { buildDeployAdapter } from "../deploy/buildDeployAdapter.js";
import { DIRECT_API_ADAPTER_KIND } from "../deploy/directApiDeployAdapter.js";
import type { UrlReachabilityProbe, VerifyPollPolicy } from "../contracts/deployAdapter.js";
import type { ProjectDeployTarget } from "./deployOnMerge.js";
import { retryUntilConverged } from "../workflow/retryUntilConverged.js";
import { fixedPointRuleJudgment } from "../workflow/convergenceDetector.js";
import { createLogger } from "../observability/logger.js";

// Structured logger for the deploy-verify convergence loop's per-iteration `*.retrying`
// observability (Codex critic #13). The wrapping helper's own failures + successes fire
// their own events (`deploy.failed`, `deploy.verified`); the retry observability is a
// per-attempt breadcrumb that lets an operator SEE the verify loop spinning between
// those terminals.
const deployVerifyLog = createLogger("deploy-verify-retry");

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
      orgId: args.target.orgId,
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
 * detail). Both reasons (config_incomplete / merge_sha_missing) are emitted BEFORE
 * the watcher fails LOUD — recorded here so the skip is observable.
 */
export async function appendDeploySkipped(
  ctx: Pick<DeployVerifyContext, "eventStore">,
  args: {
    runId: string;
    projectId: string;
    orgId: string;
    reason: "config_incomplete" | "merge_sha_missing";
    detail: string;
  },
): Promise<void> {
  await runWithJobOrgId(args.orgId, async () => {
    await ctx.eventStore.append({
      runId: args.runId,
      projectId: args.projectId,
      orgId: args.orgId,
      eventType: "deploy.skipped",
      payload: { projectId: args.projectId, reason: args.reason, detail: args.detail },
    });
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
    loadGrant: () => Promise<OrgGrant | undefined>;
  },
): Promise<void> {
  const { target } = args;
  const adapter = buildDeployAdapter(DIRECT_API_ADAPTER_KIND, {
    provisioner: { transport: ctx.transport, secrets: ctx.secrets },
    ...(ctx.urlProbe !== undefined && { urlProbe: ctx.urlProbe }),
    ...(ctx.verifyPoll !== undefined && { poll: ctx.verifyPoll }),
  });
  const verification = await adapter.verify(
    async () => {
      const grant = await args.loadGrant();
      if (grant === undefined) {
        throw new Error(
          `deployOnMerge: verify lost the org grant for '${target.provider}' on project '${args.projectId}'`,
        );
      }
      return grant;
    },
    { provider: args.providerKind, appId: target.appId },
    args.deploymentId,
  );
  await runWithJobOrgId(target.orgId, async () => {
    await ctx.eventStore.append({
      runId: args.runId,
      projectId: args.projectId,
      orgId: target.orgId,
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
 * Verify with a PROGRESS-BASED in-process RETRY (feedback_no_timeouts_progress_based) — NO
 * 3-strikes, NO attempt cap. Each attempt re-runs {@link verifyDeploy} (itself an UNBOUNDED
 * poll-to-READY that throws LOUD on a provider ERROR terminal / a proven stuck-deploy). This
 * outer loop recovers a TRANSIENT verify failure: while the verify error's identity keeps
 * CHANGING (a transient resolving into a different failure) that is PROGRESS → retry,
 * unbounded; it escalates ONLY at an intelligent non-convergence fixed point (the SAME verify
 * error recurring with no new information — a genuine provider failure). On escalation it
 * records the LOUD verify-phase `deploy.failed`, sets `recorded.verifyPhase` (so the watcher's
 * outer guard skips a duplicate trigger-phase append), and re-throws — never leaving the run
 * silently triggered-but-unverified. A merged run is terminal (no later wake), so this
 * resolves within the one `check()` call. `loadGrant` re-resolves the org grant per attempt.
 */
export async function verifyDeployUntilConverged(
  ctx: DeployVerifyContext,
  args: {
    runId: string;
    projectId: string;
    target: ProjectDeployTarget;
    providerKind: string;
    deploymentId: string;
    recorded: { verifyPhase: boolean };
  },
  loadGrant: () => Promise<OrgGrant | undefined>,
): Promise<void> {
  const { runId, projectId, target, providerKind, deploymentId, recorded } = args;
  let attempts = 0;
  let lastError: unknown;
  const outcome = await retryUntilConverged<boolean>({
    attempt: async () => {
      attempts += 1;
      try {
        await verifyDeploy(ctx, { runId, projectId, target, providerKind, deploymentId, loadGrant });
        return { result: true, signature: { failureSignature: "verified" }, done: true };
      } catch (error) {
        lastError = error;
        // The verify error's stable identity IS the convergence signature: a CHANGING error
        // (a transient resolving into a different failure) is progress → retry, unbounded;
        // the SAME error recurring is the fixed point that escalates.
        return { result: false, signature: { failureSignature: verifyErrorSignature(error) }, done: false };
      }
    },
    // No agent at this DB-driven escalation point — the rigorous fixed-point rule stands in:
    // escalate ONLY at a proven identical-error recurrence, with a human-actionable diagnosis.
    judge: (history) =>
      fixedPointRuleJudgment(
        history,
        () =>
          `deploy verify did not converge for '${target.provider}/${target.appId}' deployment ` +
          `'${deploymentId}': the same verify failure recurred with no new information after ` +
          `${String(attempts)} attempts — ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      ),
    // Codex critic #13 — per-iteration observability. Emit a `deploy.verify.retrying`
    // structured log per attempt so an operator can see the verify convergence loop
    // spinning between the terminal `deploy.verified` / `deploy.failed` events. The
    // decision (`done` / `progress` / `escalate`) tells the operator whether the loop
    // is progressing (a transient verify blip that resolved), still working, or has
    // just proven the fixed point. `retryUntilConverged` itself stays silent — this
    // primitive is opt-in per caller.
    onAttempt: (info) => {
      deployVerifyLog.info("deploy.verify.retrying", {
        runId,
        projectId,
        provider: target.provider,
        appId: target.appId,
        deploymentId,
        attempt: info.attempt,
        decision: info.decision,
        failureSignature: info.signature.failureSignature,
      });
    },
  });
  if (outcome.kind === "done") return;
  await appendDeployFailed(ctx, { runId, projectId, target, phase: "verify", deploymentId, attempts });
  // Signal the watcher's outer `check()` guard that a verify-phase `deploy.failed` is already
  // recorded, so it does not append a duplicate trigger-phase one for this same throw.
  recorded.verifyPhase = true;
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Distill a verify error into a STABLE convergence signature — the error's identity, NOT its
 * incidental wording. Keyed on the error class + the message stem (quoted ids + digit runs that
 * vary attempt-to-attempt are stripped), so the SAME underlying verify failure reads as
 * identical across re-drives (→ a fixed point), while a genuinely DIFFERENT failure reads as
 * progress (→ retry, unbounded). A non-Error throw keys on its stringification.
 */
function verifyErrorSignature(error: unknown): string {
  if (!(error instanceof Error)) return `non-error:${String(error)}`;
  const stem = error.message
    .replaceAll(/'[^']*'/gu, "''")
    .replaceAll(/\d+/gu, "N")
    .trim();
  return `${error.name}:${stem}`;
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
