# Tanren design tokens

This directory holds the **source-of-truth design tokens** for Tanren, as imported from the Claude Design handoff bundle. Everything here is verbatim from the bundle except this README, which adapts the bundle's outer scaffolding to its in-repo home.

## What is here

- `colors_and_type.css` — the foundational token sheet. CSS custom properties for color, typography, spacing, radii, shadows, and motion. Imported by `services/dashboard/src/design/tokens.css`. **Treat as source of truth**; downstream copies are drift-checked.
- `SKILL.md` — the engineering contract for design. Read this before producing any user-facing surface.
- `assets/` — brand SVGs (logo wordmark, hanko mark, full kanji seal, loop motif, favicon).

## How to use

- **Production code (dashboard, future services):** consume tokens via the dashboard's design package at `services/dashboard/src/design/`. Do not import this directory directly from runtime code; that's what the design package re-export is for.
- **Throwaway prototypes, slides, mocks:** link `colors_and_type.css` directly.
- **Adding or modifying tokens:** edit `colors_and_type.css` here. The drift check (`scripts/check-design-tokens-drift.mjs`, wired into `just fast-check`) will fail until the dashboard copy is regenerated.

## Source

Imported from the `tanren-design-system` Claude Design handoff bundle. The bundle's outer `README.md` and `project/README.md` are not committed here — their contents are bundle-distribution scaffolding (chat transcripts, preview HTML, UI kits). The engineering contract is `SKILL.md`; the visual foundations and content fundamentals it references live there.

## What is **not** here

- `chats/` — design rationale transcripts. Not committed; bundle-only.
- `preview/` — preview HTML cards (type, color, spacing, components, brand). Useful when iterating the bundle, but not artifacts for the running product.
- `scratch/` — working files. Not artifacts.
- `ui_kits/` — full HTML prototype kits (dashboard, marketing, cli). Reference these in the source bundle when implementing surfaces; do not copy them into the repo.

## Phase notes

- **Phase 2A (this commit):** tokens land as repo-resident artifacts and are exposed to the dashboard build. No existing dashboard surface is restyled.
- **Phase 2B and beyond:** new user-visible surfaces consume tokens via `@tanren/dashboard`'s design package. Restyles of existing surfaces are out of scope for the import spec.
- **Phase 3:** Google Fonts `@import` may be replaced with self-hosted `@font-face` declarations. The token sheet currently CDN-loads Syne, Space Grotesk, JetBrains Mono, Noto Serif JP, and Reggae One.
