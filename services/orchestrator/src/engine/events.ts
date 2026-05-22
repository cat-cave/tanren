export const eventNamesByScope = {
  run: ["run.queued", "run.started", "run.completed", "run.failed"],
  task: ["task.queued", "task.started", "task.completed", "task.failed"],
  planner: ["planner.started", "planner.completed", "planner.failed"],
  writer: ["writer.started", "writer.completed", "writer.failed"],
  checker: ["checker.started", "checker.completed", "checker.failed"],
  auditor: ["auditor.started", "auditor.completed", "auditor.failed"],
  runner: ["runner.allocated", "runner.released", "runner.failed"],
  allocator: ["allocator.requested", "allocator.allocated", "allocator.failed"],
  workspace: ["workspace.prepared", "workspace.git_captured", "workspace.failed"],
  credential: ["credential.requested", "credential.loaded", "credential.failed"],
  cost: ["cost.resolved", "cost.failed"],
  github: ["github.pr.created", "github.pr.ready", "github.pr.merged", "github.failed"],
  ci: ["ci.started", "ci.passed", "ci.failed"],
  review: ["review.requested", "review.approved", "review.changes_requested"],
  notification: ["notification.enqueued", "notification.sent", "notification.failed"],
  hello: ["hello.started", "hello.ssh_started", "hello.ssh_completed", "hello.completed"]
} as const;

type EventScopeMap = typeof eventNamesByScope;
type EventScope = keyof EventScopeMap;

export type EventName = EventScopeMap[EventScope][number];

const eventNames = new Set<string>(Object.values(eventNamesByScope).flat());

export function isEventName(value: string): value is EventName {
  return eventNames.has(value);
}

export function assertEventName(value: string): asserts value is EventName {
  if (!isEventName(value)) {
    throw new Error(`undeclared event name: ${value}`);
  }
}

export function listEventNames(): EventName[] {
  return [...eventNames].sort() as EventName[];
}
