/**
 * ShellLayout — the application shell every dashboard route renders inside.
 * Composes the TopBar + SideNav + the ⌘K palette around a page `body`, emits
 * the design-token stylesheets, sets the initial `data-theme`, and loads the
 * client-islands bundle that hydrates the interactive bits.
 *
 * Child screens (P2B-0002…0009) do NOT reimplement this — they call
 * `renderShell(...)` (see `mountShell.tsx`) with their page body and a context
 * describing the active org/project/nav row. This is the shared extension
 * point; keeping it here means the fan-out subagents never touch the chrome.
 */

import type { OrgSummary, PaletteGroup, ProjectSummary } from "../api/types.js";
import { ForgePalette } from "../components/palette/ForgePalette.js";
import { SideNav } from "../components/shell/SideNav.js";
import { TopBar } from "../components/shell/TopBar.js";

/** Mapping from the ink/ash surface name to the tokens.css `data-theme` value. */
export type Surface = "ink" | "ash";

export interface ShellContext {
  /** Active org (from the orchestrator), or undefined when unauthenticated. */
  org: OrgSummary | undefined;
  /** Projects in the active org, for the switcher + palette deep-links. */
  projects: ProjectSummary[];
  /** Selected project, if the current route is project-scoped. */
  project: ProjectSummary | undefined;
  /** Active sidenav row id (highlight). */
  activeNavId: string | undefined;
  /** Palette groups sourced from the Forge tool surface. */
  paletteGroups: PaletteGroup[];
  /** Initial surface; the client island reconciles with localStorage. */
  surface: Surface;
  /** Operator handle for the avatar. */
  operator: string;
}

/** `data-theme` is "dark" for ink, default (light/ash) is left unset. */
function themeAttr(surface: Surface): string | undefined {
  return surface === "ink" ? "dark" : undefined;
}

export interface ShellLayoutProps {
  title: string;
  ctx: ShellContext;
  /** The page body rendered into `<main class="main">`. */
  children: unknown;
}

export function ShellLayout(props: ShellLayoutProps) {
  const { ctx } = props;
  return (
    <html lang="en" data-theme={themeAttr(ctx.surface)} data-tanren-type>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{props.title}</title>
        <link rel="stylesheet" href="/static/tokens.css" />
        <link rel="stylesheet" href="/static/shell.css" />
      </head>
      <body>
        <div class="app">
          <TopBar
            org={ctx.org}
            project={ctx.project}
            projects={ctx.projects}
            operatorInitials={ctx.operator}
          />
          <SideNav activeId={ctx.activeNavId} activeProjectId={ctx.project?.projectId} />
          <main class="main">{props.children}</main>
        </div>
        <ForgePalette groups={ctx.paletteGroups} orgId={ctx.org?.id} projectId={ctx.project?.projectId} />
        <script type="module" src="/static/client.js"></script>
      </body>
    </html>
  );
}
