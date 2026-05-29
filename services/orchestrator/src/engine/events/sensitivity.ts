import { z } from "zod";

// Sensitivity tags drive the redaction layer in P2A-0009. Each payload field
// is registered with a tag, and the redaction serializer consults this map at
// API/serialization time when an actor's scope determines whether the field
// is returned raw or redacted. The taxonomy is intentionally small so the
// redaction layer's per-scope decisions remain trivially auditable.
export const Sensitivity = z.enum([
  // safe to display to any project member
  "public",
  // requires project:admin scope to view raw
  "redacted",
  // requires platform:admin scope to view raw
  "secret",
]);
export type Sensitivity = z.infer<typeof Sensitivity>;

// FieldPath is a json-pointer-style dotted path into an event payload.
// Array elements are denoted by "[]" so the path stays stable regardless of
// length, e.g. "decisions[].code" matches every element of the decisions
// array.
export type FieldPath = string;

export interface SensitivityRule {
  eventName: string;
  path: FieldPath;
  tag: Sensitivity;
}

// Internal storage: map keyed by `${eventName}:${path}` to a tag.
const ruleMap = new Map<string, Sensitivity>();

function ruleKey(eventName: string, path: FieldPath): string {
  return `${eventName}:${path}`;
}

export function registerSensitivity(eventName: string, path: FieldPath, tag: Sensitivity): void {
  ruleMap.set(ruleKey(eventName, path), tag);
}

export function registerSensitivities(rules: ReadonlyArray<SensitivityRule>): void {
  for (const rule of rules) {
    registerSensitivity(rule.eventName, rule.path, rule.tag);
  }
}

// sensitivityFor returns the registered tag for a specific event-name plus
// json path. Falls back to undefined if no tag is registered so callers can
// detect missing registrations during tests.
export function sensitivityFor(eventName: string, path: FieldPath): Sensitivity | undefined {
  return ruleMap.get(ruleKey(eventName, path));
}

export function listSensitivityRules(): SensitivityRule[] {
  return [...ruleMap.entries()].map(([key, tag]) => {
    const separator = key.indexOf(":");
    return { eventName: key.slice(0, separator), path: key.slice(separator + 1), tag };
  });
}

export function listSensitivityPathsFor(eventName: string): FieldPath[] {
  const prefix = `${eventName}:`;
  return [...ruleMap.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

// resetSensitivityRulesForTesting allows test isolation. Production code never
// calls this; it is exported only for the registry self-tests.
export function resetSensitivityRulesForTesting(): void {
  ruleMap.clear();
}
