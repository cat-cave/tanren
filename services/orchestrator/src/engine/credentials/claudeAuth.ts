import type { SecretStore } from "../contracts/secretStore.js";
import { validateCredentialRef } from "./codexAuth.js";

// Claude CLI credential bundle. Mirrors the Codex auth contract — the
// stored secret is the JSON the Claude CLI persists for an authenticated
// session (its `.credentials.json` token bundle). We validate it is a non-empty
// JSON object carrying a recognizable token field, but never inspect or log the
// token values themselves.
export const claudeAuthKind = "claude_cli_auth";

export interface ClaudeAuthBundle {
  authJson: string;
}

export interface ClaudeAuthImportResult {
  credentialKind: typeof claudeAuthKind;
  ref: string;
  redacted: true;
}

export async function storeClaudeAuthBundle(
  secrets: SecretStore,
  input: { ref: string; authJson: string },
): Promise<ClaudeAuthImportResult> {
  const ref = validateClaudeCredentialRef(input.ref);
  const bundle = validateClaudeAuthBundle(input.authJson);
  await secrets.put({ ref, value: bundle.authJson });
  return redactedClaudeAuthResult(ref);
}

export function validateClaudeAuthBundle(authJson: string): ClaudeAuthBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson) as unknown;
  } catch {
    throw new Error("Claude auth bundle must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Claude auth bundle must be a JSON object");
  }
  const parsedObject = parsed as Record<string, unknown>;
  if (Object.keys(parsedObject).length === 0) {
    throw new Error("Claude auth bundle must not be empty");
  }
  if (!looksLikeClaudeAuthJson(parsedObject)) {
    throw new Error("Claude auth bundle must include Claude CLI token fields");
  }
  return { authJson: JSON.stringify(parsedObject) };
}

export function redactedClaudeAuthResult(ref: string): ClaudeAuthImportResult {
  return { credentialKind: claudeAuthKind, ref, redacted: true };
}

export function validateClaudeCredentialRef(ref: string): string {
  const validated = validateCredentialRef(ref);
  if (!validated.startsWith("credential/claude/")) {
    throw new Error("Claude credential ref must start with credential/claude/");
  }
  return validated;
}

// The Claude CLI persists either an OAuth token bundle (`claudeAiOauth`) or a
// raw API key. We match on the stable container key rather than the exact token
// shape so a minor CLI wording change still imports cleanly.
function looksLikeClaudeAuthJson(value: Record<string, unknown>): boolean {
  if (oauthBundleHasAnyToken(value["claudeAiOauth"])) {
    return true;
  }
  return typeof value["ANTHROPIC_API_KEY"] === "string" && value["ANTHROPIC_API_KEY"] !== "";
}

function oauthBundleHasAnyToken(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const oauth = value as Record<string, unknown>;
  return ["accessToken", "refreshToken", "access_token", "refresh_token"].some(
    (key) => typeof oauth[key] === "string" && oauth[key] !== "",
  );
}
