// CI-intelligence (PR2) coverage: propagating the CI INGEST secrets (the
// JUnit-upload signing key + the ingest base URL) to the target repo's GitHub
// Actions secrets, so `tanren-ci.yml`'s `upload-junit` step authenticates against
// `POST /webhooks/ci/junit`. Asserts:
//   - exactly TANREN_RUN_TOKEN + TANREN_INGEST_URL are set (the right NAMES);
//   - the encryption path is exercised against the REAL GitHubVcsProvider over a
//     scripted transport (a real public key → a real sealed box that DECRYPTS back
//     to the plaintext): the signing key decrypts to the secret VALUE, the URL to
//     the public base — and the signing-key PLAINTEXT NEVER appears on the wire/log;
//   - LOUD on misconfig: an unset signing ref, an absent secret, or an empty
//     public base URL throws (never a quiet skip / never an empty propagation).
//
// Fakes only (no DB/network): a scripted GitHub HTTP transport. It lives under tests/.

import { Buffer } from "node:buffer";
import { blake2b } from "blakejs";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { GitHubVcsProvider } from "../src/engine/providers/githubVcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import {
  CiIngestSecretMissingError,
  propagateCiIngestSecrets,
} from "../src/engine/workflow/propagateCiIngestSecrets.js";

const REPO_URL = "https://github.com/cat-cave/ci-ingest-target";
const SIGNING_REF = "secret://proj/ci-webhook-signing";
const SIGNING_VALUE = "ci_signing_PLAINTEXT_must_never_leak";
const PUBLIC_BASE = "https://tanren.example";
const TOKEN = { token: "ghp_ci_ingest_test", source: "static" as const, refresh: async () => "ghp_ci_ingest_test" };

// A real Actions X25519 keypair the scripted transport serves; the secret key
// decrypts captured ciphertext to prove a genuine seal of the plaintext.
const KEY_ID = "ci-ingest-key-1";
const keyPair = nacl.box.keyPair();
const publicKeyB64 = Buffer.from(keyPair.publicKey).toString("base64");

function openSealedBox(sealedB64: string): string | null {
  const sealed = new Uint8Array(Buffer.from(sealedB64, "base64"));
  const ephPk = sealed.subarray(0, nacl.box.publicKeyLength);
  const boxed = sealed.subarray(nacl.box.publicKeyLength);
  const nonceInput = new Uint8Array(ephPk.length + keyPair.publicKey.length);
  nonceInput.set(ephPk, 0);
  nonceInput.set(keyPair.publicKey, ephPk.length);
  const nonce = blake2b(nonceInput, undefined, nacl.box.nonceLength);
  const opened = nacl.box.open(boxed, nonce, ephPk, keyPair.secretKey);
  return opened === null ? null : Buffer.from(opened).toString("utf8");
}

/** Scripted GitHub transport: serves the Actions public key + records every PUT. */
class RecordingGitHubHttp implements GitHubHttpClient {
  readonly requests: GitHubHttpRequest[] = [];
  readonly secretPuts: Array<{ name: string; encrypted_value: string; key_id: string }> = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async request(input: GitHubHttpRequest): Promise<GitHubHttpResponse> {
    this.requests.push(input);
    const path = input.path.split("?")[0] ?? input.path;
    if (input.method === "GET" && path.endsWith("/actions/secrets/public-key")) {
      return { status: 200, body: { key_id: KEY_ID, key: publicKeyB64 } };
    }
    const putMatch = /\/actions\/secrets\/([^/]+)$/u.exec(path);
    if (input.method === "PUT" && putMatch !== null) {
      const body = input.body as { encrypted_value?: unknown; key_id?: unknown };
      this.secretPuts.push({
        name: decodeURIComponent(putMatch[1] ?? ""),
        encrypted_value: String(body.encrypted_value),
        key_id: String(body.key_id),
      });
      return { status: 201, body: {} };
    }
    throw new Error(`unexpected GitHub request: ${input.method} ${input.path}`);
  }
}

async function harness(): Promise<{
  http: RecordingGitHubHttp;
  provider: GitHubVcsProvider;
  secrets: FakeSecretStore;
}> {
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: SIGNING_REF, value: SIGNING_VALUE });
  const http = new RecordingGitHubHttp();
  return { http, provider: new GitHubVcsProvider(http), secrets };
}

describe("propagateCiIngestSecrets", () => {
  it("sets exactly the two repo-level CI ingest Actions secrets (the right names)", async () => {
    const { http, provider, secrets } = await harness();

    const result = await propagateCiIngestSecrets({
      secrets,
      vcsProvider: provider,
      repoUrl: REPO_URL,
      token: TOKEN,
      signingSecretRef: SIGNING_REF,
      publicBaseUrl: PUBLIC_BASE,
    });

    expect(new Set(result.secretNames)).toEqual(new Set(["TANREN_RUN_TOKEN", "TANREN_INGEST_URL"]));
    expect(new Set(http.secretPuts.map((p) => p.name))).toEqual(new Set(["TANREN_RUN_TOKEN", "TANREN_INGEST_URL"]));
    // The result surfaces NAMES only — never the signing value.
    expect(JSON.stringify(result)).not.toContain(SIGNING_VALUE);
  });

  it("encryption path: TANREN_RUN_TOKEN decrypts to the signing key, TANREN_INGEST_URL to the base URL", async () => {
    const { http, provider, secrets } = await harness();
    await propagateCiIngestSecrets({
      secrets,
      vcsProvider: provider,
      repoUrl: REPO_URL,
      token: TOKEN,
      signingSecretRef: SIGNING_REF,
      // A trailing slash on the base must be normalized off before it is set.
      publicBaseUrl: `${PUBLIC_BASE}/`,
    });

    const tokenPut = http.secretPuts.find((p) => p.name === "TANREN_RUN_TOKEN");
    expect(tokenPut?.key_id).toBe(KEY_ID);
    expect(openSealedBox(tokenPut?.encrypted_value ?? "")).toBe(SIGNING_VALUE);

    const urlPut = http.secretPuts.find((p) => p.name === "TANREN_INGEST_URL");
    // Trailing slash normalized off — the runner appends `/webhooks/ci/junit`.
    expect(openSealedBox(urlPut?.encrypted_value ?? "")).toBe(PUBLIC_BASE);
  });

  it("NEVER leaks the signing-key plaintext on the wire (request bodies/paths)", async () => {
    const { http, provider, secrets } = await harness();
    await propagateCiIngestSecrets({
      secrets,
      vcsProvider: provider,
      repoUrl: REPO_URL,
      token: TOKEN,
      signingSecretRef: SIGNING_REF,
      publicBaseUrl: PUBLIC_BASE,
    });
    expect(JSON.stringify(http.requests)).not.toContain(SIGNING_VALUE);
  });

  it("LOUD: an unset signing ref throws (never an empty propagation)", async () => {
    const { provider, secrets } = await harness();
    await expect(
      propagateCiIngestSecrets({
        secrets,
        vcsProvider: provider,
        repoUrl: REPO_URL,
        token: TOKEN,
        signingSecretRef: "",
        publicBaseUrl: PUBLIC_BASE,
      }),
    ).rejects.toBeInstanceOf(CiIngestSecretMissingError);
  });

  it("LOUD: an empty public base URL throws", async () => {
    const { provider, secrets } = await harness();
    await expect(
      propagateCiIngestSecrets({
        secrets,
        vcsProvider: provider,
        repoUrl: REPO_URL,
        token: TOKEN,
        signingSecretRef: SIGNING_REF,
        publicBaseUrl: "/",
      }),
    ).rejects.toBeInstanceOf(CiIngestSecretMissingError);
  });

  it("LOUD: a configured-but-absent signing secret throws (never a quiet skip)", async () => {
    const http = new RecordingGitHubHttp();
    await expect(
      propagateCiIngestSecrets({
        // The ref is configured below, but the secret is NOT stored in the store.
        secrets: new FakeSecretStore(),
        vcsProvider: new GitHubVcsProvider(http),
        repoUrl: REPO_URL,
        token: TOKEN,
        signingSecretRef: SIGNING_REF,
        publicBaseUrl: PUBLIC_BASE,
      }),
    ).rejects.toBeInstanceOf(CiIngestSecretMissingError);
    // Nothing was set — the failure is before any PUT.
    expect(http.secretPuts).toEqual([]);
  });
});
