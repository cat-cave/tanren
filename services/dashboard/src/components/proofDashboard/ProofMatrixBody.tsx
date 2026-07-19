// rv-23 — the flagship Project Behavior Proof Matrix: one row per behavior
// revision, with the PREVIEW plane and the PRODUCTION plane surfaced as DISTINCT
// verdicts. "Reachable" and "behavior proven" are distinct: a behavior with no
// verdict, or a missing preview/production cell, renders `unproven` (unknown),
// never green. A quarantined behavior is flagged and can never read as passed.
import type { BehaviorProofMatrix } from "../../api/proofDashboard.js";
import { OutcomePill, shortHash, SurfaceUnavailable } from "./helpers.js";
import { PROOF_DASHBOARD_CSS } from "./styles.js";

export interface ProofMatrixBodyProps {
  readonly matrix: BehaviorProofMatrix | undefined;
  readonly projectId: string;
  readonly missingProject: boolean;
}

function base(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/behavior-proof`;
}

export function ProofMatrixBody(props: ProofMatrixBodyProps) {
  const { matrix, projectId } = props;
  const rows = matrix?.rows ?? [];
  const provenCount = rows.filter((r) => r.latestProduction?.outcome === "passed").length;
  return (
    <div class="proof behavior-proof-matrix">
      <style>{PROOF_DASHBOARD_CSS}</style>
      <section class="panel">
        <div class="panel-pad">
          <div class="eyebrow">runtime verification · behavior proof matrix</div>
          <h2>Behavior Proof Matrix</h2>
          <p class="sub">
            One row per behavior revision. Preview and production proof are separate planes — a behavior is only proven
            on a plane when it has a <b>passed</b> verdict there with executed assertions. Empty cells are unproven, not
            passing.
          </p>
          <div class="links">
            <a href={`${base(projectId)}/quarantines`}>flake &amp; quarantine</a>
            <a href={`${base(projectId)}/bisections`}>merge-queue bisections</a>
            <a href={`${base(projectId)}/design-render`}>visual verification</a>
          </div>
        </div>
      </section>

      {matrix === undefined ? (
        <section class="panel">
          <div class="panel-pad">
            <SurfaceUnavailable missingProject={props.missingProject} what="behavior proof matrix" />
          </div>
        </section>
      ) : (
        <section class="panel">
          <div class="panel-pad">
            <div class="summary">
              <div class="stat">
                <b>{rows.length}</b>
                <span>behavior revisions</span>
              </div>
              <div class="stat">
                <b>{provenCount}</b>
                <span>proven in production</span>
              </div>
              <div class="stat">
                <b>{rows.filter((r) => r.quarantined).length}</b>
                <span>quarantined</span>
              </div>
            </div>
            {rows.length === 0 ? (
              <div class="empty">
                No behavior revisions exist for this project yet. Nothing is proven — this is an honest zero, not a
                green state.
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>behavior</th>
                    <th>rev</th>
                    <th>preview</th>
                    <th>production</th>
                    <th>assertions (prod)</th>
                    <th>flake</th>
                    <th>design</th>
                    <th>specs</th>
                    <th>last proven artifact</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr>
                      <td>
                        <a
                          class="row-link"
                          href={`${base(projectId)}/behaviors/${encodeURIComponent(row.behaviorRevisionId)}`}
                        >
                          {row.title === "" ? row.behaviorId : row.title}
                        </a>
                        {row.quarantined ? (
                          <div>
                            <span class="pill warn">quarantined</span>
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <code>{row.revisionNumber}</code>
                      </td>
                      <td>
                        <OutcomePill outcome={row.latestPreview?.outcome ?? null} />
                        {row.latestPreview === null ? null : (
                          <a
                            class="row-link"
                            href={`${base(projectId)}/runs/${encodeURIComponent(row.latestPreview.runId)}`}
                          >
                            {" "}
                            timeline
                          </a>
                        )}
                      </td>
                      <td>
                        <OutcomePill outcome={row.latestProduction?.outcome ?? null} />
                        {row.latestProduction === null ? null : (
                          <a
                            class="row-link"
                            href={`${base(projectId)}/runs/${encodeURIComponent(row.latestProduction.runId)}`}
                          >
                            {" "}
                            timeline
                          </a>
                        )}
                      </td>
                      <td>
                        {row.latestProduction === null ? (
                          <span class="tl-meta">—</span>
                        ) : (
                          <code>
                            {row.latestProduction.executedAssertionCount}/{row.latestProduction.requiredAssertionCount}
                          </code>
                        )}
                      </td>
                      <td>{row.latestProduction === null ? "—" : row.latestProduction.flakeState}</td>
                      <td>
                        <code>{shortHash(row.designContractDigest)}</code>
                      </td>
                      <td>{row.owningSpecIds.length === 0 ? "—" : row.owningSpecIds.join(", ")}</td>
                      <td>
                        {row.lastProvenArtifactDigest === null ? (
                          <span class="pill unknown">none proven</span>
                        ) : (
                          <code>{shortHash(row.lastProvenArtifactDigest)}</code>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
