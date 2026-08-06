/** JSX rendering for the project-view route. */

import type { Context } from "hono";
import { renderShell } from "../../app/mountShell.js";
import { ProjectDagBody, ProjectDagUnavailableBody } from "../../components/project/ProjectDagBody.js";
import { ProjectViewBody } from "../../components/project/ProjectViewBody.js";
import type { ProjectViewLoadResult } from "./projectViewLoader.js";

export function renderProjectView(c: Context, result: ProjectViewLoadResult): Response | Promise<Response> {
  if (result.kind === "not-found") {
    return renderShell(
      c,
      result.ctx,
      { title: `tanren · ${result.projectId}` },
      <div class="p2b">
        <div class="page-head">
          <div>
            <div class="eyebrow">project · not found</div>
            <div class="page-title">project not found</div>
          </div>
        </div>
        <div class="page-body">
          <section class="placeholder-card">
            <p>No project {result.projectId} is visible to you.</p>
          </section>
        </div>
      </div>,
    );
  }

  const { ctx, model, projectId, projectName, orgId, insights } = result;
  const view = (
    <ProjectViewBody
      projectId={projectId}
      projectName={projectName}
      orgId={orgId}
      model={model}
      insights={insights}
      csrfToken={ctx.csrfToken}
    />
  );
  if (result.mode !== "dag") return renderShell(c, ctx, { title: `tanren · ${projectName}` }, view);

  if (result.dag.kind === "available") {
    return renderShell(
      c,
      ctx,
      { title: `tanren · ${projectName} · dag` },
      <ProjectDagBody projectId={projectId} projectName={projectName} dag={result.dag.dag} model={model} />,
    );
  }

  return renderShell(
    c,
    ctx,
    { title: `tanren · ${projectName} · dag` },
    <ProjectDagUnavailableBody projectId={projectId} projectName={projectName} model={model} />,
  );
}
