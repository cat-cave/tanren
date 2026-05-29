// P2A-0019: barrel for Forge tool implementations. Each export name
// matches the corresponding `ForgeToolCall` variant from the P2A-0008
// schema (with the `tanren.`/`repo.` prefix removed). The dashboard's
// `/forge/tools` route dispatches to these by name.

export { ToolAccessDeniedError } from "./authz.js";

export {
  tanrenReadSpec,
  tanrenReadRun,
  tanrenReadEvents,
  tanrenReadCosts,
  tanrenReadBehaviors,
  tanrenReadMilestones,
  tanrenReadInsights,
  type TanrenReadSpecResult,
  type TanrenReadRunResult,
  type TanrenReadEventsArgs,
  type TanrenReadCostsArgs,
  type RedactedEventRow,
} from "./read.js";

export {
  repoReadFile,
  repoGrep,
  repoReadIssue,
  type RepoReadFileResult,
  type RepoGrepResult,
  type RepoIssueResult,
} from "./repo.js";

export {
  WriteToolAccessDeniedError,
  tanrenCreateSpec,
  tanrenTriggerRun,
  tanrenRerunTask,
  tanrenAcknowledgeInsight,
  type TanrenCreateSpecArgs,
  peekAcknowledgedInsightForTests,
} from "./write.js";
