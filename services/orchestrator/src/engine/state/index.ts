// Single import surface for typed workflow state and transition helpers.
export {
  RunStatus,
  RunOutcome,
  IllegalRunTransitionError,
  isAllowedRunTransition,
  listAllowedRunTransitions,
  transitionRun
} from "./run.js";
export {
  SpecStatus,
  IllegalSpecTransitionError,
  isAllowedSpecTransition,
  listAllowedSpecTransitions,
  transitionSpec
} from "./spec.js";
export {
  TaskKind,
  TaskStatus,
  TaskOutcome,
  IllegalTaskTransitionError,
  isAllowedTaskTransition,
  listAllowedTaskTransitions,
  transitionTask
} from "./task.js";
export {
  JobKind,
  JobStatus,
  IllegalJobTransitionError,
  isAllowedJobTransition,
  listAllowedJobTransitions,
  transitionJob
} from "./job.js";
export { ActorKind, ActorRef, systemActor } from "./actor.js";

import { RunOutcome, RunStatus } from "./run.js";
import { SpecStatus } from "./spec.js";
import { TaskKind, TaskOutcome, TaskStatus } from "./task.js";
import { JobKind, JobStatus } from "./job.js";
import { ActorKind } from "./actor.js";

// stateEnumCatalog drives both the schema CHECK constraints (via the
// generator script) and the drift assertion. Order is part of the contract:
// the SQL `IN (...)` list is emitted in the same order so a meaningful diff
// surfaces when an enum changes.
export const stateEnumCatalog = {
  runs_status: { table: "runs", column: "status", values: RunStatus.options },
  runs_outcome: { table: "runs", column: "outcome", values: RunOutcome.options },
  specs_status: { table: "specs", column: "status", values: SpecStatus.options },
  tasks_kind: { table: "tasks", column: "kind", values: TaskKind.options },
  tasks_status: { table: "tasks", column: "status", values: TaskStatus.options },
  tasks_outcome: { table: "tasks", column: "outcome", values: TaskOutcome.options },
  tasks_agent_kind: { table: "tasks", column: "agent_kind", values: ActorKind.options },
  job_queue_status: { table: "job_queue", column: "status", values: JobStatus.options },
  job_queue_task_kind: { table: "job_queue", column: "task_kind", values: JobKind.options }
} as const;

export type StateEnumName = keyof typeof stateEnumCatalog;

export interface StateEnumDescriptor {
  table: string;
  column: string;
  values: ReadonlyArray<string>;
}

export function listStateEnums(): Array<{ name: StateEnumName } & StateEnumDescriptor> {
  return (Object.keys(stateEnumCatalog) as StateEnumName[]).map((name) => ({
    name,
    ...stateEnumCatalog[name]
  }));
}
