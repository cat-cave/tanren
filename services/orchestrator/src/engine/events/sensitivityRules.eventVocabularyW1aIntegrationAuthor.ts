import type { SensitivityRule } from "./sensitivity.js";

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

/** Complete leaf paths for the four flat W1-A payloads; all are public (16 leaves). */
export const eventVocabularyW1aIntegrationAuthorSensitivityRules: SensitivityRule[] = [
  ...publicRules("integration.author.started", ["missionNodeId", "unitId"]),
  ...publicRules("integration.author.attempt", [
    "missionNodeId",
    "unitId",
    "attempt",
    "bodyPreview",
    "canonicalSignature",
    "rejection",
    "decision",
  ]),
  ...publicRules("integration.author.succeeded", ["missionNodeId", "unitId", "attempts"]),
  ...publicRules("integration.author.failed", ["missionNodeId", "unitId", "reason", "attempts"]),
];
