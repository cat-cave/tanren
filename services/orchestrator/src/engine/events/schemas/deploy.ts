import { z } from "zod";
import { AuditEnvelope } from "./audit.js";

// Deploy-on-merge event schema, split out of schemas/integrations.ts to keep each
// file under the 500-line cap.

// DeployArtifact — the audit-evidence doctrine requires that where a deploy
// produces an artifact, the event records its CHECKSUM + PROVENANCE (never the
// artifact contents, never a secret). For a `direct_api` deploy the provider builds
// the artifact server-side and exposes a content digest + a build/deployment handle
// the digest derives from; this records those NON-SECRET references so an auditor can
// tie the deployed surface back to the exact artifact a provenance attestation would
// cover. Optional fields: a provider that exposes no digest yet records the
// provenance ref alone — an honest partial, never a fabricated hash.
export const DeployArtifact = z
  .object({
    /** The content checksum of the built artifact, `<algo>:<hex>` (e.g. `sha256:...`). NEVER the contents. */
    checksum: z.string().min(1).optional(),
    /**
     * The provenance reference the artifact derives from — the non-secret build /
     * image / deployment handle a provenance attestation is keyed on (e.g. the
     * image ref or the provider build id). NEVER a token or a signed-URL secret.
     */
    provenanceRef: z.string().min(1),
  })
  .strict();
export type DeployArtifact = z.infer<typeof DeployArtifact>;

// Deploy-on-merge ("a deploy happened"): a run's merge triggered a real build +
// release of the merged commit onto the project's deploy app (Vercel/Fly). The
// payload is the observable proof a deploy actually fired — the deploy target
// (provider + app id), the merged source (repo + git ref), the provider's
// deployment id, the resolved live URL, and the reported state. SECURITY: every
// field is non-secret (a URL + ids + a repo slug); the deploy token + the runtime
// env VALUES went only into the provider requests and never into this event.
export const DeployTriggeredPayload = z
  .object({
    /** The deploy provider kind (`deploy.vercel` | `deploy.flyio`). */
    provider: z.string(),
    /** The deployed app/project id the release ran onto. */
    appId: z.string(),
    /** The merged repo, `owner/name`, the deploy was built from. */
    repo: z.string(),
    /** The git ref (branch/sha) the provider built + released. */
    ref: z.string(),
    /** The provider's deployment handle (Vercel deployment id / Fly machine id). */
    deploymentId: z.string(),
    /** The resolved live URL the deployment is reachable at (concrete, no placeholder). */
    url: z.string(),
    /** The deployment state the provider reported (e.g. "QUEUED" | "READY" | "started"). */
    state: z.string(),
    /**
     * The artifact the deploy released — its checksum + provenance ref (non-secret).
     * Optional: a provider that exposes no artifact digest at trigger time records no
     * artifact (an honest absence), never a placeholder. See {@link DeployArtifact}.
     */
    artifact: DeployArtifact.optional(),
  })
  // AUDIT ENVELOPE: a deploy is a governing delivery action — it carries the
  // governance policy version + the actor who drove it (the autonomous service on
  // deploy-on-merge). Flat-merged onto the payload.
  .extend(AuditEnvelope.shape)
  .strict();

// Deploy VERIFIED ("the deploy is PROVEN live"): after `deploy.triggered`, the
// DeployAdapter polled the provider until the deployment reached a READY terminal
// and the resolved URL answered an HTTP smoke check. This is the proof a deploy
// actually became reachable — not merely queued. SECURITY: every field is
// non-secret (provider + app id + a URL + a state + an HTTP status); the deploy
// token + runtime env values went only into the provider requests, never here.
export const DeployVerifiedPayload = z
  .object({
    /** The deploy provider kind (`deploy.vercel` | `deploy.flyio`). */
    provider: z.string(),
    /** The deployed app/project id the release ran onto. */
    appId: z.string(),
    /** The provider's deployment handle the verify polled (Vercel deployment id / Fly machine id). */
    deploymentId: z.string(),
    /** The resolved live URL the deployment is reachable at (concrete, no placeholder). */
    url: z.string(),
    /** The provider's final READY state (e.g. "READY" | "started"). */
    state: z.string(),
    /** The HTTP status the URL smoke check observed (the deployment answered). */
    smokeStatus: z.number().int(),
  })
  // AUDIT ENVELOPE: the verify is the proof step of the same governing deploy
  // action — it carries the same policy version + initiating actor.
  .extend(AuditEnvelope.shape)
  .strict();

// Deploy FAILED ("the deploy could NOT be proven live"): a deploy that WAS expected
// (a deploy target resolved on merge) did not materialize a verified live URL. Two
// phases reach here, both LOUD + durable so the operator KNOWS the product never came
// up (vs the run silently looking "done" with no live URL):
//   • `verify`  — the deploy TRIGGERED but poll-to-READY + URL smoke check failed on
//     EVERY attempt of the bounded in-process retry (the `deploymentId` is the
//     released-but-unproven deployment).
//   • `trigger` — the deploy could NOT even be triggered/attached (incomplete config,
//     a missing/lost grant, a denied egress target, or the provider build/release
//     itself failing). No deployment exists yet, so `deploymentId` is honestly ABSENT.
// SECURITY: non-secret (provider + ids + a phase + an attempt count + a non-secret
// reason); the deploy token + env values never reach here.
export const DeployFailedPayload = z
  .object({
    /** The deploy provider kind (`deploy.vercel` | `deploy.flyio`). */
    provider: z.string(),
    /** The deployed app/project id the release ran onto. */
    appId: z.string(),
    /**
     * Where the deploy failed: `verify` (triggered but never proven live) or
     * `trigger` (could not be triggered/attached at all). Drives whether a
     * `deploymentId` exists.
     */
    phase: z.enum(["trigger", "verify"]),
    /**
     * The provider's deployment handle the verify polled. Present only on a `verify`
     * failure (a `trigger` failure never reached a deployment, so it is absent — an
     * honest absence, never a placeholder).
     */
    deploymentId: z.string().optional(),
    /**
     * How many verification attempts were made before giving up (the bounded retry).
     * Present only on a `verify` failure; absent on a `trigger` failure (no verify ran).
     */
    attempts: z.number().int().positive().optional(),
    /**
     * A FIXED, non-secret failure summary — NOT the raw error (which can embed
     * provider-supplied HTTP response text). The full error is preserved in the run
     * logs via the re-throw; only this bounded summary reaches the audit event.
     */
    reason: z.string(),
  })
  .extend(AuditEnvelope.shape)
  .strict();
export type DeployFailedPayload = z.infer<typeof DeployFailedPayload>;

// Deploy SKIPPED ("an expected deploy could not even be RESOLVED"): a PRE-resolution
// failure on merge that occurs BEFORE a deploy target is known — so it cannot be a
// `deploy.failed` (which requires a resolved provider + appId). Both reasons reach here
// DURABLE so the operator + the run timeline SEE the skip instead of a console-only log
// line that leaves the merge looking "done" with no deploy:
//   • `config_incomplete` — the org links a deploy integration (a deploy is EXPECTED) but
//     the project config has no complete deploy target (no provider/appId to deploy onto).
//   • `merge_sha_missing` — the `merge.completed` carried no mergeSha, so there is no
//     merged commit to deploy (a merge-wiring bug).
// SECURITY: non-secret (a project id + a fixed reason code + a bounded detail string).
export const DeploySkippedPayload = z
  .object({
    /** The project whose merge could not resolve a deploy. */
    projectId: z.string().min(1),
    /** Why the deploy could not be resolved (fixed reason code, drives operator triage). */
    reason: z.enum(["config_incomplete", "merge_sha_missing"]),
    /** A bounded, non-secret detail string (the resolution reason / wiring detail). */
    detail: z.string(),
  })
  .strict();
export type DeploySkippedPayload = z.infer<typeof DeploySkippedPayload>;
