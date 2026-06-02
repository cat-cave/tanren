// P-APP-ENV-1 coverage: propagating a project's TEST-scoped app env to the
// target repo's GitHub Actions secrets. Asserts:
//   - TEST-scoped entries are set as Actions secrets (the right NAMES);
//   - non-test-scoped entries (dev/build/runtime-only) are NOT propagated;
//   - the encryption path is exercised against the REAL GitHubVcsProvider over a
//     scripted transport (a real public key → a real sealed box that DECRYPTS
//     back to the plaintext), and the PLAINTEXT NEVER appears in the request, the
//     log, or the emitted event.
//
// Fakes only (no DB/network): a minimal in-memory app-env pg target + a scripted
// GitHub HTTP transport that captures every request. Both live under tests/.

import { Buffer } from "node:buffer";
import { blake2b } from "blakejs";
import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import type pg from "pg";
import { FakeSecretStore } from "../src/engine/contracts/secretStore.js";
import { GitHubVcsProvider } from "../src/engine/providers/githubVcsProvider.js";
import type { GitHubHttpClient, GitHubHttpRequest, GitHubHttpResponse } from "../src/engine/providers/github.js";
import { AppEnvironmentStore } from "../src/engine/repositories/appEnvironment.js";
import { systemActor } from "../src/engine/state/actor.js";
import { propagateAppEnvToCi, type AppEnvCiPropagatedEvent } from "../src/engine/workflow/propagateAppEnvToCi.js";

const REPO_URL = "https://github.com/cat-cave/appenv-target";
const TEST_SECRET_NAME = "RESEND_API_KEY";
const TEST_SECRET_VALUE = "re_live_PLAINTEXT_must_never_leak";
const DEV_SECRET_VALUE = "dev_PLAINTEXT_never_propagated";

// A real Actions X25519 keypair the scripted transport serves; the secret key
// decrypts captured ciphertext to prove a genuine seal of the plaintext.
const KEY_ID = "appenv-key-1";
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

/** Minimal in-memory app-env pg target (rows only; RLS is covered elsewhere). */
class AppEnvDb {
  readonly rows: Record<string, unknown>[] = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async query(
    rawSql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> {
    const sql = rawSql.replaceAll(/\s+/gu, " ").trim();
    if (/INSERT INTO project_app_env/u.test(sql)) {
      const [id, projectId, key, valueRef, plainValue, scopes, source, description] = params as [
        string,
        string,
        string,
        string | null,
        string | null,
        string[],
        string,
        string,
      ];
      const row = {
        id,
        project_id: projectId,
        key,
        value_ref: valueRef,
        plain_value: plainValue,
        scopes,
        source,
        description,
      };
      this.rows.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (/FROM project_app_env WHERE project_id = \$1/u.test(sql)) {
      const [projectId] = params as [string];
      const rows = this.rows.filter((r) => r["project_id"] === projectId);
      return { rows, rowCount: rows.length };
    }
    throw new Error(`AppEnvDb: unrecognized SQL: ${sql}`);
  }
}

async function seedProject(db: AppEnvDb): Promise<void> {
  const client = db as unknown as Pick<pg.Pool, "query">;
  // A TEST-scoped secret (propagates) — value resolved from the SecretStore.
  await AppEnvironmentStore.upsert(
    client,
    { projectId: "proj", key: TEST_SECRET_NAME, valueRef: "secret://proj/resend", scopes: ["test", "runtime"] },
    systemActor,
  );
  // A TEST-scoped PLAIN value (propagates).
  await AppEnvironmentStore.upsert(
    client,
    { projectId: "proj", key: "PUBLIC_URL", plainValue: "https://app.example", scopes: ["build", "test"] },
    systemActor,
  );
  // A DEV-only secret (must NOT propagate to CI).
  await AppEnvironmentStore.upsert(
    client,
    { projectId: "proj", key: "DEV_ONLY", valueRef: "secret://proj/dev", scopes: ["dev"] },
    systemActor,
  );
}

async function harness(): Promise<{
  http: RecordingGitHubHttp;
  provider: GitHubVcsProvider;
  client: Pick<pg.Pool, "query">;
  secrets: FakeSecretStore;
}> {
  const db = new AppEnvDb();
  await seedProject(db);
  const secrets = new FakeSecretStore();
  await secrets.put({ ref: "secret://proj/resend", value: TEST_SECRET_VALUE });
  await secrets.put({ ref: "secret://proj/dev", value: DEV_SECRET_VALUE });
  const http = new RecordingGitHubHttp();
  return {
    http,
    provider: new GitHubVcsProvider(http),
    client: db as unknown as Pick<pg.Pool, "query">,
    secrets,
  };
}

const TOKEN = { token: "ghp_appenv_test", source: "static" as const, refresh: async () => "ghp_appenv_test" };

describe("propagateAppEnvToCi", () => {
  it("sets the TEST-scoped entries as Actions secrets (the right names) and skips non-test scopes", async () => {
    const { http, provider, client, secrets } = await harness();
    const events: AppEnvCiPropagatedEvent[] = [];

    const result = await propagateAppEnvToCi({
      client,
      secrets,
      vcsProvider: provider,
      repoUrl: REPO_URL,
      projectId: "proj",
      token: TOKEN,
      actor: systemActor,
      emit: (event) => {
        events.push(event);
      },
    });

    // Exactly the two TEST-scoped names — DEV_ONLY (dev-only) is NOT propagated.
    expect(new Set(result.secretNames)).toEqual(new Set([TEST_SECRET_NAME, "PUBLIC_URL"]));
    expect(result.secretNames).not.toContain("DEV_ONLY");
    expect(new Set(http.secretPuts.map((p) => p.name))).toEqual(new Set([TEST_SECRET_NAME, "PUBLIC_URL"]));
    // The dev-only secret value was never even resolved/sent.
    expect(JSON.stringify(http.requests)).not.toContain(DEV_SECRET_VALUE);

    // The names-only event carries the names, never a value.
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("app_env.ci_propagated");
    expect(new Set(events[0]?.secretNames)).toEqual(new Set([TEST_SECRET_NAME, "PUBLIC_URL"]));
    expect(JSON.stringify(events[0])).not.toContain(TEST_SECRET_VALUE);
  });

  it("exercises the encryption path: each secret PUT is a real sealed box that decrypts to the plaintext", async () => {
    const { http, provider, client, secrets } = await harness();
    await propagateAppEnvToCi({
      client,
      secrets,
      vcsProvider: provider,
      repoUrl: REPO_URL,
      projectId: "proj",
      token: TOKEN,
      actor: systemActor,
    });

    const resendPut = http.secretPuts.find((p) => p.name === TEST_SECRET_NAME);
    expect(resendPut).toBeDefined();
    expect(resendPut?.key_id).toBe(KEY_ID);
    expect(resendPut?.encrypted_value.length).toBeGreaterThan(0);
    // The ciphertext is a genuine seal of the plaintext (decrypts back to it)...
    expect(openSealedBox(resendPut?.encrypted_value ?? "")).toBe(TEST_SECRET_VALUE);
  });

  it("NEVER leaks the plaintext anywhere on the wire (request bodies/paths)", async () => {
    const { http, provider, client, secrets } = await harness();
    await propagateAppEnvToCi({
      client,
      secrets,
      vcsProvider: provider,
      repoUrl: REPO_URL,
      projectId: "proj",
      token: TOKEN,
      actor: systemActor,
    });
    // The entire serialized request log must not contain any plaintext secret value.
    const wire = JSON.stringify(http.requests);
    expect(wire).not.toContain(TEST_SECRET_VALUE);
    expect(wire).not.toContain(DEV_SECRET_VALUE);
  });

  it("emits nothing when the project has no test-scoped entries (no-op)", async () => {
    const secrets = new FakeSecretStore();
    const db = new AppEnvDb();
    // Only a dev-scoped entry — nothing to propagate to CI.
    await AppEnvironmentStore.upsert(
      db as unknown as Pick<pg.Pool, "query">,
      { projectId: "proj", key: "DEV_ONLY", plainValue: "x", scopes: ["dev"] },
      systemActor,
    );
    const http = new RecordingGitHubHttp();
    const events: AppEnvCiPropagatedEvent[] = [];
    const result = await propagateAppEnvToCi({
      client: db as unknown as Pick<pg.Pool, "query">,
      secrets,
      vcsProvider: new GitHubVcsProvider(http),
      repoUrl: REPO_URL,
      projectId: "proj",
      token: TOKEN,
      actor: systemActor,
      emit: (event) => {
        events.push(event);
      },
    });
    expect(result.secretNames).toEqual([]);
    expect(http.secretPuts).toEqual([]);
    expect(events).toEqual([]);
  });
});
