# Phase 2B Acceptance Criteria

One file per operator surface. Each file is the contract a P2B spec must satisfy before its dashboard surface is considered done. Files are written against the hi-fi vision and the Phase 2 workflow inventory in `ROADMAP.md`; per-spec implementation scope (Owns / Consumes / Produces / etc.) lives in `docs/roadmap/phase-2b-specs.md`.

Reductions from the hi-fi as-shown are explicit in each file. They are not "out of scope forever" — they are deferred to Phase 3 per ROADMAP, and the reduction line cites which Phase 3 surface picks them up.

## Surfaces and owning specs

| Surface | File | Owning P2B spec |
|---|---|---|
| Shell + ⌘K palette + auth flow | `shell-and-palette.md` | P2B-0001 |
| Org-setup onboarding (4 steps) | `onboarding-org-setup.md` | P2B-0002 |
| Existing-project onboarding (minimal) | `onboarding-existing-project-minimal.md` | P2B-0002 |
| Credentials management | `credentials.md` | P2B-0002 |
| Notifications matrix UI | `notifications-matrix.md` | P2B-0002 |
| Project + spec management | `project-and-spec.md` | P2B-0003 |
| Routing & limits settings | `routing-and-limits.md` | P2B-0003 |
| Project view (chat-primary) | `project-view-chat-primary.md` | P2B-0003 |
| Run detail | `run-detail.md` | P2B-0004 |
| Review handoff | `review-handoff.md` | P2B-0004 |
| History & costs | `history-and-costs.md` | P2B-0005 |
| Failure recovery | `failure-recovery.md` | P2B-0008 |
| Greenfield new project (stretch, thin) | `onboarding-new-project-thin.md` | P2B-0009 |

Each acceptance-criteria file follows the same shape:

1. **Surface** — one-sentence summary.
2. **Owning spec** — link.
3. **Hi-fi reference** — pointer to the relevant view file or low-fi import.
4. **In scope for Phase 2** — checklist of behaviors a reviewer can verify against the live dashboard.
5. **Reductions from the hi-fi** — what is intentionally out of v0, with the Phase 3 bucket each item lands in.
6. **Done when** — single-sentence exit criterion.
