/**
 * ReviewBody — the review-handoff sub-surface, reachable from the
 * run detail. Recreated from the hi-fi `view-review.jsx`:
 *   - page head (PR + repo eyebrow, "review with forge", spec/change sub-line)
 *   - Forge review chat (left): opening narration, clickable behavior checklist,
 *     writer-deferred items with handle/defer/dismiss actions, a live nudge turn
 *   - preview pane (right): live preview-deploy iframe at a per-PR
 *     preview URL, device-width tabs (desktop/tablet/mobile), open ↗, and a
 *     graceful empty state when no preview URL is configured/available
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
import { CsrfField } from "../shell/CsrfField.js";
import {
  summarizeCosts,
  formatUsd,
  reviewMergeStateFromEvents,
  type ForgeReviewPublicationView,
  type ReviewMergeState,
} from "./model.js";
import { RUN_DETAIL_CSS } from "./runDetail.css.js";

/** The four merge-integration modes (mirrors MergeIntegration). */
export type MergeIntegration = "native_queue" | "direct_merge" | "external_reviewer" | "not_configured";

export interface ReviewDeferral {
  /** Stable key (the source event id) so the island can address it. */
  id: string;
  tag: string;
  title: string;
  detail: string;
}

export interface ReviewBodyProps {
  detail: RunDetail;
  /** Resolved per-repo merge integration. Defaults to not_configured. */
  mergeIntegration: MergeIntegration;
  /** Path back to the run detail. */
  runHref: string;
  /** Dashboard route that records a request-changes action. */
  requestChangesHref: string;
  /** Dashboard route that drives the operator merge/hand-off sign-off. */
  signOffHref: string;
  /** Project settings link (for the not_configured branch). */
  settingsHref: string;
  /**
   * the per-PR preview-deploy URL for the live iframe, derived from the
   * project's `previewUrlPattern` + run state. `null` when no pattern is
   * configured / no PR exists yet — the preview pane renders its empty state.
   */
  previewUrl: string | null;
  /** Session CSRF for pure HTML form posts. */
  csrfToken?: string;
}

/** Human label + pill class for the derived review/merge phase. */
function reviewMergePill(state: ReviewMergeState): {
  label: string;
  cls: "ok" | "warn" | "danger";
} {
  switch (state.phase) {
    case "merged":
      return {
        label: `merged${state.mergeSha ? ` · ${state.mergeSha.slice(0, 7)}` : ""}`,
        cls: "ok",
      };
    case "approved":
      return { label: "review approved", cls: "ok" };
    case "merge_queued":
      return {
        label: `merge queued${state.integration ? ` · ${state.integration}` : ""}`,
        cls: "warn",
      };
    case "review_requested":
      return { label: "review requested", cls: "warn" };
    case "changes_requested":
      return { label: "changes requested", cls: "danger" };
    case "merge_conflict":
      return { label: "merge conflict", cls: "danger" };
    case "merge_failed":
      return { label: "merge failed", cls: "danger" };
    default:
      return { label: "review pending", cls: "warn" };
  }
}

/**
 * gv-2: render internal verdict beside forge ID/state/link/head.
 * Missing or partial forge fields are LOUD (warn/danger) — never green success.
 */
export function ForgePublicationPanel(props: {
  phase: ReviewMergeState["phase"];
  publication: ForgeReviewPublicationView | undefined;
}) {
  const terminal = props.phase === "approved" || props.phase === "changes_requested";
  if (!terminal && props.publication === undefined) {
    return null;
  }
  const pub = props.publication;
  if (pub === undefined) {
    return (
      <div class="forge-turn" data-review="forge-publication" data-state="unpublished">
        <h4 style="color: var(--status-warn)">forge publication · unpublished</h4>
        <div style="font-size:12px; color: var(--fg-2); line-height:1.5">
          Terminal review has no durable forge receipt (id / state / link / head). Do not treat this as forge-approved.
        </div>
      </div>
    );
  }
  if (!pub.complete) {
    return (
      <div class="forge-turn" data-review="forge-publication" data-state="malformed">
        <h4 style="color: var(--status-danger)">forge publication · incomplete receipt</h4>
        <div style="font-size:12px; color: var(--fg-2); line-height:1.5">
          Partial forge fields present — refusing to paint success. id={pub.forgeReviewId ?? "—"} state=
          {pub.forgeReviewState ?? "—"} head={pub.headSha?.slice(0, 7) ?? "—"}
        </div>
      </div>
    );
  }
  return (
    <div class="forge-turn" data-review="forge-publication" data-state="published">
      <h4 style="color: var(--ember-08)">forge publication · {pub.forgeReviewState}</h4>
      <div style="font-size:12px; color: var(--fg-2); line-height:1.6">
        <div>
          reviewer · <b data-review="forge-reviewer">{pub.reviewer ?? "—"}</b>
        </div>
        <div>
          forge id · <code data-review="forge-review-id">{pub.forgeReviewId}</code>
        </div>
        <div>
          head · <code data-review="forge-head-sha">{pub.headSha?.slice(0, 12)}</code>
        </div>
        <div>
          <a
            href={pub.forgeReviewUrl}
            target="_blank"
            rel="noreferrer"
            data-review="forge-review-link"
            style="color: var(--ember-08)"
          >
            open forge review ↗
          </a>
        </div>
      </div>
    </div>
  );
}

/** Pull writer-deferral items out of the run's typed events (no stdout parsing). */
export function deferralsFromEvents(events: RunEventRow[]): ReviewDeferral[] {
  const out: ReviewDeferral[] = [];
  for (const event of events) {
    const isDeferral =
      event.eventType.includes("defer") ||
      event.eventType.includes("followup") ||
      event.eventType.includes("follow_up");
    if (!isDeferral) continue;
    const payload =
      typeof event.payload === "object" && event.payload !== null ? (event.payload as Record<string, unknown>) : {};
    const title =
      typeof payload["title"] === "string"
        ? payload["title"]
        : typeof payload["summary"] === "string"
          ? payload["summary"]
          : event.eventType;
    const detail =
      typeof payload["detail"] === "string"
        ? payload["detail"]
        : typeof payload["reason"] === "string"
          ? payload["reason"]
          : "Deferred by the writer during the run.";
    const tag = typeof payload["tag"] === "string" ? payload["tag"] : "deferred";
    out.push({ id: String(event.id), tag, title, detail });
  }
  return out;
}

function prNumberFromUrl(url: string | null): string {
  if (url === null) return "pr";
  const match = /\/pull\/(\d+)/u.exec(url);
  return match?.[1] === undefined ? "pr" : `pr #${match[1]}`;
}

function repoFromUrl(url: string | null): string {
  if (url === null) return "repo";
  const match = /github\.com\/([^/]+\/[^/]+)/u.exec(url);
  return match?.[1] ?? "repo";
}

// The sign-off CTA drives the merge stage through its per-repo
// integration. The gesture posts to `signOffHref`; the orchestrator dispatches
// to the configured integration (direct merge / native merge queue / external-
// reviewer hand-off). `not_configured` has no merge path — only a settings link.
function MergeActions(props: {
  mode: MergeIntegration;
  settingsHref: string;
  signOffHref: string;
  done: boolean;
  csrfToken: string | undefined;
}) {
  if (props.mode === "not_configured") {
    return (
      <span class="merge-note">
        repo has no merge integration · <a href={props.settingsHref}>configure ↗</a>
      </span>
    );
  }
  if (props.done) {
    return <span class="merge-note">merge stage complete · see status above</span>;
  }
  const label =
    props.mode === "external_reviewer"
      ? "approve · notify reviewer"
      : props.mode === "direct_merge"
        ? "sign off · merge now ↗"
        : "sign off · queue the merge";
  return (
    <form method="post" action={props.signOffHref} style="display:inline">
      <CsrfField token={props.csrfToken} />
      <button class="btn primary notched" type="submit" data-review="signoff">
        {label}
      </button>
    </form>
  );
}

// the live preview-deploy pane. When the project declares a
// `previewUrlPattern`, we render a sandboxed iframe at the per-PR preview URL
// with device-width tabs (the `review` island swaps the iframe's max-width).
// The iframe is `sandbox`ed (scripts only, same-origin denied) so a hostile
// preview deploy can't reach the dashboard session. When no preview URL is
// available we render a graceful empty state pointing at project settings.
function PreviewPane(props: { detail: RunDetail; previewUrl: string | null; settingsHref: string }) {
  const { previewUrl } = props;
  return (
    <div class="preview" data-review="preview">
      <div class="head">
        <span class="moment-eyebrow" style="font-size:9.5px">
          preview
        </span>
        <span class="url">{previewUrl ?? "no preview url configured"}</span>
        <div class="device-tabs" data-review="device-tabs">
          <button class="active" data-device="desktop" data-width="none">
            desktop
          </button>
          <button data-device="tablet" data-width="768px">
            tablet
          </button>
          <button data-device="mobile" data-width="375px">
            mobile
          </button>
        </div>
        {previewUrl === null ? null : (
          <a class="btn" href={previewUrl} target="_blank" rel="noreferrer" style="font-size:11px">
            open ↗
          </a>
        )}
      </div>
      <div class="frame">
        {previewUrl === null ? (
          <div class="placeholder-frame" data-review="preview-empty" style="max-width:none">
            <div class="pl-title">no live preview for this run</div>
            <div class="pl-note">
              This project has no preview-deploy URL configured, or this run has no PR yet. Set a{" "}
              <code>previewUrlPattern</code> (e.g. <code>https://pr-{"{pr}"}.preview.fly.dev</code>) in{" "}
              <a href={props.settingsHref}>project settings ↗</a> to see the PR's deploy here.
              {props.detail.run.prUrl === null ? null : (
                <>
                  <br />
                  <a href={props.detail.run.prUrl} target="_blank" rel="noreferrer">
                    open the PR on github ↗
                  </a>
                </>
              )}
            </div>
          </div>
        ) : (
          <iframe
            class="preview-iframe"
            data-review="preview-frame"
            src={previewUrl}
            title="live preview deploy"
            loading="lazy"
            sandbox="allow-scripts allow-forms allow-popups"
            referrerpolicy="no-referrer"
            style="max-width:none"
          ></iframe>
        )}
      </div>
      <div class="rd-foot">
        {previewUrl === null
          ? "live preview deploy · configure a preview url to enable"
          : "3 device sizes · sandboxed live preview deploy"}
      </div>
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
  // derive the live review/merge phase from the run's typed events.
  const reviewState = reviewMergeStateFromEvents(detail.recentEvents);
  const reviewPill = reviewMergePill(reviewState);
  const mergeDone = reviewState.phase === "merged" || reviewState.phase === "merge_queued";

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
            <div class="eyebrow">
              ▮ {prNumberFromUrl(detail.run.prUrl)} · {repoFromUrl(detail.run.prUrl)}
            </div>
            <div class="page-title">review with forge</div>
            <div class="sub">
              {detail.spec.title} · forged by {forgedBy} · {formatUsd(totals.perTokenUsd)}
            </div>
          </div>
          <div class="rd-actions">
            <a class="btn ghost" href={props.runHref}>
              ← back to run
            </a>
            {detail.run.prUrl === null ? null : (
              <a class="btn" href={detail.run.prUrl} target="_blank" rel="noreferrer">
                open pr on github ↗
              </a>
            )}
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
                          <div class="t">
                            <b>b{i + 1}</b>
                            {b}
                          </div>
                          <span class="ci">ci {ciGreen ? "✓" : "—"}</span>
                          <span class="you" data-review-you>
                            you ○
                          </span>
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
                            <button class="btn primary notched" data-resolve="handle now">
                              handle now · replan + subtasks
                            </button>
                            <button class="btn" data-resolve="defer">
                              defer · spawn follow-up spec
                            </button>
                            <button class="btn ghost" data-resolve="dismiss">
                              dismiss · won't fix
                            </button>
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

                <ForgePublicationPanel phase={reviewState.phase} publication={reviewState.forgePublication} />
              </div>
              <div class="forge-input">
                <span class="stamp">鍛</span>
                <input placeholder="type · or click any checkbox above (LLM responses ship Phase 3)" disabled />
                <span class="kbd">↵</span>
              </div>
            </div>

            <PreviewPane detail={detail} previewUrl={props.previewUrl} settingsHref={props.settingsHref} />
          </div>
        </div>

        {/* Readiness gate */}
        <div class="readiness" data-review="readiness">
          <span class={`pill ${reviewPill.cls}`} data-review="phase">
            <span class="d"></span>
            {reviewPill.label}
          </span>
          <span class={`pill ${ciGreen ? "ok" : "warn"}`}>
            <span class="d"></span>
            {ciGreen ? "ci green" : "ci pending"}
          </span>
          <span class="pill warn" data-review="pill-verified">
            <span class="d"></span>
            <span data-review="verified-count">0</span> / {behaviors.length} you-verified
          </span>
          <span class="pill warn" data-review="pill-deferred">
            <span class="d"></span>
            {deferrals.length} deferred · <span data-review="resolved-count">0</span> resolved
          </span>
          <span class="note" data-review="gate-note">
            · can't sign off until behaviors + deferrals are settled
          </span>
          <div class="grow">
            <form method="post" action={props.requestChangesHref} style="display:inline">
              <CsrfField token={props.csrfToken} />
              <button class="btn danger" type="submit">
                request changes ↗
              </button>
            </form>
            <MergeActions
              mode={props.mergeIntegration}
              settingsHref={props.settingsHref}
              signOffHref={props.signOffHref}
              done={mergeDone}
              csrfToken={props.csrfToken}
            />
          </div>
        </div>
      </div>
    </>
  );
}
