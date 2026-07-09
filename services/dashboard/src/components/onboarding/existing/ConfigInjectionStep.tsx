/**
 * brownfield step 3 — config-injection PR. Previews the 5 proposed
 * files, lets the operator EXCLUDE any (a checkbox per file), then opens ONE PR
 * in the target repo with the kept files. "No runs until merged." After the PR
 * opens, renders the PR link + the committed-file list. Recreated from the
 * hi-fi `view-onboard-existing` step 3.
 *
 * The 5 files mirror the orchestrator `proposeConfigFiles` output exactly so the
 * checkbox `value` (the file path) round-trips into the `excludePaths` form
 * field the route forwards.
 */

import type { ConfigInjectionResult, ReconReport } from "../../../api/existingBrownfieldTypes.js";
import { CsrfField } from "../../shell/CsrfField.js";

interface PreviewFile {
  path: string;
  addedLines: number;
  snapshot?: boolean;
}

// The proposed-file manifest, mirroring the orchestrator's `proposeConfigFiles`
// order + paths (line counts are approximate previews until the PR is opened).
const PROPOSED: PreviewFile[] = [
  { path: ".tanren/PROJECT.md", addedLines: 30, snapshot: true },
  { path: ".tanren/ci.yml", addedLines: 24 },
  { path: "CODEOWNERS", addedLines: 4 },
  { path: ".gitignore", addedLines: 3 },
  { path: ".github/PULL_REQUEST_TEMPLATE.md", addedLines: 4 },
];

export function ConfigInjectionStep(props: {
  repoUrl: string;
  report: ReconReport;
  posture: string;
  baseAction: string;
  projectId?: string;
  opened?: ConfigInjectionResult;
  error?: string;
  csrfToken?: string;
}) {
  if (props.opened !== undefined) {
    return (
      <OpenedView
        opened={props.opened}
        repoUrl={props.repoUrl}
        report={props.report}
        baseAction={props.baseAction}
        projectId={props.projectId}
        csrfToken={props.csrfToken}
      />
    );
  }
  return (
    <>
      <div class="step-heading">
        <div>
          <div class="eyebrow">step 3 · config injection pr</div>
          <div class="title">
            review what <em>we'll add</em>
          </div>
          <div class="sub">
            tanren proposes the integration files from what the agent read. nothing lands until you merge this pr.
            exclude any file; tanren adapts.
          </div>
        </div>
        <div class="right">
          <span class="pill ok">
            <span class="d"></span>one pr · then it's yours
          </span>
        </div>
      </div>
      {props.error === undefined ? null : <div class="alert fail">{props.error}</div>}

      <form method="post" action={props.baseAction}>
        <CsrfField token={props.csrfToken} />
        <input type="hidden" name="phase" value="open-pr" />
        <input type="hidden" name="step" value="3" />
        <input type="hidden" name="repoUrl" value={props.repoUrl} />
        <input type="hidden" name="projectId" value={props.projectId ?? ""} />
        <input type="hidden" name="report" value={JSON.stringify(props.report)} />
        <input type="hidden" name="posture" value={props.posture} />
        <div class="ex-cols-narrow">
          <div>
            <div class="ex-filelist">
              {PROPOSED.map((f) => (
                <label class="ex-filerow on">
                  <input type="checkbox" name="keep" value={f.path} checked style="margin:0" />
                  <span class="path">
                    {f.path}
                    {f.snapshot ? <span class="snap">· snapshot</span> : null}
                  </span>
                  <span class="add">+{f.addedLines}</span>
                </label>
              ))}
            </div>
            <div class="mono-dim" style="margin-top:8px">
              uncheck any file to exclude it · pr targets <b>main</b> from <b>tanren/integrate</b>
            </div>
          </div>

          <div style="display:flex;flex-direction:column;gap:12px">
            <div class="col-card">
              <div class="h">
                <span>
                  .tanren/PROJECT.md <em>· one-time snapshot</em>
                </span>
              </div>
              <div class="ex-preview">{snapshotPreview(props.report, props.posture)}</div>
            </div>
            <div class="col-card live" style="flex-direction:row;align-items:center;gap:12px">
              <span
                class="mono-dim"
                style="color:var(--ember-08);letter-spacing:0.18em;text-transform:uppercase;font-weight:700"
              >
                ↑ before you click
              </span>
              <div style="font-family:var(--font-ui);font-size:12px;color:var(--fg-1);line-height:1.4;flex:1">
                this opens a PR on the target repo. tanren will <b>NOT</b> start runs until you merge it. comment, edit,
                or reject like any other pr.
              </div>
              <button type="submit" class="btn primary">
                open the pr ↗
              </button>
            </div>
          </div>
        </div>
      </form>
    </>
  );
}

function snapshotPreview(report: ReconReport, posture: string): string {
  const personas = report.personas.map((p) => `- ${p.name} — ${p.description}`).join("\n");
  const behaviors = report.behaviors.map((b) => `- ${b.persona} · ${b.title}`).join("\n");
  const architecture = report.architecture.map((a) => `- ${a.layer} · ${a.detail}`).join("\n");
  return [
    `# ${report.identity.slug}`,
    "",
    "## identity",
    `- purpose · ${report.identity.purpose}`,
    "",
    "## personas",
    personas,
    "",
    "## behaviors",
    behaviors,
    "",
    "## architecture",
    architecture,
    "",
    "## merge posture",
    `- ${posture}`,
  ].join("\n");
}

function OpenedView(props: {
  opened: ConfigInjectionResult;
  repoUrl: string;
  report: ReconReport;
  baseAction: string;
  projectId?: string;
  csrfToken?: string;
}) {
  return (
    <>
      <div class="step-heading">
        <div>
          <div class="eyebrow">step 3 · config injection pr · opened</div>
          <div class="title">
            pr <em>#{props.opened.pullRequest.number}</em> opened
          </div>
          <div class="sub">
            no runs start until this PR merges. review + merge it in the target repo, then continue seeding the DAG.
          </div>
        </div>
      </div>
      <div class="alert ok">
        Opened{" "}
        <a href={props.opened.pullRequest.url} target="_blank" rel="noreferrer" style="color:var(--ember-08)">
          PR #{props.opened.pullRequest.number}
        </a>{" "}
        on branch <b>{props.opened.pullRequest.branch}</b> · {props.opened.files.length} files · no runs until merged.
      </div>
      <div class="col-card" style="gap:8px">
        <div class="h">
          <span>files committed</span>
        </div>
        {props.opened.files.map((f) => (
          <div class="ex-seed-row">
            <span style="color:var(--status-ok)">+</span>
            <span class="name">{f.path}</span>
            <span class="tag">+{f.addedLines}</span>
          </div>
        ))}
      </div>
      <form method="post" action={props.baseAction}>
        <CsrfField token={props.csrfToken} />
        <input type="hidden" name="phase" value="advance" />
        <input type="hidden" name="step" value="3" />
        <input type="hidden" name="repoUrl" value={props.repoUrl} />
        <input type="hidden" name="projectId" value={props.projectId ?? ""} />
        <input type="hidden" name="report" value={JSON.stringify(props.report)} />
        <div class="foot">
          <div class="hint">↑ the integration pr is the one-time gate · all brownfield onboarding lands through it</div>
          <div class="grow"></div>
          <button type="submit" class="btn primary">
            next · spec dag + ingest ↗
          </button>
        </div>
      </form>
    </>
  );
}
