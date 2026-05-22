import type { SecretStore } from "../contracts/secretStore.js";
import { validateCredentialRef } from "./codexAuth.js";

export const githubTokenKind = "github_token";

export interface GithubTokenImportResult {
  credentialKind: typeof githubTokenKind;
  ref: string;
  redacted: true;
}

export async function storeGithubToken(
  secrets: SecretStore,
  input: { ref: string; token: string }
): Promise<GithubTokenImportResult> {
  const ref = validateGithubCredentialRef(input.ref);
  const token = validateGithubToken(input.token);
  await secrets.put({ ref, value: token });
  return redactedGithubTokenResult(ref);
}

export function validateGithubCredentialRef(ref: string): string {
  const validated = validateCredentialRef(ref);
  if (!validated.startsWith("credential/github/")) {
    throw new Error("GitHub credential ref must start with credential/github/");
  }
  return validated;
}

export function validateGithubToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed === "") {
    throw new Error("GitHub token must not be empty");
  }
  if (/\s/.test(trimmed)) {
    throw new Error("GitHub token must not contain whitespace");
  }
  return trimmed;
}

export function redactedGithubTokenResult(ref: string): GithubTokenImportResult {
  return { credentialKind: githubTokenKind, ref, redacted: true };
}
