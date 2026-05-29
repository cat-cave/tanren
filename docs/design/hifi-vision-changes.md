# Hi-fi Vision Changes

This document tracks **vision-level changes** to the hi-fi mockup (`tanren-hi-fidelity` bundle) — adjustments to what the long-term product should look like. It does not track phasing.

The hi-fi is the source of truth for the long-term product. Phase tags inside individual hi-fi components (`v0`, `p3`, `p4+`) reflect the designer's intent for when each piece arrives. Phasing of subsets of the hi-fi to ROADMAP phases is recorded in `ROADMAP.md`, not by editing the hi-fi.

## Open vision changes

Items below are deltas that should be applied to the next hi-fi iteration. Each is a change to the long-term product vision, not a Phase 2 scope reduction.

### Routing settings — drop Wafer

**File**: `view-settings.jsx` (write-role chain entry, around line 17)
**Change**: Delete the routing entry `{ cli: "opencode", model: "glm-5.1", auth: "dev · wafer pass (TW)", health: "ok" }`.
**Reason**: Wafer pass-through through opencode was discontinued on 2026-05-27. Wafer is permanently dead and is not part of the long-term product. The remaining write-chain entry `{ cli: "opencode", model: "glm-5.1", auth: "dev · zai subscription bundle (TW)", health: "ok" }` stays as the opencode entry.

Also delete the matching Vault entry: in the `SETTINGS_VAULT` array, drop `{ label: "wafer pass · opencode (TW)", path: "vault://dev/tw/opencode/wafer", … }`.

### Review readiness gate — merge integration is per-repo configurable

**File**: `view-review.jsx` readiness gate (bottom of the file)
**Current state**: Sign-off CTAs render as fixed defaults:

- `request changes ↗`
- `sign off · queue with mergify`
- `sign off · merge now ↗`

**Change**: Make the merge-related CTAs render conditionally based on per-repo merge-integration configuration. Possible long-term states:

- Repo configured for **Mergify queue** → show `sign off · queue with mergify`
- Repo configured for **direct GitHub merge** → show `sign off · merge now ↗`
- Repo configured for **external-reviewer handoff** → show `approve · notify reviewer`
- Repo with **no merge integration configured** → show a disabled `sign off · merge integration not configured` with a link to the per-project settings

`request changes ↗` is always available regardless of merge configuration.

**Reason**: Not every repo uses Mergify, not every operator wants Tanren to merge directly. The long-term vision treats merge integration as a per-repo capability; the readiness gate should reflect that.

### Brownfield config-injection PR — drop `.tanren/config.yaml`, label `PROJECT.md` as one-time snapshot

**File**: `view-onboard-existing.jsx` step E3 (config injection PR), file list around line 206
**Current state**: The PR file list shows:

- `.tanren/config.yaml` (+38, selected)
- `.github/workflows/tanren-ci.yml` (+84)
- `.mergify.yml` (+42)
- `CODEOWNERS` (+14)
- `.gitignore` (+4, mod)
- `PULL_REQUEST_TEMPLATE.md` (+36, mod)

**Change**: Replace `.tanren/config.yaml` with `.tanren/PROJECT.md` and label it explicitly as a **one-time generated snapshot** in the file's preview pane: "Generated mirror of project config at onboarding · regenerated only on opt-in via the audit gate · don't edit by hand". The right-side preview of this file shows a Markdown export of the project config rather than a YAML config file.

The other five files keep their current labels — those are Bucket A (GitHub/Mergify-read) files that legitimately need to land in the target repo.

**Reason**: Per the principled config bucketing decided 2026-05-28, project config lives in the orchestrator DB, not in the target repo. The brownfield config-injection PR creates a _one-time_ transparency snapshot under `.tanren/PROJECT.md` at onboarding; there is no ongoing mirror. The hi-fi previously implied `.tanren/config.yaml` was an authoritative config file Tanren reads — that's no longer the long-term vision.

### Settings · "edits land as a pr" caption — conditional on audit-gate

**File**: `view-settings.jsx` "tell forge to change config" panel (around line 158)
**Current state**: The bottom panel caption reads "edits land as a pr · review before merge" as a fixed footer.

**Change**: Make the "edits land as a pr" caption conditional on the org's audit-gate setting. Two long-term rendering paths:

- **Audit gate on** → caption reads "edits land as a pr in `<org>/tanren-config` · review before merge"
- **Audit gate off** → caption reads "edits land in the dashboard · no PR required"

The text input "swap audit primary to claude opus 4.7" stays the same; only the result-handling caption changes.

**Reason**: The `tanren-config` audit-gate is an optional org-level feature in the long-term vision, not a default behavior. The hi-fi currently implies PR-driven edits are universal; they should render as the gated path.

### Page subtitle — `cat-cave/tanren-config/main/tanren.yaml`

**File**: `view-settings.jsx` PageHead `sub` prop (line 65)
**Current state**: `cat-cave/tanren-config/main/tanren.yaml · committed via pr · forge can edit`
**Change**: Make this subtitle conditional on the audit-gate setting. With gate off (default), subtitle reads `org · cat-cave · routing & limits · stored in dashboard`. With gate on, the current subtitle stays.
**Reason**: Same as above. The subtitle implies a `tanren-config` repo is always the source of truth; under the principled bucketing, the DB is authoritative and the `tanren-config` repo is an optional gate.

## Applied vision changes

(Move items here once they land in the next hi-fi iteration.)

_None yet._

## Notes on phasing

Phasing — which subsets of the hi-fi ship in Phase 2 vs Phase 3 vs later — is recorded in `ROADMAP.md` under "Phase 2 Workflow Inventory" and the Phase 3 scope buckets. The hi-fi itself is not phase-tagged by ROADMAP; the designer's existing in-mockup phase badges (`v0`, `p3`, `p4+`) represent the designer's view of when each component arrives in the long-term roadmap, and ROADMAP reconciles them.
