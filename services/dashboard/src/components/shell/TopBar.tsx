/**
 * TopBar — server-rendered shell chrome (Hono JSX). Recreates the hi-fi
 * `TopBar`: tanren brand, the org pill with an embedded project-switcher
 * dropdown, the project crumb when a project is selected, the ink/ash surface
 * toggle, the ⌘K "ask forge" trigger, a notifications bell, and the operator
 * avatar.
 *
 * Interactivity (theme toggle, switcher dropdown, palette open) is wired by the
 * client islands via `data-island-*` hooks — the server only renders markup.
 * No hardcoded colors: everything references design tokens via class + CSS.
 */

import type { OrgSummary, ProjectSummary } from "../../api/types.js";

export interface TopBarProps {
  org: OrgSummary | undefined;
  /** Currently-selected project, if any (drives the crumb). */
  project: ProjectSummary | undefined;
  /** Projects in the active org, for the switcher dropdown. */
  projects: ProjectSummary[];
  /** Operator initials for the avatar. */
  operatorInitials: string;
}

function initialsOf(login: string): string {
  return login.slice(0, 2).toUpperCase();
}

export function TopBar(props: TopBarProps) {
  const orgLabel = props.org?.displayName ?? props.org?.login ?? "no org";
  return (
    <header class="topbar">
      <div class="brand">
        <span class="dot"></span>
        tanren
      </div>
      <div class="org-pill-wrap" data-island="org-switcher">
        <button class="org-pill" title="switch project" type="button" data-island-trigger="org-switcher">
          <span class="glyph">鍛</span>
          {orgLabel}
          <span style="color: var(--fg-3); margin-left: 2px">▾</span>
        </button>
        <div class="switcher-menu" data-island-menu="org-switcher" hidden>
          <div class="switcher-label">projects</div>
          {props.projects.length === 0 ? (
            <a class="switcher-item" href="/onboarding/existing">
              no projects · onboard one ↗
            </a>
          ) : (
            props.projects.map((proj) => (
              <a
                class={`switcher-item${props.project?.projectId === proj.projectId ? " active" : ""}`}
                href={`/projects/${proj.projectId}`}
              >
                <span class="dot"></span>
                {proj.name}
              </a>
            ))
          )}
        </div>
      </div>
      {props.project !== undefined && (
        <>
          <span class="crumb-sep">/</span>
          <span class="proj-crumb">
            <span class="dot"></span>
            {props.project.name}
          </span>
        </>
      )}
      <div class="right">
        <div class="surface-toggle" data-island="theme-toggle">
          <button type="button" data-theme-value="ink">ink</button>
          <button type="button" data-theme-value="ash">ash</button>
        </div>
        <button class="forge-key" type="button" data-island-trigger="palette">
          <span class="stamp">鍛</span>
          ask forge
          <span class="kbd">⌘K</span>
        </button>
        <button class="icon-btn" title="notifications" type="button">
          ✉<span class="badge">3</span>
        </button>
        <div class="avatar" title={props.org?.login ?? "operator"}>
          {initialsOf(props.operatorInitials)}
        </div>
      </div>
    </header>
  );
}
