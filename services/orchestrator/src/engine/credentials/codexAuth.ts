import type { SecretStore } from "../contracts/secretStore.js";

export const codexAuthKind = "codex_chatgpt_auth";

export interface CodexAuthBundle {
  authJson: string;
}

export interface CodexAuthImportResult {
  credentialKind: typeof codexAuthKind;
  ref: string;
  redacted: true;
}

export async function storeCodexAuthBundle(
  secrets: SecretStore,
  input: { ref: string; authJson: string },
): Promise<CodexAuthImportResult> {
  const ref = validateCodexCredentialRef(input.ref);
  const bundle = validateCodexAuthBundle(input.authJson);
  await secrets.put({ ref, value: bundle.authJson });
  return redactedCodexAuthResult(ref);
}

export function validateCodexAuthBundle(authJson: string): CodexAuthBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson) as unknown;
  } catch {
    throw new Error("Codex auth bundle must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Codex auth bundle must be a JSON object");
  }
  const parsedObject = parsed as Record<string, unknown>;
  if (Object.keys(parsedObject).length === 0) {
    throw new Error("Codex auth bundle must not be empty");
  }
  if (!looksLikeCodexAuthJson(parsedObject)) {
    throw new Error("Codex auth bundle must include Codex ChatGPT token fields");
  }
  return { authJson: JSON.stringify(parsedObject) };
}

export function redactedCodexAuthResult(ref: string): CodexAuthImportResult {
  return { credentialKind: codexAuthKind, ref, redacted: true };
}

export function validateCredentialRef(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(ref) || ref.includes("//")) {
    throw new Error("credential ref must be an explicit managed ref");
  }
  if (ref.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("credential ref must not contain relative path segments");
  }
  return ref;
}

export function validateCodexCredentialRef(ref: string): string {
  const validated = validateCredentialRef(ref);
  if (!validated.startsWith("credential/codex/")) {
    throw new Error("Codex credential ref must start with credential/codex/");
  }
  return validated;
}

function looksLikeCodexAuthJson(value: Record<string, unknown>): boolean {
  const tokens = value["tokens"];
  if (typeof value["auth_mode"] === "string" && tokensObjectHasAnyToken(tokens)) {
    return true;
  }
  return (
    tokensObjectHasAnyToken(tokens) || (typeof value["OPENAI_API_KEY"] === "string" && value["OPENAI_API_KEY"] !== "")
  );
}

function tokensObjectHasAnyToken(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const tokens = value as Record<string, unknown>;
  return ["access_token", "refresh_token", "id_token"].some(
    (key) => typeof tokens[key] === "string" && tokens[key] !== "",
  );
}
