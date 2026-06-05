/**
 * brownfield step 4 — spec DAG + issue ingest. Before seeding, offers a
 * "seed" button (POSTs to the route, which calls the orchestrator seed-dag
 * endpoint: recon gaps + open GitHub issues → seed specs, de-duped). After
 * seeding, renders the source legend (issue vs. gap) + the seeded specs.
 * Recreated from the hi-fi `view-onboard-existing` step 4.
 */

import type { ReconReport, SeedDagResult } from "../../../api/existingBrownfieldTypes.js";

export function SeedDagStep(props: {
  repoUrl: string;
  report: ReconReport;
  baseAction: string;
  projectId?: string;
  seeded?: SeedDagResult;
}) {
  return (
    <>
      <div class="step-heading">
        <div>
          <div class="eyebrow">step 4 · spec dag · agent gaps + github issues</div>
          <div class="title">
            seed the <em>dag from reality</em>
          </div>
          <div class="sub">
            the agent's gap analysis becomes seed specs · your open github issues become candidate specs · forge
            de-dupes by title.
          </div>
        </div>
        <div class="right">
          <span class="pill ok">
            <span class="d"></span>seeded from issues + gaps
          </span>
        </div>
      </div>

      <div class="ex-legend">
        <span class="key">
          <span class="swatch"></span> from github issue
        </span>
        <span class="key">
          <span class="swatch gap"></span> from agent gap
        </span>
      </div>

      {props.seeded === undefined ? (
        <form method="post" action={props.baseAction}>
          <input type="hidden" name="phase" value="seed" />
          <input type="hidden" name="step" value="4" />
          <input type="hidden" name="projectId" value={props.projectId ?? ""} />
          <input type="hidden" name="repoUrl" value={props.repoUrl} />
          <input type="hidden" name="report" value={JSON.stringify(props.report)} />
          <div class="col-card live" style="flex-direction:row;align-items:center;gap:12px">
            <div style="font-family:var(--font-ui);font-size:12px;color:var(--fg-1);line-height:1.4;flex:1">
              seed creates pending specs from {props.report.gaps.length} recon gaps + your open github issues. nothing
              runs yet — these queue behind the integration pr.
            </div>
            <button type="submit" class="btn primary">
              seed the dag ↗
            </button>
          </div>
        </form>
      ) : (
        <>
          <div class="alert ok">
            Seeded <b>{props.seeded.seeded.length}</b> specs · {props.seeded.fromIssues} from issues ·{" "}
            {props.seeded.fromGaps} from gaps · {props.seeded.duplicatesDropped} dupes dropped.
          </div>
          <div class="col-card" style="gap:6px">
            <div class="h">
              <span>seed specs</span>
            </div>
            {props.seeded.seeded.map((s) => (
              <div class={`ex-seed-row ${s.source === "agent_gap" ? "gap" : ""}`}>
                <span class="tag">{s.source === "agent_gap" ? "gap" : "issue"}</span>
                <span class="name">{s.title}</span>
                <span class="tag">{s.origin}</span>
              </div>
            ))}
          </div>
          <form method="post" action={props.baseAction}>
            <input type="hidden" name="phase" value="advance" />
            <input type="hidden" name="step" value="4" />
            <input type="hidden" name="projectId" value={props.projectId ?? ""} />
            <input type="hidden" name="repoUrl" value={props.repoUrl} />
            <input type="hidden" name="report" value={JSON.stringify(props.report)} />
            <div class="foot">
              <div class="hint">↑ each spec inherits its priority from the issue label · forge re-routes on demand</div>
              <div class="grow"></div>
              <button type="submit" class="btn primary">
                next · governance ↗
              </button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
