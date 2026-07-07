import type { SensitivityRule } from "./sensitivity.js";

// Templating sensitivity rules (docs/roadmap/templating-system.md). The
// fragment-authoring lifecycle (F2) is what remains — every payload carries only
// non-secret descriptors.
export const templatesSensitivityRules: SensitivityRule[] = [
  ...rulesFor("fragment.authoring.started", [
    ["orgId", "public"],
    ["fragmentId", "public"],
    ["kind", "public"],
    ["label", "public"],
  ]),
  ...rulesFor("fragment.authoring.attempt", [
    ["orgId", "public"],
    ["fragmentId", "public"],
    ["attempt", "public"],
    // bodyPreview is code (constrained-subset TS) — not a secret. Kept public
    // so an operator debugging a stuck writer trajectory can see it in the
    // stream without redaction.
    ["bodyPreview", "public"],
    // canonicalSignature is a SHA-256 digest of the parsed ops / normalized
    // body — not sensitive.
    ["canonicalSignature", "public"],
    // rejection is the validator's failure message (parse rejection / smoke
    // failure) — no secrets by construction.
    ["rejection", "public"],
    ["decision", "public"],
  ]),
  ...rulesFor("fragment.authoring.succeeded", [
    ["orgId", "public"],
    ["fragmentId", "public"],
    ["attempts", "public"],
  ]),
  ...rulesFor("fragment.authoring.failed", [
    ["orgId", "public"],
    ["fragmentId", "public"],
    ["reason", "public"],
    ["attempts", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
