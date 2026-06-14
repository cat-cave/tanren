import type { SensitivityRule } from "./sensitivity.js";

// Tanren-native templating (wave 1) sensitivity rules, split out of
// sensitivityRules.ts to keep each file under the 500-line cap. The registry
// lifecycle events carry ONLY non-secret descriptors — the template id, the
// owning org, the conforming-repo ref, the stack label, the channel, and the
// lifecycle tier transition. No credential ref / secret value reaches either
// payload, so every field is `public`.
export const templatesSensitivityRules: SensitivityRule[] = [
  // template.registered: registry identity + manifest descriptors.
  ...rulesFor("template.registered", [
    ["templateId", "public"],
    ["orgId", "public"],
    ["repoRef", "public"],
    ["stack", "public"],
    ["channel", "public"],
    ["status", "public"],
  ]),
  // template.status_changed: the from→to lifecycle transition + its cause.
  ...rulesFor("template.status_changed", [
    ["templateId", "public"],
    ["orgId", "public"],
    ["from", "public"],
    ["to", "public"],
    ["reason", "public"],
  ]),
  // template.selection.no_match: the no-match decision (requested stack + query).
  ...rulesFor("template.selection.no_match", [
    ["orgId", "public"],
    ["stack", "public"],
    ["query", "public"],
  ]),
  // template.creation.started: the just-in-time creation began.
  ...rulesFor("template.creation.started", [
    ["orgId", "public"],
    ["stack", "public"],
  ]),
  // template.creation.published: the validated template that gated the scaffold.
  ...rulesFor("template.creation.published", [
    ["orgId", "public"],
    ["stack", "public"],
    ["templateId", "public"],
    ["repoRef", "public"],
  ]),
  // template.creation.failed: the loud failure cause (no secret surface).
  ...rulesFor("template.creation.failed", [
    ["orgId", "public"],
    ["stack", "public"],
    ["reason", "public"],
  ]),
  // template.build.recovered: the auto-requeue of a stranded build (spec ids + the
  // bounded attempt number — all non-secret descriptors).
  ...rulesFor("template.build.recovered", [
    ["orgId", "public"],
    ["stack", "public"],
    ["requeuedSpecIds[]", "public"],
    ["attempt", "public"],
    ["maxAttempts", "public"],
  ]),
  // template.build.recovery_exhausted: the loud terminal failure after the cap.
  ...rulesFor("template.build.recovery_exhausted", [
    ["orgId", "public"],
    ["stack", "public"],
    ["requeuedSpecIds[]", "public"],
    ["maxAttempts", "public"],
  ]),
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
