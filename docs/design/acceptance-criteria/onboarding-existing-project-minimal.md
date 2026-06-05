# Existing-project onboarding (minimal)

**Surface**: linking an existing GitHub repository as a Tanren project, without the brownfield recon agent or config-injection PR.

**Owning spec**: P2B-0002 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-onboard-existing.jsx` step 1 (link repo) only. The remaining hi-fi steps (recon, config-injection PR, DAG seeding, governance posture) shipped as the **full brownfield track** (`routes/brownfield/fullTrack.ts`, `engine/forge/brownfield/**`) — see the "Reductions" note below; this doc covers the minimal link-only surface.

## In scope for Phase 2

- [ ] **Repo picker**: lists repositories the Tanren GitHub App has access to under the operator's org, with name, description, privacy badge, last-activity timestamp, and a `selected` state. Filter input narrows the list. A "can't see your repo?" link surfaces the GitHub App installation page.
- [ ] **What-happens-next card**: explicitly documents the v0 minimal scope — Tanren reads any existing `.github/workflows/` and `CODEOWNERS` for display only, does not write to the target repo, and does not run a recon agent. (Mergify was removed in Phase 2 P2e-2 — `native_queue` is the merge engine — so `.mergify.yml` is no longer read.)
- [ ] **Project config form**: after repo selection, the operator fills the project name, default branch, allocator (from the org default), runner image (from the org default), credential refs (from the org's credential bundle list), provider-route preferences (per-role chain prefilled from org defaults). Form validates against P2A-0006 versioned project config schema.
- [ ] **GitHub App scope card**: lists what Tanren can and cannot do on this repo — clone & push from runner workspaces, open draft PRs from `tanren/spec_*` branches, poll CI status, read org members for review routing; never push main, never bypass protection, never force-push.
- [ ] **Confirmation**: submitting the form creates the project row via P2A-0013 (which reads target-repo files for display but writes nothing) and routes the operator to the project view.

## Reductions from the hi-fi (now superseded by the full brownfield track)

This minimal surface is link-only; the steps below shipped as the separate **full brownfield track**:

- **Read-only answerer recon (hi-fi step 2)**: shipped — the brownfield recon indexes the target repo (`engine/forge/brownfield/**`).
- **Config-injection PR (hi-fi step 3)**: shipped — the full track authors a config-injection PR against the target repo (`engine/forge/brownfield/configInjection.ts` + `githubConfigInjection.ts`). It emits the native `.tanren/ci.yml` gate config (a `CiConfigV1`, not a GitHub Actions workflow).
- **Spec DAG + issue ingest (hi-fi step 4)**: the workflow-intent importer + candidate inbox ship; deriving specs from agent gaps + issue ingest are wired (`engine/forge/inbox/**`, `engine/forge/brownfield/workflowIntent.ts`).
- **Governance posture picker (hi-fi step 5)**: shipped — `strict | open | audit_only` is real merge-time behavior (`engine/workflow/reviewMerge/governancePosture.ts`).

## Done when

An operator can link `cat-cave/tanren-fixture-easy` (or another GitHub repo their org owns) as a Tanren project through the dashboard, fill a project config form, and land on a working project view with no CLI or DB writes — and Tanren has written nothing to the target repo.
