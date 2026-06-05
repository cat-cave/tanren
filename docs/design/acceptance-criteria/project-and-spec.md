# Project + spec management

**Surface**: project list, project detail (settings sub-sections), and spec creation.

**Owning spec**: P2B-0003 (see [`ROADMAP.md`](../../../ROADMAP.md)).

**Hi-fi reference**: spec creation reachable from project view ("discover spec ↗"); project settings reachable from sidenav. Low-fi import at `docs/design/operator-flows/project-and-spec.svg`.

## In scope for Phase 2

- [ ] **Project list / org overview placeholder**: the sidenav `overview` row is a placeholder; the org's projects are visible via the topbar project switcher. Phase 3 elevates this to a richer overview.
- [ ] **Project detail tabs**: settings (routing & limits — see `routing-and-limits.md`), governance (read-only display of detected `.github/workflows/` and `CODEOWNERS` from the linked repo; `.mergify.yml` is no longer read — Mergify was removed in Phase 2 P2e-2), notifications (per-project overrides on org defaults), behaviors/milestones (CRUD against P2A-0018).
- [ ] **Spec creation surface**: title, description, acceptance criteria (free-text plus a structured behaviors picker), milestone assignment (from existing milestones on the project), priority pill, repository target (locked to the project's repo), optional spec dependencies (from existing specs). Form validates against P2A-0018 schemas.
- [ ] **Spec list per project**: filterable by status (open / in flight / review / merged / halted), milestone, behavior. Each row links to its current or most-recent run.
- [ ] **No free-text JSON editors**: every field is bound to a typed schema; no raw config blobs.

## Reductions from the hi-fi

- **Forge-mediated spec discovery (hi-fi 02)**: deferred to Phase 3 (thick Forge + DAG canvas).
- **Insight provenance attachment to specs**: deferred to Phase 3.
- **DAG-placement reasoning ("slot in after current p1 work" / "jump the p1 backlog" / "interrupt now" cards)**: deferred to Phase 3 (depends on cross-spec priority/cost analysis).

## Done when

An operator can list a project's specs, create a new spec attached to a milestone and at least one behavior, edit its acceptance criteria, see its run history, and reach run-detail for any past run from the list.
