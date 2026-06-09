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
];

function rulesFor(eventName: string, entries: ReadonlyArray<[string, SensitivityRule["tag"]]>): SensitivityRule[] {
  return entries.map(([path, tag]) => ({ eventName, path, tag }));
}
