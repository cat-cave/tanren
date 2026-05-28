/**
 * ReviewBody — the review-handoff sub-surface (P2B-0004), reachable from the
 * run detail. Recreated from the hi-fi `view-review.jsx`:
 *   - page head (PR + repo eyebrow, "review with forge", spec/change sub-line)
 *   - Forge review chat (left): opening narration, clickable behavior checklist,
 *     writer-deferred items with handle/defer/dismiss actions, a live nudge turn
 *   - preview pane (right): static placeholder card + device tabs + open ↗
 *   - readiness gate (bottom): three state pills + sign-off CTAs per the
 *     configured merge integration (disabled in v0) + always-available
 *     `request changes`
 *
 * The interactive bits (toggle behaviors, resolve deferrals, recompute the
 * readiness gate, request-changes) hydrate via the `reviewHandoff` client
 * island. Behaviors are derived from the spec's behaviorIds (contract-typed);
 * deferrals are derived from writer-deferral events in the run snapshot.
 */

import type { RunDetail, RunEventRow } from "../../api/types.js";
import { summarizeCosts, formatUsd } from "./model.js";
import { RUN_DETAIL_CSS } from "./runDetail.css.js";

/** The four Phase-2 merge-integration modes (mirrors P2A-0006 MergeIntegration). */
export type MergeIntegration = "mergify_queue" | "direct_merge" | "external_reviewer" | "not_configured";

export interface ReviewDeferral {
  /** Stable key (the source event id) so the island can address it. */
  id: string;
  tag: string;
  title: string;
  detail: string;
}

export interface ReviewBodyProps {
  detail: RunDetail;
  /** Resolved per-repo merge integration (P2A-0006). Defaults to not_configured. */
  mergeIntegration: MergeIntegration;
  /** Path back to the run detail. */
  runHref: string;
  /** Dashboard route that records a request-changes action. */
  requestChangesHref: string;
  /** Project settings link (for the not_configured branch). */
  settingsHref: string;
}

/** Pull writer-deferral items out of the run's typed events (no stdout parsing). */
export function deferralsFromEvents(events: RunEventRow[]): ReviewDeferral[] {
  const out: ReviewDeferral[] = [];
  for (const event of events) {
    const isDeferral =
      event.eventType.includes("defer") || event.eventType.includes("followup") || event.eventType.includes("follow_up");
    if (!isDeferral) continue;
    const payload = typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};
    const title = typeof payload.title === "string" ? payload.title : typeof payload.summary === "string" ? payload.summary : event.eventType;
    const detail = typeof payload.detail === "string" ? payload.detail : typeof payload.reason === "string" ? payload.reason : "Deferred by the writer during the run.";
    const tag = typeof payload.tag === "string" ? payload.tag : "deferred";
    out.push({ id: String(event.id), tag, title, detail });
  }
  return out;
}

function prNumberFromUrl(url: string | null): string {
  if (url === null) return "pr";
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? `pr #${match[1]}` : "pr";
}

function repoFromUrl(url: string | null): string {
  if (url === null) return "repo";
  const match = /github\.com\/([^/]+\/[^/]+)/.exec(url);
  return match ? match[1] : "repo";
}

function MergeActions(props: { mode: MergeIntegration; settingsHref: string }) {
  const disabledTip = "merge integration · not wired in v0 — Phase 3";
  if (props.mode === "not_configured") {
    return (
      <>
        <span class="merge-note">
          repo has no merge integration · <a href={props.settingsHref}>configure ↗</a>
        </span>
        <button class="btn" disabled title="configure a merge integration in project settings" data-review="signoff">
          sign off · merge integration not configured
        </button>
      </>
    );
  }
  if (props.mode === "external_reviewer") {
    return (
      <button class="btn primary notched" disabled title={disabledTip} data-review="signoff">
        approve · notify reviewer
      </button>
    );
  }
  if (props.mode === "direct_merge") {
    return (
      <button class="btn primary notched" disabled title={disabledTip} data-review="signoff">
        sign off · merge now ↗
      </button>
    );
  }
  // mergify_queue
  return (
    <>
      <button class="btn" disabled title={disabledTip} data-review="signoff">sign off · queue with mergify</button>
      <button class="btn primary notched" disabled title={disabledTip} data-review="signoff">sign off · merge now ↗</button>
    </>
  );
}

function PreviewPane(props: { detail: RunDetail }) {
  const previewUrl = props.detail.run.prUrl;
  return (
    <div class="preview" data-review="preview">
      <div class="head">
        <span class="moment-eyebrow" style="font-size:9.5px">preview</span>
        <span class="url">{previewUrl ?? "no preview url declared"}</span>
        <div class="device-tabs" data-review="device-tabs">
          <button class="active" data-device="desktop">desktop</button>
          <button data-device="tablet">tablet</button>
          <button data-device="mobile">mobile</button>
        </div>
        {previewUrl !== null ? (
          <a class="btn" href={previewUrl} target="_blank" rel="noreferrer" style="font-size:11px">open ↗</a>
        ) : null}
      </div>
      <div class="frame">
        <div class="placeholder-frame" data-review="preview-frame" style="max-width:none">
          <div class="pl-title">{props.detail.spec.title}</div>
          <div class="pl-note">
            Live preview-deploy iframes are Phase 3. This static placeholder reflects the change under review.
            {previewUrl !== null ? (
              <>
                <br />
                <a href={previewUrl} target="_blank" rel="noreferrer">open the PR / preview ↗</a>
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div class="rd-foot">3 device sizes · live preview iframe ships Phase 3</div>
    </div>
  );
}

export function ReviewBody(props: ReviewBodyProps) {
  const { detail } = props;
  const behaviors = detail.spec.behaviorIds;
  const deferrals = deferralsFromEvents(detail.recentEvents);
  const totals = summarizeCosts(detail.costs);
  const ciTask = detail.tasks.find((t) => t.kind === "ci");
  const ciGreen = ciTask?.outcome === "passed";
  const forgedBy = detail.tasks.find((t) => t.kind === "write")?.cli ?? detail.tasks[0]?.cli ?? "agent";

  return (
    <>
      <style>{RUN_DETAIL_CSS}</style>
      <div
        class="review-root"
        data-island="review"
        data-behavior-count={String(behaviors.length)}
        data-deferral-count={String(deferrals.length)}
        data-ci-green={ciGreen ? "1" : "0"}
      >
        <div class="page-head">
          <div>
            <div class="eyebrow">▮ {prNumberFromUrl(detail.run.prUrl)} · {repoFromUrl(detail.run.prUrl)}</div>
            <div class="page-title">review with forge</div>
            <div class="sub">
              {detail.spec.title} · forged by {forgedBy} · {formatUsd(totals.perTokenUsd)}
            </div>
          </div>
          <div class="rd-actions">
            <a class="btn ghost" href={props.runHref}>← back to run</a>
            {detail.run.prUrl !== null ? (
              <a class="btn" href={detail.run.prUrl} target="_blank" rel="noreferrer">open pr on github ↗</a>
            ) : null}
          </div>
        </div>

        <div class="page-body" style="padding:0; margin-top:12px;">
          <div class="split-review">
            {/* Forge review chat */}
            <div class="forge-card">
              <div class="head">
                <span class="stamp">鍛</span>
                <span class="title">forge · review</span>
                <span class="meta">
                  {behaviors.length} behaviors · {deferrals.length} deferred · {ciGreen ? "ci green" : "ci pending"}
                </span>
              </div>
              <div class="body">
                <div class="forge-turn">
                  Ready to review. Walk through <b class="accent">{behaviors.length} behaviors</b> and{" "}
                  <b class="accent">{deferrals.length} item(s) I deferred during the run</b>. Tick each as you verify;
                  the preview is on the right.
                </div>

                <div class="forge-turn">
                  <h4 style="color: var(--ember-08)" data-review="behaviors-header">
                    behaviors · <span data-review="verified-count">0</span> of {behaviors.length} verified
                  </h4>
                  <div style="display:flex; flex-direction:column; gap:6px;">
                    {behaviors.length === 0 ? (
                      <div style="font-size:12px; color: var(--fg-3)">no behaviors tagged on this spec</div>
                    ) : (
                      behaviors.map((b, i) => (
                        <div class="behavior" data-review-behavior={b} role="button" tabindex={0}>
                          <div class="check"></div>
                          <div class="t"><b>b{i + 1}</b>{b}</div>
                          <span class="ci">ci {ciGreen ? "✓" : "—"}</span>
                          <span class="you" data-review-you>you ○</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div class="forge-turn">
                  <h4 style="color: var(--status-warn)" data-review="deferrals-header">
                    i deferred {deferrals.length} thing(s) during the run · decide before merge
                  </h4>
                  <div style="font-size:12px; color: var(--fg-2); line-height:1.5; margin-bottom:8px;">
                    Neither blocks shipping by itself. If they should be handled now, I'll loop back to the planner and
                    add subtasks to this spec. Spawning a separate spec is the deferral.
                  </div>
                  <div style="display:flex; flex-direction:column; gap:8px;">
                    {deferrals.length === 0 ? (
                      <div style="font-size:12px; color: var(--fg-3)">no writer deferrals on this run</div>
                    ) : (
                      deferrals.map((d) => (
                        <div class="deferral" data-review-deferral={d.id}>
                          <div class="head">
                            <span class="tag">{d.tag}</span>
                            <span class="t">{d.title}</span>
                            <span class="resolved" data-review-resolved hidden></span>
                          </div>
                          <div class="det">{d.detail}</div>
                          <div class="actions" data-review-deferral-actions>
                            <button class="btn primary notched" data-resolve="handle now">handle now · replan + subtasks</button>
                            <button class="btn" data-resolve="defer">defer · spawn follow-up spec</button>
                            <button class="btn ghost" data-resolve="dismiss">dismiss · won't fix</button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div class="forge-turn" data-review="nudge">
                  {behaviors.length === 0
                    ? "No behaviors to verify on this spec."
                    : `${behaviors.length} behavior(s) left to eyeball. Tick each one as you verify it.`}
                </div>
              </div>
              <div class="forge-input">
                <span class="stamp">鍛</span>
                <input placeholder="type · or click any checkbox above (LLM responses ship Phase 3)" disabled />
                <span class="kbd">↵</span>
              </div>
            </div>

            <PreviewPane detail={detail} />
          </div>
        </div>

        {/* Readiness gate */}
        <div class="readiness" data-review="readiness">
          <span class={`pill ${ciGreen ? "ok" : "warn"}`}><span class="d"></span>{ciGreen ? "ci green" : "ci pending"}</span>
          <span class="pill warn" data-review="pill-verified">
            <span class="d"></span><span data-review="verified-count">0</span> / {behaviors.length} you-verified
          </span>
          <span class="pill warn" data-review="pill-deferred">
            <span class="d"></span>{deferrals.length} deferred · <span data-review="resolved-count">0</span> resolved
          </span>
          <span class="note" data-review="gate-note">· can't sign off until behaviors + deferrals are settled</span>
          <div class="grow">
            <form method="post" action={props.requestChangesHref} style="display:inline">
              <button class="btn danger" type="submit">request changes ↗</button>
            </form>
            <MergeActions mode={props.mergeIntegration} settingsHref={props.settingsHref} />
          </div>
        </div>
      </div>
    </>
  );
}
