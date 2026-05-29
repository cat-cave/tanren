// P3-0003: GitHub App credential kind. Unlike `github_token` (a single static
// PAT/installation token), a GitHub App credential is the App's identity: its
// numeric App id plus the RSA private key (PEM) used to sign the short-lived
// app JWT. Installation tokens are minted on demand from these (see
// `githubAppTokenMinter.ts`) and are NEVER persisted.
//
// Both fields live in Vault under a single `credential/github_app/...` ref as a
// JSON envelope so we keep one secret per App. The App id is not itself a
// secret, but the private key is — so the whole envelope is write-only and is
// never returned by the credential routes.

import type { SecretStore } from "../contracts/secretStore.js";
import { validateCredentialRef } from "./codexAuth.js";

export const githubAppKind = "github_app";

export interface GithubAppCredential {
  appId: string;
  privateKeyPem: string;
}

export interface GithubAppImportResult {
  credentialKind: typeof githubAppKind;
  ref: string;
  appId: string;
  redacted: true;
}

interface StoredGithubAppEnvelope {
  appId: string;
  privateKeyPem: string;
}

export async function storeGithubAppCredential(
  secrets: SecretStore,
  input: { ref: string; appId: string; privateKeyPem: string },
): Promise<GithubAppImportResult> {
  const ref = validateGithubAppCredentialRef(input.ref);
  const credential = validateGithubAppCredential({
    appId: input.appId,
    privateKeyPem: input.privateKeyPem,
  });
  const envelope: StoredGithubAppEnvelope = {
    appId: credential.appId,
    privateKeyPem: credential.privateKeyPem,
  };
  await secrets.put({ ref, value: JSON.stringify(envelope) });
  return { credentialKind: githubAppKind, ref, appId: credential.appId, redacted: true };
}

export async function loadGithubAppCredential(secrets: SecretStore, ref: string): Promise<GithubAppCredential> {
  const validated = validateGithubAppCredentialRef(ref);
  const secret = await secrets.get(validated);
  if (secret === undefined) {
    throw new Error(`missing GitHub App credential ref: ${validated}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret.value) as unknown;
  } catch {
    throw new Error("GitHub App credential envelope must be valid JSON");
  }
  return validateGithubAppCredential(parsed);
}

export function validateGithubAppCredentialRef(ref: string): string {
  const validated = validateCredentialRef(ref);
  if (!validated.startsWith("credential/github_app/")) {
    throw new Error("GitHub App credential ref must start with credential/github_app/");
  }
  return validated;
}

export function validateGithubAppCredential(value: unknown): GithubAppCredential {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub App credential must be an object");
  }
  const object = value as Record<string, unknown>;
  const appId = typeof object["appId"] === "string" ? object["appId"].trim() : "";
  if (!/^[0-9]+$/.test(appId)) {
    throw new Error("GitHub App id must be a numeric string");
  }
  const privateKeyPem = typeof object["privateKeyPem"] === "string" ? object["privateKeyPem"] : "";
  if (!privateKeyPem.includes("-----BEGIN") || !privateKeyPem.includes("PRIVATE KEY-----")) {
    throw new Error("GitHub App private key must be a PEM-encoded private key");
  }
  return { appId, privateKeyPem };
}
