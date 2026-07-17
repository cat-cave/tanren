import type { SensitivityRule } from "./sensitivity.js";

// Sensitivity tags for the WAVE-2 governance policy-revision vocabulary (gv-7).
// Every frozen payload carries only revision/project IDs, revision/schema
// numbers, content hashes, a rule count, and a fixed reason enum — never the
// policy source/AST bodies, tokens, or any secret — so every reachable path is
// `public`.

function publicRules(eventName: string, paths: readonly string[]): SensitivityRule[] {
  return paths.map((path) => ({ eventName, path, tag: "public" }));
}

export const governanceVocabularySensitivityRules: SensitivityRule[] = [
  ...publicRules("governance.policy.created", [
    "revisionId",
    "projectId",
    "revisionNumber",
    "schemaVersion",
    "parentRevisionId",
    "createdBy",
  ]),
  ...publicRules("governance.policy.compiled", [
    "revisionId",
    "projectId",
    "revisionNumber",
    "policyHash",
    "ruleCount",
  ]),
  ...publicRules("governance.policy.activated", ["revisionId", "projectId", "revisionNumber", "policyHash"]),
  ...publicRules("integration.proof.invalidated", ["reason", "projectId", "proofUnitDigest", "policyHash"]),
];
