import type { MergeQueuePolicyResponse, MergeQueueWindowsResponse } from "../../api/mergeQueuePolicy.js";

const COMMANDS = ["freeze", "unfreeze", "pause", "resume", "drain"] as const;

/** Policy visibility and bounded controls; host-land authority remains absent here. */
export function QueuePolicyPanel(props: {
  policy: MergeQueuePolicyResponse | undefined;
  windows: MergeQueueWindowsResponse | undefined;
  projectId: string;
  commandNotice?: string;
}) {
  if (props.policy === undefined || props.windows === undefined) {
    return (
      <section class="panel">
        <div class="panel-pad">
          <div class="mini-eyebrow">queue policy v1 · controls</div>
          <div class="empty">Policy or window evidence is unavailable; no queue action is offered.</div>
        </div>
      </section>
    );
  }
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">queue policy v1 · revision {props.policy.version}</div>
        <div class="mq-list">
          {props.policy.policy.routes.map((route) => (
            <div class="mq-list-row">
              <b>{route.name}</b>
              <span>{route.targetBranch}</span>
              <span>
                {route.priority.base} · {route.partition.mode} · cap {route.partition.capacity} · batch{" "}
                {route.partition.batchLimit}
              </span>
              <span>requires {route.requiredWindows.join(", ")}</span>
            </div>
          ))}
        </div>
        <div class="note">
          windows: {props.windows.windows.map((window) => `${window.kind}:${window.name}`).join(", ") || "none"}
        </div>
        {props.commandNotice === undefined ? null : <div class="note">{props.commandNotice}</div>}
        <div class="mq-policy-controls">
          {COMMANDS.map((command) => (
            <form method="post" action={`/merge-queue/commands/${command}`}>
              <input type="hidden" name="projectId" value={props.projectId} />
              <input type="hidden" name="reason" value={`dashboard ${command}`} />
              <button type="submit">{command}</button>
            </form>
          ))}
        </div>
        <div class="note">
          Commands are scoped, idempotent, and rechecked at the final claim fence; none can land work.
        </div>
      </div>
    </section>
  );
}
