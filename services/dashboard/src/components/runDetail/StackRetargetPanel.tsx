/**
 * gv-4: stacked-PR retarget safety panel on run detail.
 * Shows the complete ancestor member vector, merge status, and walk target so
 * operators can see that merged transitive ancestors never remain as the PR base.
 */

import type { FetchStackRetargetResult, StackRetargetView } from "../../api/stackRetarget.js";

export interface StackRetargetPanelProps {
  result: FetchStackRetargetResult;
}

function MemberRow(props: { view: StackRetargetView }) {
  const { view } = props;
  if (!view.speculative || view.members.length === 0) {
    return (
      <div class="stack-retarget-empty" data-gv4="non-speculative">
        not speculative · empty <code>ancestor_stack</code> · base <code data-gv4="to-base">{view.defaultBranch}</code>
      </div>
    );
  }
  return (
    <ol class="stack-retarget-members" data-gv4="members">
      {view.members.map((m, idx) => (
        <li
          key={m.specId}
          data-gv4-member={m.specId}
          data-gv4-merged={m.merged ? "true" : "false"}
          style={m.merged ? "opacity:0.65" : undefined}
        >
          <span class="stack-retarget-ord">{idx + 1}.</span> <code>{m.specId}</code> · branch <code>{m.branch}</code> ·{" "}
          <span data-gv4-status={m.merged ? "merged" : "unmerged"}>{m.merged ? "merged" : "unmerged"}</span>
        </li>
      ))}
    </ol>
  );
}

export function StackRetargetPanel(props: StackRetargetPanelProps) {
  const { result } = props;

  if (result.kind === "auth") {
    return (
      <section class="stack-retarget" data-gv4="panel" data-gv4-state="auth">
        <h3>stack retarget (gv-4)</h3>
        <div data-gv4="auth">access denied ({result.status}) — stack membership hidden</div>
      </section>
    );
  }
  if (result.kind === "not_found") {
    return (
      <section class="stack-retarget" data-gv4="panel" data-gv4-state="not_found">
        <h3>stack retarget (gv-4)</h3>
        <div data-gv4="not-found">run not found for stack-retarget projection</div>
      </section>
    );
  }
  if (result.kind === "unavailable") {
    return (
      <section class="stack-retarget" data-gv4="panel" data-gv4-state="unavailable">
        <h3>stack retarget (gv-4)</h3>
        <div data-gv4="unavailable">stack-retarget unavailable ({result.reason})</div>
      </section>
    );
  }

  const view = result.view;
  const hold = view.unmergedAncestors.length > 0;
  return (
    <section
      class="stack-retarget"
      data-gv4="panel"
      data-gv4-state="ok"
      data-gv4-speculative={view.speculative ? "true" : "false"}
      data-gv4-hold={hold ? "true" : "false"}
    >
      <h3>stack retarget (gv-4)</h3>
      <div class="stack-retarget-summary" data-gv4="summary">
        walk target base · <code data-gv4="to-base">{view.toBase}</code>
        {" · "}
        default · <code data-gv4="default-branch">{view.defaultBranch}</code>
        {" · "}
        {hold ? (
          <span data-gv4="hold-label">held on {view.unmergedAncestors.length} unmerged ancestor(s)</span>
        ) : (
          <span data-gv4="hold-label">no unmerged ancestors</span>
        )}
      </div>
      <MemberRow view={view} />
      {view.speculative && view.remainingStack.length === 0 && view.mergedSpecIds.length > 0 ? (
        <div data-gv4="emptied" style="margin-top:6px">
          all stack members merged · remaining stack empty · target is default branch
        </div>
      ) : null}
    </section>
  );
}
