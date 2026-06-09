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
  input: { ref: string; token: string },
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
  if (/\s/u.test(trimmed)) {
    throw new Error("GitHub token must not contain whitespace");
  }
  return trimmed;
}

export function redactedGithubTokenResult(ref: string): GithubTokenImportResult {
  return { credentialKind: githubTokenKind, ref, redacted: true };
}

/**
 * Normalize a configured/run-resolved GitHub credential ref into EITHER a
 * grammar-validated static ref OR `undefined` ("no static ref"). This is the
 * App-FIRST seam: a run on an App-installed org resolves the EMPTY-STRING App
 * sentinel for `githubCredentialRef` (the static ref is absent — the run mints
 * an installation token instead), and a public-repo run carries no ref at all.
 * Both are the SAME "no static ref" state and MUST collapse to `undefined`,
 * never be pushed through {@link validateGithubCredentialRef} — doing so threw
 * the cryptic `credential ref has an invalid format: ""` mid-run (apex v30: an
 * App-installed BYOK run, where the App sentinel `""` reached the PR-publish /
 * review-merge token resolution as an empty-but-present string). A NON-empty ref
 * is grammar-validated as before (a malformed static ref still fails loud — this
 * is not a silent fallback, it is the explicit no-static-ref state). */
export function normalizeStaticGithubRef(ref: string | undefined): string | undefined {
  if (typeof ref !== "string" || ref.trim() === "") {
    return undefined;
  }
  return validateGithubCredentialRef(ref);
}
