/**
 * history list body. Renders prior-run history from the run-list
 * filtered run list (`GET .../runs`), with status filter pills. Each row links
 * to the run detail and surfaces the run-level cost total, spec
 * title, outcome badge, and elapsed time. Presentation only.
 */

import { RECOVERABLE_OUTCOMES } from "@tanren/db";
import type { RunListItem } from "../../api/types.js";
import { duration, nullableUsd, timestamp } from "./format.js";
import { COSTS_SCREEN_CSS } from "./styles.js";

export interface HistoryBodyProps {
  runs: RunListItem[];
  /**
   * False when the run-list read failed (transport/HTTP/decode). Distinct from
   * a legitimate empty filter result — never render failure as "no runs".
   */
  runsAvailable?: boolean;
  /** Active status filter (empty = all). */
  status: string;
  orgId: string;
  orgLogin: string;
  /** Project the history is scoped to (run list is project-scoped in). */
  projectId: string;
  projectName: string;
  /** True when the operator has no projects to scope a history list to. */
  noProject: boolean;
}

const STATUS_FILTERS: { id: string; label: string }[] = [
  { id: "", label: "all" },
  { id: "running", label: "running" },
  // The id is the REAL API run status (`completed`), never a synonym like
  // "succeeded" — a value absent from RunStatus matches zero rows and would
  // manufacture an empty filter result. The label stays user-facing.
  { id: "completed", label: "succeeded" },
  { id: "failed", label: "failed" },
];

/** Map a run outcome to a badge class + label. */
function outcomeBadge(run: RunListItem): { cls: string; label: string } {
  if (run.needsReview && run.prUrl !== null) return { cls: "review", label: "needs review" };
  const o = run.outcome;
  if (o === null) return { cls: "", label: run.status };
  // HALTED-outcome policy set imported from @tanren/db — the prior inline literal
  // check was missing `convergence_stalled` + `window_exhausted`, so those halted
  // runs rendered with the neutral badge instead of the halted-red one.
  if (RECOVERABLE_OUTCOMES.has(o)) {
    return { cls: "halted", label: o.replaceAll("_", " ") };
  }
  // `ok` is the canonical merge-ready success outcome (the synthetic
  // `phase*_complete` residue was pruned — no-backcompat).
  if (o === "ok") return { cls: "ok", label: "merged-ready" };
  return { cls: "", label: o.replaceAll("_", " ") };
}

export function HistoryBody(props: HistoryBodyProps) {
  const { runs, status } = props;
  const runsAvailable = props.runsAvailable !== false;
  return (
    <>
      <style data-screen="costs" dangerouslySetInnerHTML={{ __html: COSTS_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ run history · {props.noProject ? props.orgLogin || "org" : props.projectName}</div>
          <div class="page-title">prior runs</div>
          {!props.noProject && runsAvailable && <div class="sub">{runs.length} runs · scoped to this project</div>}
        </div>
        {!props.noProject && (
          <div class="filters">
            {STATUS_FILTERS.map((f) => (
              <a
                class={`pill${f.id === status ? " hot" : ""}`}
                href={`/history?projectId=${encodeURIComponent(props.projectId)}${f.id === "" ? "" : `&status=${f.id}`}`}
              >
                {f.label}
              </a>
            ))}
          </div>
        )}
      </div>
      <div class="page-body">
        <div class="history-screen">
          <section class="panel">
            {props.noProject ? (
              <div class="empty">
                No projects yet. Onboard a repo to start forging — run history appears here once a project has runs.
              </div>
            ) : runsAvailable ? (
              runs.length === 0 ? (
                <div class="empty">No runs match this filter yet.</div>
              ) : (
                <>
                  <div class="run-table-head">
                    <span>spec</span>
                    <span>status</span>
                    <span class="num">cost</span>
                    <span class="num">elapsed</span>
                    <span class="num">started</span>
                    <span class="num">pr</span>
                  </div>
                  <div>
                    {runs.map((run) => {
                      const badge = outcomeBadge(run);
                      const href = `/orgs/${encodeURIComponent(props.orgId)}/projects/${encodeURIComponent(
                        run.projectId,
                      )}/runs/${encodeURIComponent(run.runId)}`;
                      return (
                        <a class="run-row" href={href}>
                          <span>
                            <div class="spec">{run.specTitle}</div>
                            <div class="sub">
                              {run.runId} · {run.trigger}
                            </div>
                          </span>
                          <span>
                            <span class={`badge ${badge.cls}`}>{badge.label}</span>
                          </span>
                          <span class="num">{nullableUsd(run.costTotalUsd)}</span>
                          <span class="num">{duration(run.startedAt, run.endedAt)}</span>
                          <span class="num">{timestamp(run.startedAt)}</span>
                          <span class="num">{run.prUrl === null ? "—" : "open"}</span>
                        </a>
                      );
                    })}
                  </div>
                </>
              )
            ) : (
              <div class="empty" role="alert" data-runs-unavailable>
                Run history unavailable — the orchestrator read failed. This is not an empty project; retry shortly.
              </div>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
