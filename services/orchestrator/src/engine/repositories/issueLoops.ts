// Compatibility facade for the issue-loop repository's historical import path.
// Contracts/decoders and SQL storage can evolve independently behind it.
export {
  ISSUE_LOOP_RELATIONS,
  ISSUE_LOOP_RESOLUTION_POLICIES,
  ISSUE_LOOP_SEVERITIES,
  ISSUE_LOOP_STATES,
  IssueLoopNotFoundError,
  IssueLoopRow,
  SOURCE_FINDING_STATUSES,
  SourceFindingRow,
} from "./issueLoopContracts.js";
export type {
  AppendSourceFindingInput,
  AppendSourceFindingResult,
  CreateIssueLoopInput,
  IssueLoopRelation,
  IssueLoopResolutionPolicy,
  IssueLoopSeverity,
  IssueLoopState,
  LinkIssueLoopEdgeInput,
  SourceFindingStatus,
  TransitionIssueLoopInput,
  TransitionIssueLoopResult,
  UpsertIssueLoopForSourceInput,
} from "./issueLoopContracts.js";
export { IssueLoopStore } from "./issueLoopStore.js";
