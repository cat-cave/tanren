# Existing-project onboarding (minimal)

**Surface**: linking an existing GitHub repository as a Tanren project, without the brownfield recon agent or config-injection PR.

**Owning spec**: P2B-0002 (`docs/roadmap/phase-2b-specs.md`).

**Hi-fi reference**: `tanren-hi-fidelity/project/view-onboard-existing.jsx` step 1 (link repo) only; remaining hi-fi steps (recon, config-injection PR, DAG seeding, governance posture) ship in Phase 3. Low-fi import at `docs/design/operator-flows/onboarding-existing-project-minimal.svg`.

## In scope for Phase 2

- [ ] **Repo picker**: lists repositories the Tanren GitHub App has access to under the operator's org, with name, description, privacy badge, last-activity timestamp, and a `selected` state. Filter input narrows the list. A "can't see your repo?" link surfaces the GitHub App installation page.
- [ ] **What-happens-next card**: explicitly documents the v0 minimal scope — Tanren reads any existing `.github/workflows/`, `.mergify.yml`, and `CODEOWNERS` for display only, does not write to the target repo, and does not run a recon agent.
- [ ] **Project config form**: after repo selection, the operator fills the project name, default branch, allocator (from the org default), runner image (from the org default), credential refs (from the org's credential bundle list), provider-route preferences (per-role chain prefilled from org defaults). Form validates against P2A-0006 versioned project config schema.
- [ ] **GitHub App scope card**: lists what Tanren can and cannot do on this repo — clone & push from runner workspaces, open draft PRs from `tanren/spec_*` branches, poll CI status, read org members for review routing; never push main, never bypass protection, never force-push.
- [ ] **Confirmation**: submitting the form creates the project row via P2A-0013 (which reads target-repo files for display but writes nothing) and routes the operator to the project view.

## Reductions from the hi-fi

- **Read-only answerer recon (hi-fi step 2)**: Phase 3 brownfield recon agent. v0 does not index the target repo or pre-fill personas/behaviors/architecture from it.
- **Config-injection PR (hi-fi step 3)**: Phase 3. v0 does not author any PR against the target repo. If the target repo lacks the Bucket A files Tanren needs, the project view surfaces a "missing files" warning but the operator handles it via their normal repo workflow.
- **Spec DAG + issue ingest (hi-fi step 4)**: Phase 3. v0 does not derive specs from agent gaps or ingest GitHub issues.
- **Governance posture picker (hi-fi step 5)**: Phase 3. v0 implicitly assumes strict posture; external-push policy is documented but not configurable.

## Done when

An operator can link `cat-cave/tanren-fixture-easy` (or another GitHub repo their org owns) as a Tanren project through the dashboard, fill a project config form, and land on a working project view with no CLI or DB writes — and Tanren has written nothing to the target repo.
