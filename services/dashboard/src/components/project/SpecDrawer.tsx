/**
 * Spec drawer + full-page spec view. Clicking any DAG node opens the
 * `SpecDrawerBody` (a slide-in over the canvas), which shows status, the
 * blocked reason, the latest run, acceptance criteria (BDD), dependency chips
 * (depends-on / blocks), and a light economics strip — with routing to
 * run-detail/review and an "open full page ⤢" escalation to `SpecPageBody`.
 * Both read the same `SpecDetail` model. Colours/typography from tokens only.
 *
 * The full page is the depth surface: run history (with when + cost) and an
 * economics panel (spend / attempts / avg cost / status). Uncomputable figures
 * render as "—"; a failed run-list read shows "unavailable", never fake zeros.
 *
 * The drawer body is delivered as an HTML fragment by a dashboard route and
 * injected by the `dag-canvas` island, so node click → drawer needs no extra
 * round-trip beyond the spec read. `data-*` hooks let the island wire close +
 * dependency-chip walking + escalation.
 */

import { timestamp } from "../costs/format.js";
import { PageHead } from "./shared.js";
import type { SpecDepChip, SpecDetail, SpecRunRow } from "./specDetail.js";

function DepChips(props: { chips: SpecDepChip[]; dir: "up" | "down"; projectId: string }) {
  if (props.chips.length === 0) {
    return (
      <span class="dep-none">
        {props.dir === "up" ? "no upstream deps · can start anytime" : "nothing waits on this"}
      </span>
    );
  }
  return (
    <div class="dep-chips">
      {props.chips.map((chip) => (
        <button type="button" class={`dep-chip s-${chip.status}`} data-spec-id={chip.specId}>
          <span class="g">{props.dir === "up" ? "↑" : "↓"}</span>
          {chip.title}
        </button>
      ))}
    </div>
  );
}

function Acceptance(props: { rows: string[] }) {
  if (props.rows.length === 0) {
    return <div class="empty-note">No acceptance criteria recorded.</div>;
  }
  return (
    <div class="spec-bdd">
      {props.rows.map((row, i) => (
        <div>
          <span class="kw">{i === 0 ? "given" : i === 1 ? "when" : "then"}</span> · {row}
        </div>
      ))}
    </div>
  );
}

function LatestRun(props: { run: SpecRunRow }) {
  const inner = (
    <>
      <span class="pill run">
        <span class="d"></span>
        {props.run.runId}
      </span>
      <span class="t">{props.run.outcome.replaceAll("_", " ")}</span>
      <span class="go">↗</span>
    </>
  );
  if (props.run.href === null) return <div class="spec-liverun">{inner}</div>;
  return (
    <a class="spec-liverun" href={props.run.href}>
      {inner}
    </a>
  );
}

/** The slide-in drawer body — injected over the canvas by the island. */
export function SpecDrawerBody(props: { spec: SpecDetail }) {
  const { spec } = props;
  return (
    <div class="spec-scrim" data-spec-scrim>
      <aside class="spec-drawer" data-spec-drawer>
        <div class="spec-drawer-head">
          <div class="row">
            <span class={`pill ${spec.pill}`}>
              <span class="d"></span>
              {spec.statusLabel}
            </span>
            <span class="spec-id">{spec.specId}</span>
            <button type="button" class="spec-x" data-spec-close>
              esc ✕
            </button>
          </div>
          <h2 class="spec-title">{spec.title}</h2>
        </div>
        <div class="spec-drawer-body">
          {spec.blockedReason !== null && (
            <div class="spec-blocked">
              <div class="lbl">⏳ why it's blocked</div>
              <div class="t">{spec.blockedReason}</div>
            </div>
          )}
          {spec.latestRun !== null && <LatestRun run={spec.latestRun} />}
          <div class="spec-block">
            <div class="spec-h">acceptance · bdd</div>
            <Acceptance rows={spec.acceptance} />
          </div>
          <div class="spec-block">
            <div class="spec-h">depends on</div>
            <DepChips chips={spec.dependsOn} dir="up" projectId={spec.projectId} />
          </div>
          <div class="spec-block">
            <div class="spec-h">blocks</div>
            <DepChips chips={spec.blocks} dir="down" projectId={spec.projectId} />
          </div>
          <div class="spec-meta-grid">
            <div>
              <span class="k">spend</span>
              <b>{spec.spendUsd}</b>
            </div>
            <div>
              <span class="k">attempts</span>
              <b>{spec.economics.attempts}</b>
            </div>
            <div>
              <span class="k">status</span>
              <b>{spec.statusLabel}</b>
            </div>
          </div>
        </div>
        <div class="spec-drawer-foot">
          {spec.primaryAction !== null && (
            <a class="btn primary" href={spec.primaryAction.href}>
              {spec.primaryAction.label}
            </a>
          )}
          <a class="btn ghost spec-expand" href={`/projects/${spec.projectId}/specs/${spec.specId}`}>
            open full page ⤢
          </a>
        </div>
      </aside>
    </div>
  );
}

function RunHistory(props: { runs: SpecRunRow[]; available: boolean }) {
  if (!props.available) {
    return (
      <div class="empty-note" data-runs-unavailable>
        Run history unavailable — the orchestrator read failed.
      </div>
    );
  }
  if (props.runs.length === 0) {
    return <div class="empty-note">No runs yet — Forge hasn't started this spec.</div>;
  }
  return (
    <>
      {props.runs.map((run) => {
        const inner = (
          <>
            <div class="top">
              <span class="rid">{run.runId}</span>
              <span class={`oc oc-${run.outcome}`}>{run.outcome.replaceAll("_", " ")}</span>
              <span class="when">{timestamp(run.when)}</span>
            </div>
            <div class="cost">
              {run.costLabel}
              {run.href !== null && <span class="go"> · open ↗</span>}
            </div>
          </>
        );
        if (run.href === null) return <div class={`run-hist${run.live ? " live" : ""}`}>{inner}</div>;
        return (
          <a class={`run-hist${run.live ? " live" : ""}`} href={run.href}>
            {inner}
          </a>
        );
      })}
    </>
  );
}

function EconomicsPanel(props: { spec: SpecDetail }) {
  const { spec } = props;
  if (!spec.runsAvailable) {
    return (
      <div class="empty-note" data-economics-unavailable>
        Economics unavailable — the orchestrator run-list read failed.
      </div>
    );
  }
  const { economics } = spec;
  const spendLabel =
    economics.unpricedAttempts > 0 && economics.pricedAttempts > 0 ? "spend · priced only" : "spend to date";
  const avgLabel = economics.unpricedAttempts > 0 && economics.pricedAttempts > 0 ? "avg / priced" : "avg / attempt";
  return (
    <div class="spec-meta-grid wide" data-economics-panel>
      <div>
        <span class="k">{spendLabel}</span>
        <b>{economics.spendUsd}</b>
      </div>
      <div>
        <span class="k">{avgLabel}</span>
        <b>{economics.avgCostUsd}</b>
      </div>
      <div>
        <span class="k">attempts</span>
        <b>{economics.attempts}</b>
      </div>
      <div>
        <span class="k">status</span>
        <b>{spec.statusLabel}</b>
      </div>
      {economics.unpricedAttempts > 0 && (
        <div class="spec-econ-note" data-unpriced-note>
          {economics.unpricedAttempts} attempt{economics.unpricedAttempts === 1 ? "" : "s"} unpriced · not counted as $0
        </div>
      )}
    </div>
  );
}

/** The escalated full-page spec view. */
export function SpecPageBody(props: { spec: SpecDetail; projectName: string }) {
  const { spec } = props;
  return (
    <div class="p2b spec-page">
      <PageHead
        eyebrow={`▮ spec · ${spec.specId}`}
        title={spec.title}
        actions={
          <>
            <span class={`pill ${spec.pill}`}>
              <span class="d"></span>
              {spec.statusLabel}
            </span>
            <a class="btn ghost" href={`/projects/${spec.projectId}?mode=dag`}>
              ← back to dag
            </a>
            {spec.primaryAction !== null && (
              <a class="btn primary" href={spec.primaryAction.href}>
                {spec.primaryAction.label}
              </a>
            )}
          </>
        }
      />
      <div class="page-body">
        <div class="spec-page-grid">
          <div class="col">
            <div class="panel">
              <div class="panel-head">
                <h3>description</h3>
              </div>
              <div class="panel-body spec-desc">{spec.description}</div>
            </div>
            {spec.blockedReason !== null && (
              <div class="panel">
                <div class="panel-head">
                  <h3>⏳ blocked</h3>
                </div>
                <div class="panel-body spec-desc">{spec.blockedReason}</div>
              </div>
            )}
            <div class="panel">
              <div class="panel-head">
                <h3>acceptance · bdd</h3>
              </div>
              <div class="panel-body">
                <Acceptance rows={spec.acceptance} />
              </div>
            </div>
            <div class="panel">
              <div class="panel-head">
                <h3>dependency chain</h3>
              </div>
              <div class="panel-body spec-dep-rows">
                <div class="dep-row">
                  <span class="dep-label">depends on</span>
                  <DepChips chips={spec.dependsOn} dir="up" projectId={spec.projectId} />
                </div>
                <div class="dep-row">
                  <span class="dep-label">this spec</span>
                  <span class={`dep-chip s-${spec.status} self`}>
                    {spec.glyph} {spec.title}
                  </span>
                </div>
                <div class="dep-row">
                  <span class="dep-label">blocks</span>
                  <DepChips chips={spec.blocks} dir="down" projectId={spec.projectId} />
                </div>
              </div>
            </div>
          </div>
          <div class="col">
            <div class="panel" data-run-history-panel>
              <div class="panel-head">
                <h3>run history</h3>
              </div>
              <div class="panel-body spec-runs">
                <RunHistory runs={spec.runs} available={spec.runsAvailable} />
              </div>
            </div>
            <div class="panel" data-economics-section>
              <div class="panel-head">
                <h3>economics</h3>
              </div>
              <div class="panel-body">
                <EconomicsPanel spec={spec} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
