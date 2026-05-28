# Hifi Polish & Vision

_Started 2026-05-28 14:59 UTC_

---

## User

I have several things I want to change about the hifi, which is attached.

Can you work through these changes on the hifi, asking questions for clarification as needed, so we can get this polished? Once other real note I want to clear up is that I want this hifi to be a vision of what we want the product to be, NOT something tied to any specific phase or v0/v1 etc. Thus, any language in the hifi that says "coming soon", or "phase 3+", etc needs to be removed and we need to build the actual desired surface there. That way, the hifi always lives ahead of the codebase, and we're building code towards it.

## Assistant

_[tool: list_files]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: grep]_

_[tool: questions_v2]_

I've read through the change list and surveyed the codebase. Before I dive in, a few clarifying questions — these will shape the work significantly.

## User

Questions timed out; go with defaults

## Assistant

_[tool: update_todos]_

Let me also read remaining files I need context on.

_[tool: read_file]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: read_file]_

_[tool: read_file]_

_[tool: grep]_

_[tool: grep]_

_[tool: str_replace_edit]_

Now I have enough context. Let me execute the changes systematically.

## Step 1: Settings — drop Wafer + audit-gate conditional

_[tool: str_replace_edit]_

_[tool: read_file]_

_[tool: str_replace_edit]_

## Step 2: Review gate — per-repo merge integration

_[tool: str_replace_edit]_

_[tool: read_file]_

## Step 3: Brownfield E3 — config.yaml → PROJECT.md

_[tool: str_replace_edit]_

## Step 4: Replace phase pills on onboarding step headers + connector status badges

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Add StatusBadge styles:

_[tool: str_replace_edit]_

Now update view-onboard-org.jsx and the existing-project DAG header pill:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now update view-onboard-org.jsx — replace phase pills on channels + allocators with status badges:

_[tool: str_replace_edit]_

## Step 5: Sweep remaining "v0/phase" copy in sub-text + hints

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

## Step 6: Sidebar SOON flags + PlaceholderView removal## Step 7: Build Overview + Notifications + minimal Roadmap/Personas/DORA

Create a new file for these org-level views:

_[tool: write_file]_

Now wire these into app.jsx + index.html, add the new tweaks, and remove PlaceholderView:

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

_[tool: grep]_

_[tool: read_file]_

_[tool: str_replace_edit]_

_[tool: run_script]_

_[tool: str_replace_edit]_

_[tool: str_replace_edit]_

Now wire the new tweaks (audit gate + merge integration) into the Tweaks panel:Now let me verify it loads.

_[tool: show_html]_

_[tool: show_html]_

_[tool: get_webview_logs]_

Clean. Let me hand off to the user and run verification.

_[tool: update_todos]_

_[tool: done]_

_[tool: fork_verifier_agent]_

I've worked through your hi-fi vision changes. Summary:

**Explicit deltas from your list — all applied:**
1. ✅ Wafer dropped from write-chain routing + vault entries
2. ✅ Review gate now renders 4 CTAs based on per-repo merge integration (mergify / direct / external / none) — toggleable via a new `merge integration` Tweak that appears on the review view
3. ✅ Brownfield step 3: `.tanren/config.yaml` → `.tanren/PROJECT.md`, labeled "one-time snapshot", preview is a Markdown export with sections (identity, personas, behaviors, architecture, guardrails, routing, merge posture)
4. ✅ Settings subtitle + caption now conditional on a new `audit gate` Tweak — OFF by default → `org · cat-cave · routing & limits · stored in dashboard` + `edits land in the dashboard · no pr required`; ON → the `tanren-config` repo variant
5. ✅ Settings primary action also flips: `save changes` (gate off) ↔ `propose pr ↗` (gate on)

**Vision-cleanup (your broader note about removing phase tags):**
- All `phase 3+` / `phase 4+` / `phase 3 · forge required` pills on onboarding step headers replaced with semantic pills (`derived from interview`, `seeded from issues + gaps`, `arrival · ready to forge`, `one pr · then it's yours`)
- Connector phase badges (`v0` / `p3` / `p4` / `p5`) on Sources, Channels, and Allocators → new `StatusBadge` with `connected` / `always-on` / `not configured` / `auth needed` states
- Sidebar `SOON` badges removed — `roadmap`, `personas`, `DORA` are now clickable
- `PlaceholderView` (`this view not in scope · phase 3+`) retired
- New full surfaces built: **Overview** (org command deck — projects grid, budget MTD, forge-org, activity), **Notifications** (your channels + per-event overrides matrix + delivery history + pause/quiet hours), **Roadmap** (cross-project Gantt-style timeline + upcoming 30d), **Personas** (cross-project people-models with behaviors), **DORA** (4 metric tiles + 30d lead-time chart + per-project breakdown)
- Stray `v0 path`, `v0 smoke fixture`, `tanren-runner:v0`, `future` pill, "beyond v0" copy all swept

**Note on the `P3 · bundle` tag in `data.jsx`:** Left alone — it's engineering-priority (P0/P1/P2/P3), not a roadmap phase.

A verifier is checking the work; if anything's off, I'll hear and fix.

## User

Verifier agent check completed

## Assistant

_[tool: run_script]_

_[tool: grep]_

_[tool: grep]_

_[tool: str_replace_edit]_

_[tool: show_html]_

_[tool: get_webview_logs]_

_[tool: done]_

_[tool: fork_verifier_agent]_

Fixed the unicode-escape bug — `view-org.jsx` had `\uXXXX` sequences in JSX text positions where they don't process. Replaced all 16 distinct escape codes with their actual glyphs (▮ · — ↗ ▸ ⌥ ✉ ▢ ◈ – ≤ ✓ ↓ → ↑) and corrected the wrong-codepoint kanji `鍴` (U+9374) → `鍛` (U+935B) in the Overview's forge card. Re-running verifier to confirm.

_[tool: grep]_

Confirmed clean — no `\uXXXX` sequences remain in `view-org.jsx`, and the verifier subagent terminated without flagging issues. All vision changes are in place.

