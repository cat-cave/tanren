// Wave-4 table barrel: re-exports the drizzle tables added by the wave-4 barrier
// (symptom evidence, issue-source sync, land groups, governance tiers) so the
// top-level schema.ts keeps a single import line and stays under the schema line cap.
export { verificationAssertions } from "./schemaSymptomEvidence.js";
export { sourceSyncOutbox } from "./schemaIssueSourceSync.js";
export { landGroups, landGroupMembers } from "./schemaLandGroups.js";
export { governanceTiers, policyBindings } from "./schemaGovernanceTiers.js";
