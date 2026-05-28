# Operator-driven run (P2B-0006)

This is the end-to-end runbook for the operator-driven live workflow: bring up
the stack, sign in, onboard a project, write a spec, **trigger the run from the
dashboard**, watch it live, and read the finished run in history. It threads
together every Phase 2B surface (P2B-0001…0005 + P2B-0008) around the one new
affordance this spec adds — the **▶ start a run** button on each spec row.

The run-trigger is the only place in the dashboard that starts work. Everything
else (onboarding, spec creation, run-detail, history/costs, recovery) already
exists; this guide is the seam that connects them.

## 1. Bring up the stack

```sh
just up-dev
```

The dashboard serves at <http://localhost:3000>; the orchestrator API sits
behind it. Confirm both are healthy before signing in (the dashboard degrades
gracefully when the orchestrator is unreachable, so a blank project list usually
means the API is still starting).

## 2. Sign in

Open <http://localhost:3000>. You land on the project list. Sign in with
**GitHub OAuth** — see [auth.md](./auth.md) for the OAuth app setup and the
`TANREN_REQUIRE_AUTH` dev escape hatch. After sign-in the shell shows your org
in the top-left and your projects in the sidenav.

## 3. Onboard an existing project + import credentials

If you have no project yet, follow the existing-project onboarding flow
(**link a repo** → `/onboarding/existing`). The dashboard reads
`.github/workflows/`, `.mergify.yml`, and `CODEOWNERS` for display and **writes
nothing** to the target repo.

Before a run can do real work it needs CLI credentials (Codex, etc.). Import
them from the credentials surface — see [credentials.md](./credentials.md).
Credentials are stored by reference; their values never appear in the UI or in
run event payloads (redacted by default).

## 4. Create a spec

From the project view, open the spec list (`/projects/:projectId/specs`) and
click **+ new spec**. The form is schema-bound — title, description, at least
one acceptance criterion, an optional milestone, behavior tags, and optional
spec dependencies. There is no raw-config editor. Submitting persists the spec
and returns you to the spec list.

A spec you declare a dependency on must reach `done` before a dependent spec can
run — that gate is enforced at trigger time (step 5).

## 5. Trigger the run from the spec UI

This is the new affordance. On the spec list, every spec row carries a
**▶ start a run** button next to it. Click it.

- The button is a server-rendered `<form method="post">` that POSTs to
  `/projects/:projectId/specs/:specId/run`.
- The dashboard resolves your active org from the shell context, forwards an
  optional branch, and calls the orchestrator's run-from-spec endpoint with
  **`trigger: "dashboard"`** so the run's origin is recorded as the
  operator-driven dashboard flow (vs. `cli` / `api` / `webhook`).
- On success the orchestrator queues a planner run and returns `201` with a run
  summary. The dashboard issues a **303 redirect to `/runs/:runId`** (the live
  run-detail view). Because it is POST-redirect-GET, refreshing the run page
  never re-submits the trigger.

If the trigger is refused, the spec list re-renders with a typed, inline error
on the offending row — these are **meaningful operator feedback, not silent
failures**:

| What you see | Why | What to do |
| --- | --- | --- |
| *this spec is blocked: a spec it depends on has not finished yet* (`409 spec_dependencies_blocked`) | A `dependsOn` spec is not `done`. | Finish the dependency run first, then re-trigger. |
| *this spec is not runnable* (`409 spec_not_runnable`) | The spec already started a run or is not in a runnable state. | Open its existing run from the spec row instead. |
| *you do not have access to start a run for this spec* (`403`) | Org/project access denied. | Check you are in the right org/project. |
| *could not reach the orchestrator* | The API is down. | Confirm the stack is up (step 1), then retry. |

## 6. Watch the run live

The redirect lands you on the run-detail view (`/runs/:runId`, P2B-0004). The
task timeline (plan → write → check → audit → ci), recent events, and the
4-source cost breakdown stream in live over **server-sent events**: the page
subscribes to `/runs/:runId/stream`, a same-origin SSE proxy that forwards the
orchestrator's event feed with your session cookie (the orchestrator URL never
leaks client-side). You watch the planner, writer, checker, and auditor work in
real time without reloading.

## 7. When a run halts → reach the recovery surface

If the run forces a halt — `outcome ∈ {halted, escape_hatch_hit,
retry_budget_exhausted, window_exhausted}` — the run-detail view reflects the
halted state, and the run is routed to the failure-recovery surface (P2B-0008).
Reach it from the sidenav **halted runs** row (`/runs/halted`), which lists
every halted run; each links to its per-run recovery surface at
`/runs/:runId/recover`.

From there the canonical path is **revise the spec → replan**: edit the spec to
address the auditor/checker disagreement, then replan, which queues a fresh
planner run. The full set of four recovery actions and their guardrails is
documented in [failure-recovery.md](./failure-recovery.md). The trigger flow's
job is only to make the halt observable and get you to that surface.

## 8. See the finished run in history + costs

A completed run shows up in the project's run history and on the costs surface
(P2B-0005). The cost bar attributes spend across the **four sources** —
including credits — so you can read what the run actually cost by provider and
model. See [costs.md](./costs.md) for how the 4-source attribution and credit
accounting work.

If the run finished `needs_review`, open the **review** sub-surface from
run-detail to hand it off; the merge-readiness and acceptance criteria are
covered in [acceptance.md](./acceptance.md).

## Where this fits

- Sign-in: [auth.md](./auth.md)
- Credential import: [credentials.md](./credentials.md)
- Halt → recover: [failure-recovery.md](./failure-recovery.md)
- History + 4-source costs: [costs.md](./costs.md)
- Review hand-off + acceptance gate: [acceptance.md](./acceptance.md)
