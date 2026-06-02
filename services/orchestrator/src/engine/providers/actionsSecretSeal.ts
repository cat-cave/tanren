// P-APP-ENV-1: the GitHub Actions repository-secret SET flow (read public key →
// sealed-box encrypt → PUT), extracted from `githubVcsProvider.ts` so the provider
// stays under the per-file line cap. The encryption is the `crypto_box_seal`
// construction GitHub documents for `PUT /repos/{o}/{r}/actions/secrets/{name}`,
// implemented over `tweetnacl` (X25519 box) + `blakejs` (the BLAKE2b nonce).

import { Buffer } from "node:buffer";
import { blake2b } from "blakejs";
import nacl from "tweetnacl";
import type { GitHubHttpClient } from "./github.js";
import type { SetActionsSecretInput } from "../contracts/vcsProvider.js";

function repoActionsPath(owner: string, name: string, suffix: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions${suffix}`;
}

/**
 * Encrypt an Actions-secret plaintext for a repo's Actions public key using a
 * libsodium SEALED BOX. Per the libsodium spec: generate an ephemeral X25519
 * keypair, derive a 24-byte nonce = BLAKE2b(ephemeral_pk ‖ recipient_pk), seal
 * the message with `crypto_box` under (recipient_pk, ephemeral_sk), and prepend
 * the ephemeral_pk. `publicKeyBase64` is the `key` from
 * `GET .../actions/secrets/public-key`; the result is the base64 `encrypted_value`
 * the PUT body carries.
 *
 * SECURITY: the plaintext lives only as a local buffer here and is never
 * logged/returned beyond the sealed ciphertext; the ephemeral secret key is
 * zeroed after use (the seal is single-use).
 */
export function sealActionsSecret(publicKeyBase64: string, plaintext: string): string {
  const recipientPk = new Uint8Array(Buffer.from(publicKeyBase64, "base64"));
  const message = new Uint8Array(Buffer.from(plaintext, "utf8"));
  const ephemeral = nacl.box.keyPair();
  const nonceInput = new Uint8Array(ephemeral.publicKey.length + recipientPk.length);
  nonceInput.set(ephemeral.publicKey, 0);
  nonceInput.set(recipientPk, ephemeral.publicKey.length);
  const nonce = blake2b(nonceInput, undefined, nacl.box.nonceLength);
  const boxed = nacl.box(message, nonce, recipientPk, ephemeral.secretKey);
  ephemeral.secretKey.fill(0);
  const sealed = new Uint8Array(ephemeral.publicKey.length + boxed.length);
  sealed.set(ephemeral.publicKey, 0);
  sealed.set(boxed, ephemeral.publicKey.length);
  return Buffer.from(sealed).toString("base64");
}

/**
 * Set (create/overwrite) one GitHub Actions repository secret: read the repo's
 * Actions public key, sealed-box-encrypt the PLAINTEXT value against it, and PUT
 * the encrypted value + its `key_id`. The plaintext is transmitted ONLY inside the
 * encrypted PUT body — never logged, returned, or placed in an event. Idempotent
 * (GitHub returns 201 on create, 204 on overwrite).
 */
export async function setRepoActionsSecret(http: GitHubHttpClient, input: SetActionsSecretInput): Promise<void> {
  // 1. Read the repo's Actions public key (`key` is base64; `key_id` names it).
  const keyResponse = await http.request({
    method: "GET",
    path: repoActionsPath(input.repo.owner, input.repo.name, "/secrets/public-key"),
    token: input.token.token,
    refreshToken: input.token.refresh,
  });
  if (keyResponse.status !== 200 || typeof keyResponse.body !== "object" || keyResponse.body === null) {
    throw new Error(`GitHub Actions public-key read failed: HTTP ${keyResponse.status}`);
  }
  const keyBody = keyResponse.body as { key?: unknown; key_id?: unknown };
  if (typeof keyBody.key !== "string" || typeof keyBody.key_id !== "string") {
    throw new TypeError("GitHub Actions public-key response missing key/key_id");
  }

  // 2. Encrypt the PLAINTEXT with a sealed-box against that key. `encrypted_value`
  //    is the ONLY place the plaintext travels — sealed to the repo's public key.
  const encryptedValue = sealActionsSecret(keyBody.key, input.value);

  // 3. PUT the encrypted secret under its name (201 created / 204 updated).
  const putResponse = await http.request({
    method: "PUT",
    path: repoActionsPath(input.repo.owner, input.repo.name, `/secrets/${encodeURIComponent(input.name)}`),
    token: input.token.token,
    refreshToken: input.token.refresh,
    body: { encrypted_value: encryptedValue, key_id: keyBody.key_id },
  });
  if (putResponse.status !== 201 && putResponse.status !== 204) {
    // The name is non-secret; the plaintext value is NOT included in the message.
    throw new Error(`GitHub Actions secret '${input.name}' set failed: HTTP ${putResponse.status}`);
  }
}
