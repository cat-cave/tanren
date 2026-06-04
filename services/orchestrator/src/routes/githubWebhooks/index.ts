// P3-0028 webhook-driven CI (option). GitHub posts `check_run`/`check_suite`/
// `status` events here; we resolve the affected run(s) and advance their CI
// state via an authoritative re-fetch. Polling remains the default fallback,
// so a missed or unconfigured webhook never strands a run. Split out of main.ts
// to keep that file under the 500-line cap.

import { Hono } from "hono";
import type pg from "pg";
import type { ActorContextEnv } from "../../middleware/auth.js";
import type { SecretStore } from "../../engine/contracts/index.js";
import type { VcsProvider } from "../../engine/contracts/vcsProvider.js";
import type { GithubAppTokenMinter } from "../../engine/providers/githubAppTokenMinter.js";
import { CiPullRequestNotFoundError, CiRunNotFoundError } from "../../engine/workflow/ciPolling.js";
import { advanceCiFromWebhook, CiWebhookUnsupportedEventError } from "../../engine/workflow/ciWebhook.js";
import { verifyGithubSignature } from "../../engine/forge/intake/index.js";

// Re-exported so the route mount table imports both webhook receivers from this
// one barrel (keeping the mount file under the per-file dependency cap).
export { createIssueWebhookRoutes, type IssueWebhookRouteDeps } from "./issues.js";
// CI-intelligence ingestion (foundation): the JUnit report ingest receiver.
export { createJunitIngestRoutes, type JunitIngestRouteDeps } from "./junit.js";

export interface GithubWebhookRouteDeps {
  pool: pg.Pool;
  secrets: SecretStore;
  vcsProvider: VcsProvider;
  githubAppMinter?: GithubAppTokenMinter;
  // P-INT-6 / M1: the secret ref for the CI webhook's HMAC signing secret.
  // Verification is MANDATORY — EVERY inbound CI webhook MUST carry a valid
  // `x-hub-signature-256` over the raw body or it is rejected 401 (no
  // unauthenticated CI intake). When this ref is UNSET the receiver has no key to
  // verify against, so it rejects every request 401 (a LOUD refusal — never an
  // unsigned-acceptance fallback). A Tanren-created service hook MUST provision
  // this secret for the receiver to admit anything.
  signingSecretRef?: string;
}

export function createGithubWebhookRoutes(deps: GithubWebhookRouteDeps) {
  const app = new Hono<ActorContextEnv>();

  app.post("/github/webhooks/ci", async (c) => {
    const event = c.req.header("x-github-event") ?? "";
    // Read the RAW body first — the signature is computed over the raw bytes,
    // so we verify before parsing JSON.
    const rawBody = await c.req.text();

    // M1: signature verification is MANDATORY — there is NO unsigned-acceptance
    // path. Resolve the configured secret (an empty/absent secret fails closed in
    // `verifyGithubSignature`), then constant-time compare over the raw body. A
    // missing/invalid signature — OR an unconfigured signing ref — is a 401.
    const secret = deps.signingSecretRef === undefined ? undefined : await deps.secrets.get(deps.signingSecretRef);
    const check = verifyGithubSignature({
      rawBody,
      signatureHeader: c.req.header("x-hub-signature-256"),
      secret: secret?.value ?? "",
    });
    if (!check.ok) return c.json({ error: "signature_rejected", message: check.reason }, 401);

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      payload = undefined;
    }
    if (payload === undefined) {
      return c.json({ error: "invalid_webhook", message: "request body was not JSON" }, 400);
    }
    try {
      const result = await advanceCiFromWebhook({
        pool: deps.pool,
        secrets: deps.secrets,
        vcsProvider: deps.vcsProvider,
        githubAppMinter: deps.githubAppMinter,
        event,
        payload,
      });
      return c.json(result, 200);
    } catch (error) {
      if (error instanceof CiWebhookUnsupportedEventError) {
        return c.json({ error: "unsupported_event", message: error.message }, 202);
      }
      if (error instanceof CiRunNotFoundError || error instanceof CiPullRequestNotFoundError) {
        // The webhook references a PR/run we can't advance; treat as a no-op.
        return c.json({ event, matchedRunIds: [], results: [] }, 200);
      }
      return c.json(
        {
          error: "ci_webhook_failed",
          message: error instanceof Error ? error.message : String(error),
        },
        502,
      );
    }
  });

  return app;
}
