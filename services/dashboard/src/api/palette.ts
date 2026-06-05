/**
 * The v0 command-palette surface. These are the templated
 * suggestions described in the spec — quick actions (read routes), forge-this
 * write suggestions (operator-button tools), and ask-forge prompts. Thick-LLM
 * live palette responses are a later surface; this surface is deliberately static.
 *
 * Split out of `orchestrator.ts` (it is a pure presentation helper, not part of
 * the HTTP client) so the product client stays under the 500-line cap.
 */

import type { PaletteGroup, ProjectSummary } from "./types.js";

/**
 * Build the v0 palette groups for an org's project context.
 *
 * Read actions carry `route`; write actions carry a `tool` id declared in the
 * Forge tool surface so the palette can never invoke an undeclared
 * tool. Projects are passed in so quick actions can deep-link the live project.
 */
export function buildPaletteGroups(input: { orgLogin: string; projects: ProjectSummary[] }): PaletteGroup[] {
  const firstProject = input.projects[0];
  const quickActions: PaletteGroup = {
    group: "quick actions",
    items: [
      {
        glyph: "+",
        title: "new spec",
        desc: "describe work · tanren plans & forges",
        route: firstProject ? `/projects/${firstProject.projectId}/specs/new` : "/onboarding/new",
      },
      {
        glyph: "→",
        title: firstProject ? `go to ${firstProject.name}` : "go to a project",
        desc: firstProject ? firstProject.repoUrl : "no projects yet · onboard one",
        route: firstProject ? `/projects/${firstProject.projectId}` : "/onboarding/existing",
      },
      {
        glyph: "↻",
        title: "review halted runs",
        desc: "runs that hit an escape hatch",
        route: firstProject ? `/projects/${firstProject.projectId}/runs/halted` : "/projects",
      },
    ],
  };
  const forgeThis: PaletteGroup = {
    group: "forge this",
    items: [
      {
        glyph: "鍛",
        kanji: true,
        title: "draft a spec from rough notes",
        desc: "i'll plan & dependency-rank it",
        tool: "tanren.create_spec",
        args: firstProject ? { projectId: firstProject.projectId } : {},
      },
      {
        glyph: "鍛",
        kanji: true,
        title: "acknowledge a suboptimal callout",
        desc: "clear an open insight",
        tool: "tanren.acknowledge_insight",
        args: {},
      },
    ],
  };
  // ask-forge items carry NEITHER route nor tool: the palette morphs into a
  // thick-Forge chat thread and sends the title as the question.
  const askForge: PaletteGroup = {
    group: "ask forge",
    items: [
      {
        glyph: "?",
        title: "what's blocking my milestones?",
        desc: "natural-language query · ask in chat",
      },
      { glyph: "?", title: "how are my costs trending?", desc: "this week vs last · ask in chat" },
    ],
  };
  return [quickActions, forgeThis, askForge];
}
