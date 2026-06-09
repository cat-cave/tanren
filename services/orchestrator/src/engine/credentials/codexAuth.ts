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

// The grammar EVERY stored credential ref must satisfy, shared by the managed AND
// the BYOK paths (it is NOT a managed-vs-byok discriminator — both modes store
// refs in this single shape): `credential/<slug>/<scope>/<owner>/<name>`, made of
// alnum-plus-`._-` segments joined by single `/`, no empty segment (`//`), ≤200
// chars, no leading punctuation. A BYOK Codex ref (`credential/codex/org/<org>/…`)
// satisfies it exactly; a malformed ref (empty, doubled-slash, illegal char) is a
// FORMAT error — historically misreported as "must be an explicit managed ref",
// which mis-pointed the apex v29 BYOK-Codex diagnosis at a managed-mode mismatch.
export function validateCredentialRef(ref: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(ref) || ref.includes("//")) {
    throw new Error(`credential ref has an invalid format: ${JSON.stringify(ref)}`);
  }
  if (ref.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("credential ref must not contain relative path segments");
  }
  return ref;
}

/**
 * Non-throwing form of {@link validateCredentialRef}: `true` iff `ref` satisfies
 * the credential-ref grammar (so the materializer would accept its format). Lets a
 * WRITE-time chokepoint (the default-LLM config schema) reject a malformed ref
 * where it is SET, instead of letting it crash a run deep in the materializer.
 */
export function isValidCredentialRefFormat(ref: string): boolean {
  try {
    validateCredentialRef(ref);
    return true;
  } catch {
    return false;
  }
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
