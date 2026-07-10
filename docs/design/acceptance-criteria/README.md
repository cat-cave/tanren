# Acceptance Criteria

One file per operator surface. Each file is the contract a dashboard surface must satisfy. Files are written against the hi-fi vision and the workflow inventory in [`ROADMAP.md`](../../../ROADMAP.md).

**Most of these surfaces have shipped.** The earlier "reduced in v0, deferred to Phase 3" framing is largely superseded: the thick real-LLM Forge (composer answers, propose→approve→execute write actions), the native merge queue (`native_queue` is the merge engine), the DAG canvas + DAG-primary mode, the `stuck` / `review_stall` / `ci_flaky` insights, the brownfield recon + config-injection PR flow, and the org **Overview** command deck (`/overview`, `phase: "2b"`, mounted) are all built. The genuinely-still-unmounted org nav rows are only `/roadmap` and `/personas` (`phase: "3+"` in `services/dashboard/src/app/routes.ts`, absent from `SCREEN_MOUNTS`). Each file marks the shipped items done and keeps only the real remaining reductions.

## Surfaces and owning specs

| Surface                                | File                                     | Owning P2B spec |
| -------------------------------------- | ---------------------------------------- | --------------- |
| Shell + ⌘K palette + auth flow         | `shell-and-palette.md`                   | P2B-0001        |
| Org-setup onboarding (4 steps)         | `onboarding-org-setup.md`                | P2B-0002        |
| Existing-project onboarding (minimal)  | `onboarding-existing-project-minimal.md` | P2B-0002        |
| Credentials management                 | `credentials.md`                         | P2B-0002        |
| Notifications matrix UI                | `notifications-matrix.md`                | P2B-0002        |
| Project + spec management              | `project-and-spec.md`                    | P2B-0003        |
| Routing & limits settings              | `routing-and-limits.md`                  | P2B-0003        |
| Project view (chat-primary)            | `project-view-chat-primary.md`           | P2B-0003        |
| Run detail                             | `run-detail.md`                          | P2B-0004        |
| Review handoff                         | `review-handoff.md`                      | P2B-0004        |
| History & costs                        | `history-and-costs.md`                   | P2B-0005        |
| Failure recovery                       | `failure-recovery.md`                    | P2B-0008        |
| Greenfield new project (stretch, thin) | `onboarding-new-project-thin.md`         | P2B-0009        |

Each acceptance-criteria file follows the same shape:

1. **Surface** — one-sentence summary.
2. **Owning spec** — link.
3. **Hi-fi reference** — pointer to the relevant view file or low-fi import.
4. **In scope for Phase 2** — checklist of behaviors a reviewer can verify against the live dashboard.
5. **Reductions from the hi-fi** — what remains genuinely out of scope (shipped items are marked done).
6. **Done when** — single-sentence exit criterion.
