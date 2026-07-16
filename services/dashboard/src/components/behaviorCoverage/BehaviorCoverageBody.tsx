import type { AffectedSelection, AffectedTargetKind, BehaviorCoverageOverview } from "../../api/behaviorCoverage.js";
import { CsrfField } from "../shell/CsrfField.js";
import { BEHAVIOR_COVERAGE_SCREEN_CSS } from "./styles.js";

const TARGET_KINDS: AffectedTargetKind[] = ["spec", "source", "component", "integration", "design"];

export interface BehaviorCoverageBodyProps {
  readonly overview: BehaviorCoverageOverview | undefined;
  readonly selection?: AffectedSelection;
  readonly projectId: string;
  readonly projectName: string;
  readonly csrfToken?: string;
  readonly error?: string;
  readonly replayNotice?: string;
  readonly missingProject: boolean;
}

function assertNever(value: never): never {
  throw new Error(`unreachable affected-selection reason: ${String(value)}`);
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
  return assertNever(reason);
}

function SelectionResult(props: {
  readonly selection: AffectedSelection;
  readonly projectId: string;
  readonly csrfToken?: string;
}) {
  const { selection } = props;
  return (
    <section class="panel" aria-label="affected selection result" data-analysis-id={selection.analysisId}>
      <div class="panel-pad">
        <div class="mini-eyebrow">immutable affected-selection fact · {selection.analysisId}</div>
        <div class="binding" data-integration-node={selection.binding.integrationNodeId}>
          <span>node · {selection.binding.integrationNodeId}</span>
          <code>base · {selection.binding.baseSha}</code>
          <code>head · {selection.binding.preparedHeadSha}</code>
          <code>tree · {selection.binding.treeHash}</code>
          <code>member · {selection.binding.memberKey}</code>
        </div>
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
        <form method="post" action={`/projects/${encodeURIComponent(props.projectId)}/behavior-coverage/verify`}>
          <CsrfField token={props.csrfToken} />
          <input type="hidden" name="analysisId" value={selection.analysisId} />
          <button type="submit">verify fact is current</button>
        </form>
      </div>
    </section>
  );
}

function CoverageMatrix(props: {
  readonly graph: Extract<BehaviorCoverageOverview["graph"], { status: "available" }>;
}) {
  const uncovered = new Set(props.graph.uncoveredBehaviorRevisionIds);
  return (
    <section class="panel">
      <div class="panel-pad">
        <div class="mini-eyebrow">active behavior revisions · persisted coverage edges</div>
        {props.graph.behaviors.length === 0 ? (
          <div class="alert" role="alert">
            <b>No active behavior revisions.</b> This is visible as no coverage, never a passing proof.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>behavior revision</th>
                <th>coverage edges</th>
              </tr>
            </thead>
            <tbody>
              {props.graph.behaviors.map((behavior) => (
                <tr>
                  <td>
                    <div>{behavior.title}</div>
                    <code>{behavior.behaviorRevisionId}</code>
                    <code>{behavior.contentDigest}</code>
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
  const graph = props.overview?.graph;
  const latest = props.overview?.latestSelection;
  const selection = props.selection ?? (latest?.status === "available" ? latest.selection : undefined);
  const edgeCount =
    graph?.status === "available" ? graph.behaviors.reduce((sum, behavior) => sum + behavior.edges.length, 0) : 0;
  return (
    <>
      <style data-screen="behavior-coverage" dangerouslySetInnerHTML={{ __html: BEHAVIOR_COVERAGE_SCREEN_CSS }} />
      <div class="page-head">
        <div>
          <div class="eyebrow">▮ project · runtime verification · {props.projectName || "not found"}</div>
          <div class="page-title">behavior coverage</div>
          <div class="sub">prove what changed; select everything when certainty is missing</div>
        </div>
      </div>
      <div class="page-body">
        <div class="behavior-coverage-screen">
          {props.error === undefined ? null : (
            <div class="alert" role="alert">
              <b>Selection unavailable.</b> {props.error}
            </div>
          )}
          {props.replayNotice === undefined ? null : (
            <div class="alert" role="status">
              {props.replayNotice}
            </div>
          )}
          {props.missingProject ? (
            <section class="panel">
              <div class="empty">This project is not visible in the active organization.</div>
            </section>
          ) : props.overview === undefined ? (
            <section class="panel">
              <div class="empty">Coverage service unavailable — no graph or safe skip is inferred.</div>
            </section>
          ) : (
            <>
              {graph?.status === "available" ? (
                <>
                  <section class="panel">
                    <div class="panel-pad">
                      <div class="mini-eyebrow">coverage posture</div>
                      <div class="summary">
                        <div class="stat">
                          <b>{graph.behaviors.length}</b>
                          <span>active behaviors</span>
                        </div>
                        <div class="stat">
                          <b>{edgeCount}</b>
                          <span>persisted edges</span>
                        </div>
                        <div class="stat">
                          <b>{graph.uncoveredBehaviorRevisionIds.length}</b>
                          <span>uncovered</span>
                        </div>
                      </div>
                    </div>
                  </section>
                  <CoverageMatrix graph={graph} />
                  <section class="panel">
                    <div class="panel-pad">
                      <div class="mini-eyebrow">affected-selection probe · immutable fact required</div>
                      <form
                        method="post"
                        action={`/projects/${encodeURIComponent(props.projectId)}/behavior-coverage/analyze`}
                      >
                        <CsrfField token={props.csrfToken} />
                        <label>
                          integration node
                          <input name="integrationNodeId" required maxlength={200} />
                        </label>
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
                        <button type="submit">analyze and persist</button>
                      </form>
                    </div>
                  </section>
                </>
              ) : (
                <section class="panel">
                  <div class="empty">Current graph unavailable — no counts or exclusions are inferred.</div>
                </section>
              )}
              {latest?.status === "unavailable" ? (
                <section class="panel">
                  <div class="empty">Latest durable selection could not be decoded.</div>
                </section>
              ) : latest?.status === "none" && selection === undefined ? (
                <section class="panel">
                  <div class="empty">No durable selection has been recorded for this project.</div>
                </section>
              ) : null}
              {selection === undefined ? null : (
                <SelectionResult selection={selection} projectId={props.projectId} csrfToken={props.csrfToken} />
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
