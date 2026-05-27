---
name: tanren-design
description: Use this skill to generate well-branded interfaces and assets for Tanren — the platform for end-to-end agentic code development. Tanren's voice is editorial-meets-terminal, industrial-punk-meets-craft: confident, literate, precise, never apologetic. Brand metaphor is forging steel (鍛錬). Use this for production UI, throwaway prototypes, slide decks, marketing pages, dashboards, CLIs.
user-invocable: true
---

# tanren-design

Read `README.md` first — it covers content fundamentals (voice, tone, copywriting patterns), visual foundations (color, typography, spacing, motion), iconography, and the asset inventory. Then explore:

- `colors_and_type.css` — every design token. Import this and you have the API.
- `assets/` — logos, marks, motifs (SVG).
- `preview/` — design-system cards (Type, Colors, Spacing, Components, Brand).
- `ui_kits/dashboard/` — primary product UI. React + Babel single-page app showing the org-level command deck, projects grid, roadmap DAG viewer, central budget, DORA, personas, a behavior crafter, and Forge — the unified ⌘K chat / command palette.
- `ui_kits/marketing/` — long-form editorial landing.
- `ui_kits/cli/` — terminal experience mockup with six command states.

## When invoked

- **If creating visual artifacts** (slides, mocks, throwaway prototypes, dashboards, marketing pages): copy the assets out of `assets/`, link `colors_and_type.css`, and use the brand vocabulary as documented. Build static HTML files; reference Lucide icons via CDN if you need icons beyond the brand's own marks.
- **If working on production code**: lift the tokens from `colors_and_type.css` directly into your codebase, copy the SVG assets verbatim, and read the README's VISUAL FOUNDATIONS + CONTENT FUNDAMENTALS sections as the engineering contract for design.
- **If the user invokes this skill with no clear ask**: ask them what they want to build or design (a screen? a slide? a hero? a component?), ask which Tanren product surface (dashboard, marketing, CLI), ask whether they want ink (dark, the product default) or ash (light, the marketing default), then act as an expert designer who outputs HTML artifacts or production code.

## Hard rules (non-negotiable)

- **Voice:** sentence case everywhere except the eyebrow style. Lowercase the wordmark (`tanren`). No emoji in product/marketing surfaces. Em dashes free, oxford commas mandatory, no exclamation marks.
- **Type:** Syne (display, 700/800 with italics), Space Grotesk (UI), JetBrains Mono (mono, with italics for emphasis), Reggae One (the 鍛錬 stamp). Never substitute for editorial-corporate alternatives like Inter or Fraunces.
- **Color:** one accent — ember. No gradients except a subtle radial wash on hero surfaces. Hairlines beat shadows. Two surface temperatures: ash (light, cool concrete) and ink (dark, warm void). Never warm "paper."
- **Iconography:** Lucide via CDN is a substitute. Never hand-roll SVG icons; use the brand's own 5-node loop motif, the 鍛 seal, or mono characters (→ ↗ ⟳ ✓ ! +) instead where possible.
- **The loop is the brand.** Not the count of phases. New phases (cron audits, conflict resolvers, merge queues, Linear triage) will join over time. Show progression as forward subtask completion, not phase visits — retries belong inside subtask threads.
- **The user is the strategist. Tanren is the smithy.** Always frame product copy with the user writing specs / picking personas / defining acceptance criteria, and Tanren doing the forging.

## Tokens cheat sheet

```css
/* surfaces */
--bg-canvas: var(--ash-01);   /* light default */
[data-theme="dark"] --bg-canvas: var(--ink-12);
/* text */
--fg-1, --fg-2, --fg-3;
/* hairlines */
--line-1, --line-2, --line-hot;
/* the accent — the only saturated color */
--ember-08 (primary), --ember-09 (hover), --ember-10 (press);
/* status */
--status-ok, --status-run, --status-warn, --status-fail;
/* the three cost models */
--cost-token, --cost-opportunity, --cost-window;
/* type families */
--font-display: "Syne";
--font-ui: "Space Grotesk";
--font-mono: "JetBrains Mono";
--font-jp: "Reggae One";
```

## Brand vocabulary

- **the loop** — the agent workflow. Plan → write → check → audit → ship. Never "the pipeline," never "the agent."
- **the smithy** — Tanren itself, as the implementation machine.
- **forge** — the verb for what Tanren does. "Tanren forges the rest."
- **spec** — a unit of work. Never "ticket," never "task" (those are subtasks).
- **the trajectory** — the visible path through the loop. Designed to look like progress, not noise.
- **鍛錬** — used as a stamp/seal/watermark. The full word means tempering through discipline. Display large and decoratively; never as a label.
