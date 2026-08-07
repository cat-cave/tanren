// Compatibility facade for the historical schemaCore import path. Domain modules
// own their tables; this facade keeps schema.ts and all sub-schema consumers stable.
export { enumCheck, organizations, projects, runs, specs, users } from "./schemaCoreFoundation.js";
export { mergeQueue, mergeQueueHolds, mergeQueuePartitions } from "./schemaCoreMergeQueue.js";
export { postMergeIssueClaims } from "./schemaCorePostMerge.js";
