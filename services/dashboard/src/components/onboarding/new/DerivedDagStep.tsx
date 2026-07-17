/**
 * step 2 of the greenfield track: the DERIVED SPEC DAG. After the
 * interview completes, the capture is derived into a real project's product
 * graph (personas/behaviors/milestones/specs) via the orchestrator. This step
 * renders that graph using the `DagCanvas` over the same `ProjectDag`
 * read the project view uses — the DAG here is not a mock, it is the live graph
 * that was just derived (click-to-inspect, group-by, zoom all come for free).
 */

import type { ProjectDag } from "../../../api/projectDag.js";
import { DagCanvas } from "../../project/DagCanvas.js";
import { DagStyles } from "../../project/dagStyles.js";
import { CsrfField } from "../../shell/CsrfField.js";

export interface DerivedDagStepProps {
  projectId: string;
  projectName: string;
  dag?: ProjectDag;
  /** Session CSRF for pure HTML form posts (cookie-authenticated writes). */
  csrfToken?: string;
}

export function DerivedDagStep(props: DerivedDagStepProps) {
  const { dag } = props;
  const ready = dag?.nodes.filter((n) => !n.onCriticalPath && n.status === "queued").length ?? 0;
  const unavailable = dag === undefined;
  return (
    <>
      <DagStyles />
      <div class="step-heading">
        <div>
          <div class="eyebrow">step 2 · spec dag · forge derived from the interview</div>
          <div class="title">
            the engine <em>emerges</em>
          </div>
          <div class="sub">
            {unavailable
              ? "the project was derived, but the live dag read is unavailable. reload or retry when the orchestrator is reachable."
              : `${dag.counts.total} specs across ${dag.milestones.length} milestones · each tied to a behavior from step 1. click any node to inspect.`}
          </div>
        </div>
        <span class={`pill ${unavailable ? "warn" : "ok"}`}>
          <span class="d"></span>derived from interview
        </span>
      </div>

      <div class="gf-dag-frame" data-derived-dag>
        {unavailable ? (
          <div class="gf-dag-empty unavailable" data-derived-dag-unavailable>
            spec DAG unavailable — the orchestrator read failed. This is not an empty project.
          </div>
        ) : dag.nodes.length === 0 ? (
          <div class="gf-dag-empty">no specs derived yet — finish the interview to seed the dag.</div>
        ) : (
          <DagCanvas dag={dag} projectId={props.projectId} />
        )}
      </div>

      <form method="post" action="/onboarding/new?step=3" data-derived-summary>
        <CsrfField token={props.csrfToken} />
        <input type="hidden" name="projectId" value={props.projectId} />
        <input type="hidden" name="phase" value="advance" />
        <div class="gf-foot">
          <span class="hint">
            {unavailable
              ? "dag read unavailable · arrival is paused until the live graph loads"
              : `↑ ${dag.counts.behaviors} behaviors covered · ${dag.counts.criticalPath} on the critical path · ${ready} leaf specs ready`}
          </span>
          <span class="spacer">
            <button type="submit" class="btn primary" disabled={unavailable}>
              next · sources &amp; arrival ↗
            </button>
          </span>
        </div>
      </form>
    </>
  );
}
