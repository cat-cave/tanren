/**
 * brownfield step 4 — spec DAG + issue ingest. Before seeding, offers a
 * "seed" button (POSTs to the route, which calls the orchestrator seed-dag
 * endpoint: recon gaps + open GitHub issues → seed specs, de-duped). After
 * seeding, renders the source legend (issue vs. gap) + the seeded specs.
 * Recreated from the hi-fi `view-onboard-existing` step 4.
 */

import type { ReconReport, SeedDagResult } from "../../../api/existingBrownfieldTypes.js";
import { CsrfField } from "../../shell/CsrfField.js";

export function SeedDagStep(props: {
  repoUrl: string;
  report: ReconReport;
  state: string;
  baseAction: string;
  projectId?: string;
  seeded?: SeedDagResult;
  error?: string;
  csrfToken?: string;
}) {
  const seeded = props.seeded;
  const error = props.error;
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

      {error ? <div class="alert warn">{error}</div> : null}

      {seeded ? (
        <>
          <div class="alert ok">
            Seeded <b>{seeded.seeded.length}</b> specs · {seeded.fromIssues} from issues · {seeded.fromGaps} from gaps ·{" "}
            {seeded.duplicatesDropped} dupes dropped.
          </div>
          <div class="col-card" style="gap:6px">
            <div class="h">
              <span>seed specs</span>
            </div>
            {seeded.seeded.map((s) => (
              <div class={`ex-seed-row ${s.source === "agent_gap" ? "gap" : ""}`}>
                <span class="tag">{s.source === "agent_gap" ? "gap" : "issue"}</span>
                <span class="name">{s.title}</span>
                <span class="tag">{s.origin}</span>
              </div>
            ))}
          </div>
          <form method="post" action={props.baseAction}>
            <CsrfField token={props.csrfToken} />
            <input type="hidden" name="phase" value="advance" />
            <input type="hidden" name="step" value="4" />
            <input type="hidden" name="projectId" value={props.projectId ?? ""} />
            <input type="hidden" name="state" value={props.state} />
            <div class="foot">
              <div class="hint">↑ each spec inherits its priority from the issue label · forge re-routes on demand</div>
              <div class="grow"></div>
              <button type="submit" class="btn primary">
                next · governance ↗
              </button>
            </div>
          </form>
        </>
      ) : (
        <form method="post" action={props.baseAction}>
          <CsrfField token={props.csrfToken} />
          <input type="hidden" name="phase" value="seed" />
          <input type="hidden" name="step" value="4" />
          <input type="hidden" name="projectId" value={props.projectId ?? ""} />
          <input type="hidden" name="state" value={props.state} />
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
      )}
    </>
  );
}
