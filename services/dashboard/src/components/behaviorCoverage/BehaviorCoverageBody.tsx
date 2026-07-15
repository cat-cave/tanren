import type { AffectedSelection, AffectedTargetKind, BehaviorCoverageSnapshot } from "../../api/behaviorCoverage.js";
import { CsrfField } from "../shell/CsrfField.js";
import { BEHAVIOR_COVERAGE_SCREEN_CSS } from "./styles.js";

const TARGET_KINDS: AffectedTargetKind[] = ["spec", "source", "component", "integration", "design"];

export interface BehaviorCoverageBodyProps {
  snapshot: BehaviorCoverageSnapshot | undefined;
  selection?: AffectedSelection;
  projectId: string;
  projectName: string;
  csrfToken?: string;
  error?: string;
  missingProject: boolean;
}

function reasonText(reason: AffectedSelection["selected"][number]["reasons"][number]): string {
  switch (reason.kind) {
    case "direct_edge":
      return `direct ${reason.target.kind}:${reason.target.targetRef} via ${reason.edgeId}`;
    case "transitive_dependency":
      return `depends on ${reason.dependencyBehaviorRevisionId} via ${reason.edgeId}`;
    case "unknown_target":
      return `unknown ${reason.target.kind}:${reason.target.targetRef}`;
    case "uncovered_behavior":
      return "coverage missing — selected fail-closed";
    case "dangling_dependency":
      return `missing dependency ${reason.targetRef} via ${reason.edgeId}`;
    case "no_changed_targets":
      return "no changed targets supplied — selected fail-closed";
  }
  throw new Error("unreachable affected-selection reason");
}

function SelectionResult(props: { selection: AffectedSelection }) {
  const selection = props.selection;
  return (
    <section class="panel" aria-label="affected selection result">
      <div class="panel-pad">
        <div class="mini-eyebrow">durable affected-selection fact · {selection.analysisId}</div>
        {selection.mode === "targeted" ? null : (
          <div class="alert" role="alert">
            <b>{selection.mode.replaceAll("_", " ")}</b> — selection widened because exact coverage could not be proven.
            No behavior was skipped on an unknown.
          </div>
        )}
        <div class="summary">
          <div class="stat">
            <b>{selection.selected.length}</b>
            <span>selected</span>
          </div>
          <div class="stat">
            <b>{selection.excluded.length}</b>
            <span>excluded with proof</span>
          </div>
          <div class="stat">
            <b>{selection.unknownTargets.length}</b>
            <span>unknown targets</span>
          </div>
        </div>
        <div class="result-list">
          {selection.selected.map((behavior) => (
            <div class="result-row">
              <span class="tag">selected</span>
              <code>{behavior.behaviorRevisionId}</code>
              {behavior.reasons.map((reason) => (
                <span>{reasonText(reason)}</span>
              ))}
            </div>
          ))}
          {selection.excluded.map((behavior) => (
            <div class="result-row">
              <span class="tag">excluded</span>
              <code>{behavior.behaviorRevisionId}</code>
              <span>no reachable changed target</span>
              <code>inspected: {behavior.inspectedEdgeIds.join(", ")}</code>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function CoverageMatrix(props: { snapshot: BehaviorCoverageSnapshot }) {
  const uncovered = new Set(props.snapshot.uncoveredBehaviorRevisionIds);
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">active behavior revisions · persisted coverage edges</div>
        {props.snapshot.behaviors.length === 0 ? (
          <div class="alert" role="alert">
            <b>No active behavior revisions.</b> A selection cannot prove product coverage until behavior revisions
            exist.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>behavior</th>
                <th>coverage edges</th>
              </tr>
            </thead>
            <tbody>
              {props.snapshot.behaviors.map((behavior) => (
                <tr>
                  <td>
                    <div>{behavior.title}</div>
                    <code>{behavior.behaviorRevisionId}</code>
                    {uncovered.has(behavior.behaviorRevisionId) ? (
                      <div class="tag warn">uncovered · fail-closed</div>
                    ) : null}
                  </td>
                  <td>
                    <div class="edge-list">
                      {behavior.edges.length === 0 ? (
                        <span>no persisted edges</span>
                      ) : (
                        behavior.edges.map((edge) => (
                          <div class="edge">
                            <span class="tag">{edge.kind}</span>
                            <code>{edge.targetRef}</code>
                          </div>
                        ))
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}

export function BehaviorCoverageBody(props: BehaviorCoverageBodyProps) {
  const edgeCount = props.snapshot?.behaviors.reduce((sum, behavior) => sum + behavior.edges.length, 0) ?? 0;
  return (
    <>
      <style data-screen="behavior-coverage" dangerouslySetInnerHTML={{ __html: BEHAVIOR_COVERAGE_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ project · runtime verification · {props.projectName || "not found"}</div>
          <div class="page-title">behavior coverage</div>
          <div class="sub">prove what changed, select everything when certainty is missing</div>
        </div>
      </div>
      <div class="page-body">
        <div class="behavior-coverage-screen">
          {props.error === undefined ? null : (
            <div class="alert" role="alert">
              <b>Selection unavailable.</b> {props.error}
            </div>
          )}
          {props.missingProject ? (
            <section class="panel">
              <div class="empty">This project is not visible in the active organization.</div>
            </section>
          ) : props.snapshot === undefined ? (
            <section class="panel">
              <div class="empty">Coverage facts unavailable — no counts or safe skips are inferred.</div>
            </section>
          ) : (
            <>
              <section class="panel">
                <div class="panel-pad">
                  <div class="mini-eyebrow">coverage posture</div>
                  <div class="summary">
                    <div class="stat">
                      <b>{props.snapshot.behaviors.length}</b>
                      <span>active behaviors</span>
                    </div>
                    <div class="stat">
                      <b>{edgeCount}</b>
                      <span>persisted edges</span>
                    </div>
                    <div class="stat">
                      <b>{props.snapshot.uncoveredBehaviorRevisionIds.length}</b>
                      <span>uncovered</span>
                    </div>
                  </div>
                </div>
              </section>
              <CoverageMatrix snapshot={props.snapshot} />
              <section class="panel">
                <div class="panel-pad">
                  <div class="mini-eyebrow">affected-selection probe · durable fact required</div>
                  <form
                    method="post"
                    action={`/projects/${encodeURIComponent(props.projectId)}/behavior-coverage/analyze`}
                  >
                    <CsrfField token={props.csrfToken} />
                    <label>
                      target kind
                      <select name="targetKind" required>
                        {TARGET_KINDS.map((kind) => (
                          <option value={kind}>{kind}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      changed target reference
                      <input name="targetRef" required maxlength={2000} placeholder="src/engine/example.ts" />
                    </label>
                    <button type="submit">analyze impact</button>
                  </form>
                </div>
              </section>
              {props.selection === undefined ? null : <SelectionResult selection={props.selection} />}
            </>
          )}
        </div>
      </div>
    </>
  );
}
