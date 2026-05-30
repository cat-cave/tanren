/**
 * HaltedRunBody — the failure-recovery screen (P2B-0008) rendered server-side
 * inside the shell. Recreated from the hi-fi `view-failure.jsx`:
 *   - page head (eyebrow + title + run/spec/retry/elapsed/$ sub-line + halted pill)
 *   - failure-context strip (4 cells)
 *   - recovery chat (left) — templated v0 narration analyzing the failure
 *   - recovery cards (right) — the four actions + last-resort abandon
 *   - dag-impact strip — flat list of downstream-blocked specs (Phase 2)
 *
 * The recovery cards are plain server-rendered <form>s that POST to the
 * dashboard's same-origin recovery handler (which proxies to the orchestrator
 * recovery routes with the session cookie). Rollback is disabled when no prior
 * commit exists and requires an explicit confirm checkbox before it submits.
 */

import type { RunDetail } from "../../api/types.js";
import { buildDownstreamImpact, buildFailureContext, type DownstreamImpact, type FailureContext } from "./model.js";
import { RECOVERY_CSS } from "./recovery.css.js";

export interface HaltedRunBodyProps {
  detail: RunDetail;
  lastGoodCommit: string | null;
  /** All project specs, for the downstream-impact list (dependsOn edges). */
  specs: Array<{ specId: string; title: string; dependsOn: string[] }>;
  /** Base path for recovery action POSTs (e.g. `/runs/:runId/recover`). */
  actionBase: string;
  /** Back-to-project link. */
  projectHref: string;
  /** Back-to-run-detail link. */
  runHref: string;
}

function PageHead(props: { detail: RunDetail; ctx: FailureContext; runHref: string }) {
  const { run } = props.detail;
  return (
    <div class="page-head">
      <div>
        <div class="eyebrow" style="color: var(--status-fail)">
          ▮ run halted · {props.ctx.hatchLabel}
        </div>
        <div class="page-title">
          get the <em>engine</em> moving again
        </div>
        <div class="sub">
          {run.runId} · {run.specId} · {props.ctx.retries} retries · {props.ctx.elapsed} elapsed ·{" "}
          {props.ctx.dollarsBurned} spent
        </div>
      </div>
      <div class="head-actions" style="display:flex; gap:8px; align-items:center">
        <span class="pill fail">
          <span class="d"></span>halted
        </span>
        <a class="btn ghost" href={props.runHref}>
          ← back to run
        </a>
      </div>
    </div>
  );
}

function FailureContextStrip(props: { ctx: FailureContext; impact: DownstreamImpact }) {
  const { ctx, impact } = props;
  const blockedList =
    impact.blockedSpecs.length === 0 ? "no downstream specs blocked" : impact.blockedSpecs.join(" · ");
  return (
    <div class="fail-context">
      <div class="cell danger">
        <div class="l">what blocked it</div>
        <div class="v">{ctx.blockedReason}</div>
        <div class="s">{ctx.blockedDetail}</div>
      </div>
      <div class="cell">
        <div class="l">last good state</div>
        <div class="v">
          {ctx.lastGoodCommit === null ? (
            "no prior commit"
          ) : (
            <>
              commit <code>{ctx.lastGoodCommit}</code>
            </>
          )}
        </div>
        <div class="s">
          {ctx.lastGoodAgo} · {ctx.lastGoodDetail}
        </div>
      </div>
      <div class="cell">
        <div class="l">blocks downstream</div>
        <div class="v">
          <b style="color: var(--ember-08)">{impact.blockedSpecs.length} specs</b> waiting
        </div>
        <div class="s">{blockedList}</div>
      </div>
      <div class="cell">
        <div class="l">elapsed at hatch</div>
        <div class="v">
          {ctx.elapsed} · {ctx.retries} retries
        </div>
        <div class="s">
          {ctx.dollarsBurned} burned · {ctx.hatchLabel}
        </div>
      </div>
    </div>
  );
}

function RecoveryChat(props: { ctx: FailureContext }) {
  const { ctx } = props;
  return (
    <div class="recovery-chat">
      <div class="chat-head">
        <span class="t">recovery</span>
        <span class="m">templated · reads the run's event + workflow-insight history</span>
      </div>
      <div class="turns">
        <div class="turn">
          The loop hit the escape hatch. <b class="fail">{ctx.blockedReason}</b>. {ctx.blockedDetail}. Each retry, the
          writer added more defensiveness; each retry, the auditor found a new edge case.
        </div>
        <div class="turn">
          This looks like a <b class="ember">spec problem, not a code problem</b> — the failing criterion is ambiguous,
          so the writer and auditor are disagreeing about what "demonstrated" means.
          <div class="rec-inline">
            <div class="h">recommended path</div>
            <div>
              <b>revise the spec</b> — split or redefine the failing criterion so both roles can agree on a verifiable
              test, then replan and continue.
            </div>
          </div>
        </div>
        <div class="turn">Other ways out are on the right — or replan with your own steering note.</div>
      </div>
      <div class="chat-hint">
        <span class="fail">↑ engine paused</span> · nothing moves until you pick a recovery
      </div>
    </div>
  );
}

function RecoveryCards(props: { actionBase: string; ctx: FailureContext }) {
  const { actionBase, ctx } = props;
  const canRollback = ctx.lastGoodCommit !== null;
  return (
    <div class="recovery-rail">
      <div class="rail-head">▮ recovery options · pick one</div>

      {/* revise the spec — recommended */}
      <div class="recovery-card recommended">
        <span class="rec-tape">forge recommends</span>
        <div class="lbl">revise the spec</div>
        <div class="t">split or redefine the failing criterion</div>
        <div class="det">
          most useful when writer ↔ auditor disagree on what "done" means. records the intent and opens the spec-edit
          form; on submit the planner is re-invoked with the revised spec.
        </div>
        <form class="card-actions" method="post" action={`${actionBase}/revise`}>
          <button class="btn primary" type="submit">
            open revision pane ↗
          </button>
        </form>
      </div>

      {/* replan with instructions */}
      <div class="recovery-card">
        <div class="lbl">replan with instructions</div>
        <div class="t">send back to planner · with steering</div>
        <div class="det">
          same spec, fresh plan, with your instructions. useful when the spec is right but the agent's approach was
          wrong.
        </div>
        <form method="post" action={`${actionBase}/replan`}>
          <textarea
            name="steeringNote"
            required
            placeholder="next time, use a server-side cookie for the first paint instead of inline script…"
          ></textarea>
          <div class="card-actions">
            <button class="btn" type="submit">
              send to planner ↗
            </button>
          </div>
        </form>
      </div>

      {/* rollback the code */}
      <div class="recovery-card">
        <div class="lbl">rollback the code</div>
        <div class="t">revert to a known-good commit</div>
        <div class="det">
          discards the writer's partial work.{" "}
          {canRollback ? (
            <>
              last good commit was <code>{ctx.lastGoodCommit}</code> ({ctx.lastGoodDetail}).
            </>
          ) : (
            "no prior commit was captured for this run."
          )}
        </div>
        {canRollback ? (
          <form method="post" action={`${actionBase}/rollback`}>
            <div class="card-actions">
              <span class="commit-pick">
                {ctx.lastGoodCommit} · {ctx.lastGoodAgo} · {ctx.lastGoodDetail}
              </span>
              <input type="hidden" name="commitSha" value={ctx.lastGoodCommit ?? ""} />
            </div>
            <label class="disabled-note">
              <input type="checkbox" name="confirmed" value="true" required /> confirm — discards partial work, cannot
              be undone
            </label>
            <div class="card-actions">
              <button class="btn danger" type="submit">
                rollback ↻
              </button>
            </div>
          </form>
        ) : (
          <div class="card-actions">
            <button class="btn danger" type="button" disabled>
              rollback ↻
            </button>
            <span class="disabled-note">disabled · no prior commit to roll back to</span>
          </div>
        )}
      </div>

      {/* resolve via conversation */}
      <div class="recovery-card">
        <div class="lbl">resolve via conversation</div>
        <div class="t">explore with forge before deciding</div>
        <div class="det">
          opens an inspection thread with read access to the auditor/writer disagreement history. reading it changes no
          state.
        </div>
        <form class="card-actions" method="post" action={`${actionBase}/inspection-thread`}>
          <button class="btn ghost" style="color: var(--ember-08)" type="submit">
            open inspection thread ↗
          </button>
        </form>
      </div>

      {/* last resort · abandon */}
      <div class="recovery-card last-resort">
        <div class="lbl">last resort</div>
        <div class="last-resort-row">
          <div style="font-family: var(--font-ui); font-size: 12px; color: var(--fg-1)">
            abandon · move spec to backlog
          </div>
          <a
            class="btn ghost"
            style="color: var(--status-fail)"
            href={`${actionBase.replace(/\/recover$/u, "")}/review`}
          >
            cancel run ↗
          </a>
        </div>
        <div class="last-resort-note">workspace preserved · downstream specs stay blocked · revisit later</div>
      </div>
    </div>
  );
}

function DagImpactStrip(props: { impact: DownstreamImpact; specId: string }) {
  const { impact } = props;
  return (
    <div class="dag-impact">
      <div class="head">
        <span class="lbl">▮ dag impact · while paused</span>
        <span class="meta">{impact.blockedSpecs.length} downstream specs wait on resolution</span>
      </div>
      <div class="track">
        <span class="node halted">× {impact.haltedSpecTitle} halted</span>
        {impact.blockedSpecs.length > 0 && <span class="sep fail">→</span>}
        {impact.blockedSpecs.map((title, i) => (
          <>
            <span class="node old">○ {title}</span>
            {i < impact.blockedSpecs.length - 1 && <span class="sep">→</span>}
          </>
        ))}
      </div>
    </div>
  );
}

export function HaltedRunBody(props: HaltedRunBodyProps) {
  const ctx = buildFailureContext(props.detail, props.lastGoodCommit);
  const impact = buildDownstreamImpact(props.detail, props.specs);
  return (
    <>
      <style>{RECOVERY_CSS}</style>
      <PageHead detail={props.detail} ctx={ctx} runHref={props.runHref} />
      <div class="page-body scrolls">
        <FailureContextStrip ctx={ctx} impact={impact} />
        <div class="recovery-split">
          <RecoveryChat ctx={ctx} />
          <RecoveryCards actionBase={props.actionBase} ctx={ctx} />
        </div>
        <DagImpactStrip impact={impact} specId={props.detail.run.specId} />
      </div>
    </>
  );
}
