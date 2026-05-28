/**
 * Existing-project · minimal (P2B-0002) — link-only, 1 step. Rebuilt as TSX
 * from `view-onboard-existing.jsx` step 1 ONLY. NO recon agent, NO
 * config-injection PR, NO DAG seeding, NO governance picker (all phase 3).
 *
 * The operator picks a repo the GitHub App can see, fills the project-config
 * form, and submits. Submit creates the project row (P2A-0013) then calls the
 * brownfield-link endpoint which reads `.github/workflows/`, `.mergify.yml`,
 * `CODEOWNERS` for display but WRITES NOTHING to the target repo.
 */

import type { BrownfieldDetectedFile } from "../../api/types.js";
import { Field, SelectField, StepHeading } from "./primitives.js";

const ALLOCATORS: Array<[string, string]> = [["local_docker", "local-docker (v0 default)"]];

function GithubScopeCard() {
  const can = [
    "clone & push from runner workspaces",
    "open draft PRs from tanren/spec_* branches",
    "poll ci check status",
    "read org members for review-gate routing"
  ];
  const cannot = ["never push to main · never bypass protection · never force-push", "no access to org billing, secrets, settings"];
  return (
    <div class="col-card" style="gap:8px">
      <div class="h">
        <span>
          what tanren <em>can do</em>
        </span>
        <span class="pill cold" style="margin-left:auto">
          <span class="d"></span>github app scope
        </span>
      </div>
      <ul class="scope-list">
        {can.map((text) => (
          <li>
            <span class="g" style="color:var(--status-ok)">
              ✓
            </span>
            {text}
          </li>
        ))}
        {cannot.map((text) => (
          <li class="never">
            <span class="g">×</span>
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function WhatHappensNext() {
  const points = [
    "tanren reads any existing .github/workflows/, .mergify.yml, and CODEOWNERS — for display only",
    "tanren does NOT write to the target repo (no config-injection PR in v0)",
    "tanren does NOT run a recon agent (no repo indexing / persona inference in v0)",
    "the project row is created and you land on the project view"
  ];
  return (
    <div class="col-card live" style="gap:8px">
      <div class="h">↑ what happens when you link (v0 minimal scope)</div>
      <ul class="scope-list" style="font-family:var(--font-ui);font-size:12px">
        {points.map((text) => (
          <li>
            <span class="g" style="color:var(--ember-08)">
              ▸
            </span>
            {text}
          </li>
        ))}
      </ul>
      <div class="mono-dim">↑ recon, config-injection PR, spec DAG, and governance posture all ship in Phase 3.</div>
    </div>
  );
}

function DetectedFiles(props: { files: BrownfieldDetectedFile[] }) {
  return (
    <div class="col-card" style="gap:8px">
      <div class="h">
        <span>
          detected files · <em>read-only</em>
        </span>
        <span class="pill ok" style="margin-left:auto">
          <span class="d"></span>0 writes performed
        </span>
      </div>
      {props.files.map((file) => (
        <div class="sunken mono" style="display:flex;align-items:center;gap:8px">
          <span style={`color:${file.present ? "var(--status-ok)" : "var(--fg-3)"}`}>{file.present ? "✓" : "·"}</span>
          <span style="flex:1">{file.path}</span>
          <span class="mono-dim">{file.present ? `${file.size ?? 0} bytes` : "absent"}</span>
        </div>
      ))}
    </div>
  );
}

export interface RepoOption {
  fullName: string;
  description: string;
  isPrivate: boolean;
  lastActivity: string;
  alreadyLinked: boolean;
}

export interface ExistingProjectBodyProps {
  orgLogin: string;
  /** Repos the GitHub App can see; empty when no listing is available yet. */
  repos: RepoOption[];
  githubAppUrl: string;
  /** Result of a just-completed link (rendered after submit). */
  linked?: { repoUrl: string; files: BrownfieldDetectedFile[]; projectId: string };
  error?: string;
}

export function ExistingProjectBody(props: ExistingProjectBodyProps) {
  return (
    <div class="onb">
      <StepHeading
        eyebrow="step 1 · pick a repo the tanren github app already sees"
        title="point at"
        em="reality"
        sub={`org setup already authorized the tanren github app on ${props.orgLogin}. pick a repo and fill the project config — no recon agent, no config-injection PR.`}
        right={<span class="phase-badge phase-v0">minimal · link only</span>}
      />

      {props.error ? <div class="alert fail">{props.error}</div> : null}
      {props.linked ? (
        <>
          <div class="alert ok">
            Linked <b>{props.linked.repoUrl}</b> as project <b>{props.linked.projectId}</b> · 0 writes to the target repo.
          </div>
          <DetectedFiles files={props.linked.files} />
          <div class="foot">
            <div class="grow"></div>
            <a class="btn primary" href={`/projects/${props.linked.projectId}`}>
              open project ↗
            </a>
          </div>
        </>
      ) : (
        <form method="post" action="/onboarding/existing/link">
          <div class="cols-2-1">
            <div class="col-card" style="padding:0;overflow:hidden">
              <div class="h" style="padding:12px 14px;border-bottom:1px solid var(--line-1)">
                <span>
                  repos · <em>{props.orgLogin}</em>
                </span>
                <span class="pill ok" style="margin-left:auto">
                  <span class="d"></span>
                  {props.repos.length} visible
                </span>
              </div>
              {props.repos.length === 0 ? (
                <div style="padding:14px">
                  <Field
                    name="repoUrl"
                    label="repo url"
                    placeholder="https://github.com/cat-cave/tanren-fixture-easy"
                    required
                  />
                  <div class="mono-dim" style="margin-top:8px">
                    No repo listing available — paste the full GitHub URL of a repo your org owns.
                  </div>
                </div>
              ) : (
                <div style="max-height:340px;overflow:auto">
                  {props.repos.map((repo, i) => (
                    <label class={`repo-row ${i === 0 ? "selected" : ""}`}>
                      <input
                        type="radio"
                        name="repoUrl"
                        value={`https://github.com/${repo.fullName}`}
                        checked={i === 0}
                        style="display:none"
                      />
                      <span class="radio"></span>
                      <div>
                        <div class="rname">
                          {repo.fullName}
                          {repo.isPrivate ? <span class="priv">PRIVATE</span> : null}
                          {repo.alreadyLinked ? (
                            <span class="pill ok">
                              <span class="d"></span>linked
                            </span>
                          ) : null}
                        </div>
                        <div class="rdesc">{repo.description}</div>
                      </div>
                      <span class="mono-dim">{repo.lastActivity}</span>
                    </label>
                  ))}
                </div>
              )}
              <div class="mono-dim" style="padding:10px 14px;border-top:1px solid var(--line-1);background:var(--bg-sunken)">
                can't see your repo?{" "}
                <a href={props.githubAppUrl} target="_blank" rel="noreferrer" style="color:var(--ember-08);text-decoration:underline">
                  add it to the tanren github app ↗
                </a>
              </div>
            </div>

            <div style="display:flex;flex-direction:column;gap:12px">
              <WhatHappensNext />
              <GithubScopeCard />
            </div>
          </div>

          <div class="col-card" style="margin-top:14px">
            <div class="h">
              <span>
                project <em>config</em>
              </span>
              <span class="mono-dim" style="margin-left:auto">
                validated against P2A-0006 project config
              </span>
            </div>
            <div class="grid-2">
              <Field name="name" label="project name" placeholder="tanren-fixture-easy" required />
              <Field name="defaultBranch" label="default branch" value="main" />
              <SelectField name="allocator" label="allocator (org default)" options={ALLOCATORS} value="local_docker" />
              <Field name="runnerImage" label="runner image (org default)" value="tanren-runner" />
            </div>
            <div class="mono-dim">
              credential refs + per-role provider routing prefill from org defaults · editable later in /settings/routing
            </div>
            <div class="foot">
              <div class="hint">↑ submitting reads the target repo for display only and writes nothing to it</div>
              <div class="grow"></div>
              <button type="submit" class="btn primary">
                link repo & create project ↗
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
