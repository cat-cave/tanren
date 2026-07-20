import type { SensitivityRule } from "./sensitivity.js";

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

/** Frozen public identifiers/digests for mq-8's build-only EAGER beam events. */
export const eagerBeamSensitivityRules: SensitivityRule[] = [
  ...publicRules("merge.beam.planned", [
    "projectId",
    "beamId",
    "frontierRunId",
    "frontierSpecId",
    "planDigest",
    "integrationNodeId",
    "rank",
    "generation",
    "baseSha",
    "memberShas[]",
  ]),
  ...publicRules("merge.beam.stale", ["projectId", "beamId", "frontierRunId", "reason", "planDigest"]),
];
