/**
 * Spec creation surface. A schema-bound form — NO free-text JSON
 * editor — that lets the operator pick a milestone, tag behaviors, write a
 * description + acceptance criteria, and optionally declare spec dependencies.
 * Fields map 1:1 onto the `SpecCreateSchema` (title, description,
 * acceptanceCriteria[], dependsOn[]) plus the milestone/behavior
 * associations carried as form fields the route handler forwards.
 *
 * The form POSTs to `/projects/:projectId/specs` (this spec's own route),
 * which calls the typed orchestrator client. Repository target is locked to
 * the project's repo (rendered read-only).
 */

import type { BehaviorSummary, MilestoneSummary, ProjectSummary, SpecSummary } from "../../api/types.js";
import { ScreenStyles } from "./screenStyles.js";
import { PageHead } from "./shared.js";

export interface SpecCreateBodyProps {
  project: ProjectSummary;
  milestones: MilestoneSummary[];
  behaviors: BehaviorSummary[];
  specs: SpecSummary[];
  /** Set when a prior submit failed; rendered as an inline error banner. */
  error?: string;
  /** Echo back operator input on validation failure. */
  values?: {
    title?: string;
    description?: string;
    acceptanceCriteria?: string[];
    milestoneId?: string;
  };
}

export function SpecCreateBody(props: SpecCreateBodyProps) {
  const values = props.values ?? {};
  const acRows =
    values.acceptanceCriteria && values.acceptanceCriteria.length > 0 ? values.acceptanceCriteria : ["", "", ""];
  return (
    <div class="p2b">
      <ScreenStyles />
      <PageHead
        eyebrow={`▮ project · ${props.project.name}`}
        title={
          <>
            create a <em>spec</em>
          </>
        }
        sub={<>schema-bound · attaches to a milestone &amp; behaviors · no raw config</>}
        actions={
          <a class="btn ghost" href={`/projects/${props.project.projectId}/specs`}>
            ← spec list
          </a>
        }
      />
      <div class="page-body">
        {props.error !== undefined && <div class="form-error">{props.error}</div>}
        <div class="panel">
          <div class="panel-head">
            <h3>
              spec · <em>identity &amp; intent</em>
            </h3>
            <span class="meta">all fields validate against the P2A-0018 spec schema</span>
          </div>
          <div class="panel-body">
            <form method="post" action={`/projects/${props.project.projectId}/specs`}>
              <div class="form-field">
                <label for="title">
                  title <span class="req">*</span>
                </label>
                <input
                  type="text"
                  id="title"
                  name="title"
                  required
                  value={values.title ?? ""}
                  placeholder="e.g. supplier scorecard export"
                />
              </div>

              <div class="form-field">
                <label for="repo">repository target (locked)</label>
                <input type="text" id="repo" name="repo" value={props.project.repoUrl} readonly disabled />
                <div class="hint">specs are scoped to the project repo · cannot be retargeted in v0</div>
              </div>

              <div class="form-field">
                <label for="milestone">milestone</label>
                <select id="milestone" name="milestoneId">
                  <option value="">— unassigned —</option>
                  {props.milestones.map((milestone) => (
                    <option value={milestone.id} selected={values.milestoneId === milestone.id}>
                      {milestone.label} · {milestone.name}
                    </option>
                  ))}
                </select>
                {props.milestones.length === 0 && (
                  <div class="hint">no milestones yet · create one in project settings</div>
                )}
              </div>

              <div class="form-field">
                <label for="description">
                  description <span class="req">*</span>
                </label>
                <textarea id="description" name="description" required placeholder="what this spec delivers and why">
                  {values.description ?? ""}
                </textarea>
              </div>

              <div class="form-field">
                <label>
                  acceptance criteria <span class="req">*</span>
                </label>
                <div class="ac-list">
                  {acRows.map((value, index) => (
                    <input
                      type="text"
                      name="acceptanceCriteria"
                      value={value}
                      placeholder={`criterion ${index + 1}`}
                      required={index === 0}
                    />
                  ))}
                </div>
                <div class="hint">at least one criterion required · each line is a discrete check</div>
              </div>

              <div class="form-field">
                <label>tag behaviors</label>
                {props.behaviors.length === 0 ? (
                  <div class="hint">no behaviors defined for this project yet (P2A-0018)</div>
                ) : (
                  <div class="checkbox-list">
                    {props.behaviors.map((behavior) => (
                      <label>
                        <input type="checkbox" name="behaviorIds" value={behavior.id} />
                        <span>
                          {behavior.title}
                          {behavior.description !== null && behavior.description !== ""
                            ? ` · ${behavior.description}`
                            : ""}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div class="form-field">
                <label>spec dependencies (optional)</label>
                {props.specs.length === 0 ? (
                  <div class="hint">no other specs to depend on yet</div>
                ) : (
                  <div class="checkbox-list">
                    {props.specs.map((spec) => (
                      <label>
                        <input type="checkbox" name="dependsOn" value={spec.specId} />
                        <span>
                          {spec.title} <span class="hint">({spec.status})</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <div class="head-actions">
                <button class="btn primary" type="submit">
                  create spec
                </button>
                <a class="btn ghost" href={`/projects/${props.project.projectId}`}>
                  cancel
                </a>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Spec list per project — filterable, each row links to its current run. */
export function SpecListBody(props: {
  project: ProjectSummary;
  specs: SpecSummary[];
  runBySpec: Record<string, string | undefined>;
  /** Set when a prior run-trigger failed; shown inline on the row. */
  error?: string;
  /** The spec id the trigger error belongs to. */
  errorSpecId?: string;
}) {
  return (
    <div class="p2b">
      <ScreenStyles />
      <PageHead
        eyebrow={`▮ project · ${props.project.name}`}
        title={
          <>
            project <em>specs</em>
          </>
        }
        actions={
          <a class="btn primary" href={`/projects/${props.project.projectId}/specs/new`}>
            + new spec
          </a>
        }
      />
      <div class="page-body">
        <div class="panel">
          <div class="panel-head">
            <h3>
              specs · <em>{props.specs.length}</em>
            </h3>
            <span class="meta">click a row to open its most-recent run</span>
          </div>
          <div class="panel-body">
            {props.specs.length === 0 ? (
              <div class="empty-note">No specs yet. Create one to start forging.</div>
            ) : (
              props.specs.map((spec) => {
                const runId = props.runBySpec[spec.specId];
                const href =
                  runId === undefined
                    ? `/projects/${props.project.projectId}/specs/new`
                    : `/projects/${props.project.projectId}/runs/${runId}`;
                const showError = props.error !== undefined && props.errorSpecId === spec.specId;
                return (
                  <>
                    {showError && <div class="row-error">{props.error}</div>}
                    <div class="spec-row-wrap">
                      <a class="spec-row" href={href}>
                        <span class={`status st-${spec.status}`}>{spec.status}</span>
                        <div>
                          <div class="t">{spec.title}</div>
                          <div class="d">
                            {spec.acceptanceCriteria.length} criteria · {spec.dependsOn.length} deps
                          </div>
                        </div>
                        <span class="d">{runId === undefined ? "no runs" : "run ↗"}</span>
                        <span class="arrow" style="color:var(--ember-08)">
                          ↗
                        </span>
                      </a>
                      <form
                        class="run-trigger"
                        method="post"
                        action={`/projects/${props.project.projectId}/specs/${spec.specId}/run`}
                      >
                        <button class="btn ghost" type="submit" title="start a live run from this spec">
                          ▶ start a run
                        </button>
                      </form>
                    </div>
                  </>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
