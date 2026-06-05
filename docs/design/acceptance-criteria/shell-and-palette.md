# Shell + ⌘K palette + auth flow

**Surface**: the application shell every other dashboard route renders inside.

**Owning spec**: P2B-0001 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: `tanren-hi-fidelity/project/shared.jsx` (`TopBar`, `SideNav`, `ForgePalette`); `tanren-hi-fidelity/project/app.jsx` (route wiring).

## In scope for Phase 2

- [ ] **Top bar** renders the `tanren` brand, the org pill (current org with switcher), the project crumb when a project is selected, the ink/ash surface toggle, the ⌘K Forge palette trigger, a notifications bell, and the operator avatar.
- [ ] **Sidenav** renders three groups: org (overview, history & costs), projects (project list + discover + halted runs), setup (routing & limits, notifications), onboarding (org setup, new project, existing project). Non-Phase-2 rows render as documented placeholders with a `phase 3+` label.
- [ ] **GitHub OAuth sign-in** flow lands the operator into the shell; first sign-in creates the org row and the user as first admin per P2A-0003.
- [ ] **Project switcher** in the org pill shows projects the operator is a member of and lets them switch context. Switching updates the project crumb and the active sidenav child route.
- [ ] **Ink/ash toggle** flips `data-theme` via the design tokens from P2A-0016 with no hardcoded colors.
- [ ] **⌘K palette** opens an overlay modal. Items are sourced from P2A-0019's Forge tool surface: quick actions (open run X, review PR Y, jump to project), forge-this suggestions, and ask-forge prompts. Selecting an item routes (read actions) or calls the operator-button write action (P2A-0013). The palette closes on Escape, on backdrop click, and on item select.
- [ ] **Keyboard**: ⌘K (or Ctrl+K) opens the palette anywhere in the shell; ↑/↓ navigates results; Enter selects.
- [ ] **Empty / placeholder routes**: every sidenav row that does not have a Phase 2B implementation renders a documented placeholder explaining what phase the screen ships in.

## Reductions from the hi-fi

- The org-level `overview`, `roadmap`, and `personas` sidenav rows still render as placeholders (`phase: "3+"`). DORA is mounted.
- Org pill switcher does not yet support creating or leaving orgs; that remains future multi-tenant administration work.
- ⌘K palette: the thick Forge LLM-driven chat morph ships (the palette morphs into a real conversation thread via `/forge/threads/:id/ask`).

## Done when

An operator can sign in with GitHub, see their org and projects in the chrome, switch projects, navigate to every Phase 2 sidenav row (placeholder or implemented), and invoke the palette to jump to a live run or trigger a documented write action.
