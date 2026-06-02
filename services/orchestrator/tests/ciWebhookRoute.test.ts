// P-INT-6 / M1 — the CI webhook RECEIVER route (`/github/webhooks/ci`) signature
// verification. Verification is MANDATORY: EVERY inbound webhook must carry a
// valid `x-hub-signature-256` over the raw body or it is rejected 401. With NO
// ref configured the receiver has no key to verify against and rejects every
// request 401 — there is no unsigned-acceptance fallback.

import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { createGithubWebhookRoutes } from "../src/routes/githubWebhooks/index.js";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";

const SIGNING_SECRET = "ci-webhook-signing-secret";
const SECRET_REF = "credential/ci-webhook/signing";

// A check_run event with NO pull_requests → resolves to zero PR URLs, so the
// pipeline is a no-op (200) regardless of pool state once the signature passes.
const PAYLOAD = JSON.stringify({ check_run: { name: "build", status: "completed", pull_requests: [] } });

function githubSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

// Minimal pool: every query returns empty (no matching run). Never reached on
// the reject paths.
class EmptyPool {
  async query(): Promise<{ rows: unknown[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }
  asPgPool() {
    return this as never;
  }
}

class NoopGitHubHttp implements GitHubHttpClient {
  async request(_req: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    return { status: 200, body: {} };
  }
}

function buildApp(signingSecretRef?: string) {
  const secrets = new FakeSecretStore();
  return {
    secrets,
    app: createGithubWebhookRoutes({
      pool: new EmptyPool().asPgPool(),
      secrets,
      vcsProvider: vcsProviderOver(new NoopGitHubHttp()),
      ...(signingSecretRef === undefined ? {} : { signingSecretRef }),
    }),
  };
}

async function post(app: ReturnType<typeof buildApp>["app"], headers: Record<string, string>, body: string) {
  return app.request("/github/webhooks/ci", {
    method: "POST",
    headers: { "content-type": "application/json", "x-github-event": "check_run", ...headers },
    body,
  });
}

describe("CI webhook route signature verification (P-INT-6)", () => {
  it("accepts a correctly-signed webhook (200, no-op)", async () => {
    const { app, secrets } = buildApp(SECRET_REF);
    await secrets.put({ ref: SECRET_REF, value: SIGNING_SECRET });
    const res = await post(app, { "x-hub-signature-256": githubSignature(PAYLOAD, SIGNING_SECRET) }, PAYLOAD);
    expect(res.status).toBe(200);
  });

  it("rejects a MISSING signature with 401 (no unauthenticated CI intake)", async () => {
    const { app, secrets } = buildApp(SECRET_REF);
    await secrets.put({ ref: SECRET_REF, value: SIGNING_SECRET });
    const res = await post(app, {}, PAYLOAD);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "signature_rejected" });
  });

  it("rejects an INVALID signature with 401", async () => {
    const { app, secrets } = buildApp(SECRET_REF);
    await secrets.put({ ref: SECRET_REF, value: SIGNING_SECRET });
    const res = await post(app, { "x-hub-signature-256": githubSignature(PAYLOAD, "wrong-secret") }, PAYLOAD);
    expect(res.status).toBe(401);
  });

  it("rejects when the configured secret is absent from the store (fails closed)", async () => {
    // Ref configured but never put into the store.
    const { app } = buildApp(SECRET_REF);
    const res = await post(app, { "x-hub-signature-256": githubSignature(PAYLOAD, SIGNING_SECRET) }, PAYLOAD);
    expect(res.status).toBe(401);
  });

  it("M1: REJECTS every request 401 when no signing ref is configured (no unsigned acceptance)", async () => {
    const { app } = buildApp();
    // Even a body with a plausible-looking signature is rejected: with no
    // configured secret the receiver has no key to verify against and fails
    // closed — there is NO unsigned-acceptance fallback.
    const signed = await post(app, { "x-hub-signature-256": githubSignature(PAYLOAD, SIGNING_SECRET) }, PAYLOAD);
    expect(signed.status).toBe(401);
    const unsigned = await post(app, {}, PAYLOAD);
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ error: "signature_rejected" });
  });

  it("never echoes the signing secret in the rejection body", async () => {
    const { app, secrets } = buildApp(SECRET_REF);
    await secrets.put({ ref: SECRET_REF, value: SIGNING_SECRET });
    const res = await post(app, { "x-hub-signature-256": "sha256=deadbeef" }, PAYLOAD);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(SIGNING_SECRET);
  });
});
