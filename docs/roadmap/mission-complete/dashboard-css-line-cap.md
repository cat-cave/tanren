## SPEC-FIX0934a - dashboard-css-line-cap

**Phase**: B
**Branch**: `fix/dashboard-css-line-cap` (stacked on contributor PR #934 head `c8158359`)
**Owns**:

- `scripts/check-architecture.mjs`
- `scripts/check-architecture-line-cap.mjs` (focused file-collection + line-cap authority; `patterns` now include `html`/`jsx`/`txt`)
- `scripts/check-architecture-line-cap.test.ts` (line-cap + collector hostile temp-tree tests)
- `scripts/css-modules.test.ts` (digest/line/rule pin regression; comment-aware brace-depth rule counter; verbatim entry + dir-exactness asserts)
- `docs/contracts/architecture-checks.md`
- `docs/roadmap/mission-complete/dashboard-css-line-cap.md` (this card)
- `services/dashboard/src/design/shell.css` (deleted — split into modules)
- `services/dashboard/src/design/shell-manifest.mjs` (new — single ordering authority shared by build + test)
- `services/dashboard/src/design/shell/*.css` (six modules)
- `services/dashboard/scripts/build-client.mjs` (build-time concat delivery path; consumes the manifest)
- `tanren-hi-fidelity/project/styles.css` (entry — header + tokens import + five `@import`s)
- `tanren-hi-fidelity/project/styles/*.css` (five modules)
- `tanren-hi-fidelity/project/index.html` (loads the split JSX modules in order)
- `tanren-hi-fidelity/project/view-org.jsx` + `view-notifications.jsx` + `view-roadmap.jsx` + `view-personas.jsx` + `view-dora.jsx` (view-org split into five surfaces)
- `tanren-hi-fidelity/project/view-onboard-existing.jsx` + `view-onboard-existing-config.jsx` + `view-onboard-existing-gov.jsx` (existing-onboard split)
- `tanren-hi-fidelity/project/tweaks-panel.jsx` + `tweaks-panel-controls.jsx` (tweaks split)

**Consumes**: contributor PR #934 (`c8158359`, AST fail-closed architecture check).

**Produces**: the 500-line invariant enforced for tracked source CSS, HTML, JSX, TXT, and mission roadmap docs with no undocumented blanket exemption; both CSS surfaces and the three over-cap hi-fi JSX sources preserved byte-/cascade-/render-semantically.

**What**: enforce the `file-line-max-500` invariant for tracked source CSS/HTML/JSX/TXT (previously only CSS was added; HTML/JSX/TXT were un-scanned, letting three over-cap hi-fi JSX files slip through) and remove the undocumented `docs/roadmap/mission-complete/` blanket line-cap exemption. Split the two known over-500 CSS files (`services/dashboard/src/design/shell.css` ~846, `tanren-hi-fidelity/project/styles.css` ~1897) and the three over-cap hi-fi JSX sources (`view-org.jsx` 887, `view-onboard-existing.jsx` 577, `tweaks-panel.jsx` 530) into coherent ordered modules all under 500, preserving every selector, declaration, custom property, media query, at-rule, specificity, cascade order, render, and export exactly.

**Why**: PROJECT_BRIEF.md §1.2 invariant 8 — "Files are bounded. Custom lint rule: 500-line maximum per source file." CSS was never in the architecture collector's `patterns`, so the two largest CSS files silently exceeded the cap. The mission-complete blanket prefix-exemption hid over-500 narrative docs without a documented exception. Both are mechanical escapes from the invariant this project is built on.

**How**:

- **Architecture collector**: add `css`, `html`, `jsx`, and `txt` to the canonical file `patterns`; extract the file-collection + line-cap authority into a focused sibling `scripts/check-architecture-line-cap.mjs` (keeps `check-architecture.mjs` under 500). Remove the `file.startsWith("docs/roadmap/mission-complete/")` blanket from `checkLineMax`. The long-running narrative node specs under `docs/roadmap/mission-complete/nodes/` that exceed 500 are enumerated as named entries (the five pre-existing oversized narrative bucket specs) in the `roadmapDocs` narrative-doc list (same mechanism as `docs/roadmap/timeout-eradication.md`) — this is categorization under an already-documented mechanism, not a new Exception Path entry. No new blanket, allowlist, or Exception Path entry is introduced. `build-workflow.mjs.txt` (459) is scanned without an exception; `integrated-build-dag.html` (423) is now reachable so a post-rebase growth past 500 IS caught.
- **Dashboard delivery**: split `shell.css` into 6 ordered modules under `src/design/shell/` and concatenate them at BUILD time in `build-client.mjs`. The ordered stem list is the ONE shared authority in `src/design/shell-manifest.mjs`, consumed by both the build AND the regression test (the manifest is pure data — no build script with side effects is imported from tests). The published `/static/shell.css` is byte-identical to the original (modules are exact contiguous slices), so the single `<link>` is unchanged and rendered behavior is preserved. No golden baseline is retained on disk; the regression lives in `scripts/css-modules.test.ts` as pinned digests/counts.
- **Hi-fi delivery**: reduce `styles.css` to its verbatim header comment + the unchanged `@import url("./tokens.css")` + an `@import` chain of 5 ordered content modules under `project/styles/`. Each module is a contiguous slice of the pre-split body, so the effective cascade is byte-identical to the original. The five modules replace the intermediate 33-file split. The test hardcodes the expected five stems and byte-asserts the entire `styles.css` entry verbatim (banner + the unchanged `tokens.css` import + the five ordered `./styles/<stem>.css` imports, nothing extra), then reconstructs the pre-split body from those hardcoded stems — so the entry's import order is pinned byte-for-byte rather than dynamically parsed.
- **Hi-fi JSX split**: the three over-cap JSX sources are split into coherent helper/component modules, each under 500, preserving exports/render/behavior. `view-org.jsx` (887) → five surface modules (`view-org.jsx` overview + `view-notifications.jsx` + `view-roadmap.jsx` + `view-personas.jsx` + `view-dora.jsx`); `view-onboard-existing.jsx` (577) → three (`…existing.jsx` + `…existing-config.jsx` + `…existing-gov.jsx`); `tweaks-panel.jsx` (530) → two (`tweaks-panel.jsx` core shell + `tweaks-panel-controls.jsx`). `index.html` loads each split set in order where the original single file sat. No exceptions, minification, or line-count gaming.
- **Regression**: `scripts/css-modules.test.ts` pins the pre-split SHA-256 byte digest, byte count, line count, top-level rule count, and ordered module list for both CSS surfaces; it reconstructs module content at runtime and compares those pins, catching loss, duplication, reorder, or byte changes without storing the original. The rule counter is a comment-aware brace-depth counter (not the prior fake line-equals-`}` heuristic) with hostile single-line/nested/comment fixtures proving it. The real `styles.css` entry is asserted verbatim and both module directories are asserted to contain exactly their expected stems (no ignored extras). Architecture-check tests prove a >500 CSS/HTML/JSX/TXT file is found via the COLLECTOR and fails, a normal split passes, a runnable module under `docs/roadmap/mission-complete/` is scanned, and unrelated mission docs are not blanket-exempt.

**Test plan**: `corepack pnpm run check:architecture`; `scripts/check-architecture.test.ts` + `scripts/css-modules.test.ts` via `vitest`; dashboard `typecheck`/`test`/`build` (render test `shell.render.test.ts` unchanged); `just fast-check` and `just ci`.

**Quality bar**: every new/changed source/test/doc/CSS file ≤ 500 lines; the published dashboard CSS is byte-identical to the pre-split original; the hi-fi effective cascade is byte-identical to the pre-split original.

**Real-functionality validation**: dashboard `build` produces `dist/static/shell.css`; `shell.render.test.ts` still asserts the `/static/tokens.css` + `/static/client.js` links and chrome; hi-fi `index.html` → `styles.css` → `@import` chain loads every module once in the original order.

**Worktree-isolation safety**: owns `scripts/check-architecture*.mjs`, `services/dashboard/src/design/**` (CSS + shell-manifest), `tanren-hi-fidelity/project/{styles*,view-org*.jsx,view-onboard-existing*.jsx,tweaks-panel*.jsx,index.html}`, and `docs/contracts/architecture-checks.md`. Does not touch migrations, package/version/lockfile, nav, `screens.ts`, any `main.ts`, secrets, or runtime/control files.
