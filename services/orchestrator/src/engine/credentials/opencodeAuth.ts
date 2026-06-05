import type { SecretStore } from "../contracts/secretStore.js";
import { validateCredentialRef } from "./codexAuth.js";

// opencode CLI credential bundle. The stored secret is the JSON
// opencode persists for its authenticated providers (its `auth.json`). For the
// expansion only the Zai GLM provider is supported, so the bundle must
// carry a `zai` provider entry. (The previously-considered Wafer provider was
// discontinued 2026-05-27 and is intentionally NOT accepted.)
export const opencodeAuthKind = "opencode_cli_auth";

export const ZAI_PROVIDER_ID = "zai";

export interface OpencodeAuthBundle {
  authJson: string;
}

export interface OpencodeAuthImportResult {
  credentialKind: typeof opencodeAuthKind;
  ref: string;
  redacted: true;
}

export async function storeOpencodeAuthBundle(
  secrets: SecretStore,
  input: { ref: string; authJson: string },
): Promise<OpencodeAuthImportResult> {
  const ref = validateOpencodeCredentialRef(input.ref);
  const bundle = validateOpencodeAuthBundle(input.authJson);
  await secrets.put({ ref, value: bundle.authJson });
  return redactedOpencodeAuthResult(ref);
}

export function validateOpencodeAuthBundle(authJson: string): OpencodeAuthBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJson) as unknown;
  } catch {
    throw new Error("opencode auth bundle must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("opencode auth bundle must be a JSON object");
  }
  const parsedObject = parsed as Record<string, unknown>;
  if (Object.keys(parsedObject).length === 0) {
    throw new Error("opencode auth bundle must not be empty");
  }
  if (!looksLikeZaiOpencodeAuth(parsedObject)) {
    throw new Error("opencode auth bundle must include a Zai GLM provider entry");
  }
  return { authJson: JSON.stringify(parsedObject) };
}

export function redactedOpencodeAuthResult(ref: string): OpencodeAuthImportResult {
  return { credentialKind: opencodeAuthKind, ref, redacted: true };
}

export function validateOpencodeCredentialRef(ref: string): string {
  const validated = validateCredentialRef(ref);
  if (!validated.startsWith("credential/opencode/")) {
    throw new Error("opencode credential ref must start with credential/opencode/");
  }
  return validated;
}

// opencode's auth.json is keyed by provider id. We require the Zai entry and
// that it carries an api key / token (matched on the stable field names rather
// than the exact shape so a minor opencode format change still imports).
function looksLikeZaiOpencodeAuth(value: Record<string, unknown>): boolean {
  const zai = value[ZAI_PROVIDER_ID];
  if (typeof zai !== "object" || zai === null || Array.isArray(zai)) {
    return false;
  }
  const entry = zai as Record<string, unknown>;
  return ["key", "apiKey", "api_key", "access", "accessToken"].some(
    (field) => typeof entry[field] === "string" && entry[field] !== "",
  );
}
