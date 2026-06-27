import type { SensitivityRule } from "./sensitivity.js";

// Templating sensitivity rules (docs/roadmap/templating-system.md). The wave-1
// template REGISTRY + wave-4 creation + wave-5 maintenance + build-recovery rules
// are GONE with the doctrine collapse. What remains is the per-fragment authoring
// run lifecycle (F2) — every payload carries only non-secret descriptors.
export const templatesSensitivityRules: SensitivityRule[] = [
  ...rulesFor("fragment.authoring.started", [
    ["orgId", "public"],
    ["fragmentId", "public"],
    ["kind", "public"],
    ["label", "public"],
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
