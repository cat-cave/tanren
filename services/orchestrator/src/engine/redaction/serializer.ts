import type { ActorContext } from "../../auth/schemas.js";
import type { EventName } from "../events/registry.js";
import type { Sensitivity } from "../events/sensitivity.js";
import { sensitivityFor } from "../events/sensitivity.js";
import { canViewRaw, describeRequiredScope } from "./scopes.js";
import { containsCredentialSubstring, looksLikeCredential } from "./highEntropy.js";

// Central redaction serializer for P2A-0009.
//
// The serializer walks an event payload using the field-path map registered
// in `sensitivityRules.ts`, replacing each leaf the actor cannot view raw
// with a structured marker. The original payload is never mutated; the
// returned `payload` is a fresh clone.
//
// Two safety nets sit on top of the registry lookup:
//   1. Unknown fields (sensitivity not registered) default to `redacted`.
//      The eventSemanticFields test forbids unregistered fields, so in
//      practice this only fires if a payload carries extra keys at runtime;
//      we still want the safe default.
//   2. `public`-tagged strings are passed through the high-entropy heuristic
//      (`highEntropy.ts`). A field that *looks* like a credential gets
//      bumped to `redacted` so it is hidden from project members. The
//      detector documents its false-positive policy.
//
// Marker shape (matches the P2A-0009 spec):
//   { __redacted: true, sensitivity: "redacted" | "secret", hint: "..." }
//
// `redactedPaths` is the flat list of json-pointer-style paths that were
// hidden, suitable for either an audit event (when an elevated actor opted
// in via rawView) or a UI hint ("this run has 12 hidden fields, request raw
// access to view").

export interface RedactionMarker {
  __redacted: true;
  sensitivity: Sensitivity;
  hint: string;
}

export interface RedactionInput<N extends EventName = EventName> {
  eventName: N;
  payload: unknown;
  actor: ActorContext;
  // When true the actor is opting into raw view (e.g. ?raw=true). The
  // serializer only honors the opt-in for fields whose sensitivity the
  // actor's scope already permits — the opt-in does not bypass the policy,
  // it surfaces which fields the actor consciously decoded raw so the audit
  // emitter has something to record. Without the opt-in, even an admin
  // sees redacted by default (the dashboard default is safe).
  rawView?: boolean;
}

export interface RedactionOutput {
  // Redacted clone. Type-erased: callers serializing JSON consume it
  // directly; typed downstream consumers re-parse via the event registry
  // if needed.
  payload: unknown;
  // Paths that were replaced with a marker because the actor lacks the
  // required scope. Always recorded.
  redactedPaths: string[];
  // Paths that were returned raw and would have been redacted at the
  // default surface — i.e. fields above `public` that the actor could see
  // because rawView is true and the actor's scope qualifies. This is the
  // input the audit emitter consumes.
  rawAccessedPaths: string[];
}

// redactEventPayload is the entry point. It is intentionally pure (no I/O)
// so the caller can decide whether to emit the audit event based on
// `rawAccessedPaths`.
export function redactEventPayload<N extends EventName>(input: RedactionInput<N>): RedactionOutput {
  const redacted: string[] = [];
  const rawAccessed: string[] = [];
  const clone = walk(input.eventName, input.payload, "", input.actor, input.rawView ?? false, redacted, rawAccessed);
  return { payload: clone, redactedPaths: redacted, rawAccessedPaths: rawAccessed };
}

// walk recurses through the payload. Arrays use the "[]" suffix to match
// the registration scheme in `sensitivityRules.ts`.
//
// If a non-scalar subtree has a sensitivity rule registered at its own
// path (e.g. `toolCalls[].args` registered as redacted while args is an
// object of free-form key/value pairs), the whole subtree is replaced
// with a single redaction marker. This is intentional: the rule author
// declared "treat this whole subtree as one sensitive blob".
function walk(
  eventName: string,
  value: unknown,
  path: string,
  actor: ActorContext,
  rawView: boolean,
  redacted: string[],
  rawAccessed: string[],
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  // Check for a registered rule at the current path first. When such a
  // rule exists on a non-scalar, the rule wins and we replace the whole
  // subtree (or return raw under rawView). Without this short-circuit, we
  // would recurse into objects whose leaves carry no individual rule and
  // either drop to the unknown-default or leak the value entirely.
  if (path !== "") {
    const sensitivity = sensitivityFor(eventName, path);
    if (sensitivity !== undefined && sensitivity !== "public") {
      if (!canViewRaw(sensitivity, actor)) {
        redacted.push(path);
        return marker(sensitivity);
      }
      if (rawView) {
        rawAccessed.push(path);
        return value;
      }
      redacted.push(path);
      return marker(sensitivity);
    }
  }
  if (Array.isArray(value)) {
    const childPath = `${path}[]`;
    return value.map((item) => walk(eventName, item, childPath, actor, rawView, redacted, rawAccessed));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = path === "" ? key : `${path}.${key}`;
      result[key] = walk(eventName, child, childPath, actor, rawView, redacted, rawAccessed);
    }
    return result;
  }
  // Scalar leaf — apply the policy.
  return applyPolicy(eventName, value, path, actor, rawView, redacted, rawAccessed);
}

function applyPolicy(
  eventName: string,
  value: unknown,
  path: string,
  actor: ActorContext,
  rawView: boolean,
  redacted: string[],
  rawAccessed: string[],
): unknown {
  let sensitivity = sensitivityFor(eventName, path) ?? UNKNOWN_SENSITIVITY_DEFAULT;
  // High-entropy bump-up: a public string that smells like a credential
  // becomes redacted. We never bump down (a secret cannot become public via
  // this path).
  if (sensitivity === "public" && typeof value === "string" && stringLooksSensitive(value)) {
    sensitivity = "redacted";
  }
  if (sensitivity === "public") {
    return value;
  }
  if (!canViewRaw(sensitivity, actor)) {
    redacted.push(path);
    return marker(sensitivity);
  }
  // Actor is permitted to view raw at this sensitivity. The default
  // dashboard surface still hides it unless the actor opted in via
  // rawView — surfacing raw values to admins by default would defeat the
  // purpose of redact-on-read.
  if (rawView) {
    rawAccessed.push(path);
    return value;
  }
  redacted.push(path);
  return marker(sensitivity);
}

// stringLooksSensitive is the high-entropy bump-up gate. We check both the
// whole string and substring occurrences so log-line fields with embedded
// tokens are caught.
function stringLooksSensitive(value: string): boolean {
  if (looksLikeCredential(value)) {
    return true;
  }
  return containsCredentialSubstring(value);
}

function marker(sensitivity: Sensitivity): RedactionMarker {
  return { __redacted: true, sensitivity, hint: describeRequiredScope(sensitivity) };
}

// Unknown fields default to `redacted` so an accidentally-untagged field
// never leaks. The eventSemanticFields coverage test still requires every
// known field to be tagged; this is the safety net for runtime
// extra-key drift.
const UNKNOWN_SENSITIVITY_DEFAULT: Sensitivity = "redacted";

// isRedactionMarker is a small helper for tests and UI code that wants to
// detect whether a payload field is a marker rather than a real value.
// Bracket access keeps the lint clean while preserving the marker shape
// the P2A-0009 spec mandates.
export function isRedactionMarker(value: unknown): value is RedactionMarker {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return record["__redacted"] === true && typeof record["sensitivity"] === "string";
}
