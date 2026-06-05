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
means the API is still starting). If host `:3000` is already in use, set
`DASHBOARD_HOST_PORT` in `.env` (e.g. `DASHBOARD_HOST_PORT=3003`) to remap the
published port and open <http://localhost:3003> instead — the in-container port
stays 3000.

> **Fresh-DB caveat.** The schema makes `org_id` NOT NULL on the core tables
> (runs/tasks/events/cost_records/specs/runners). A dev volume created before
> that constraint existed cannot be backfilled in place, so a live run needs a
> **fresh or reset dev DB**: `just down-dev` (which removes volumes) then
> `just up-dev`, or otherwise drop the orchestrator volume before bringing the
> stack up.

> **CLI-equivalent flow + live gotchas.** This runbook is dashboard-driven; the
> same steps are scriptable with the `tanren` CLI (`docs/operator-guide/cli.md`).
> A live validation run drove the CLI path end-to-end and surfaced gotchas worth
> reading before you start — `tanren orgs config-set` **replaces the whole org
> config** (it is not a deep merge; always send the complete config), org-scoped
> credentials are namespaced `credential/<slug>/org/<orgId>/<name>` and must be
> imported through the org-scoped surface (the legacy top-level routes do not
> populate the credential list), and the default credential registry is
> in-memory (creds vanish on orchestrator restart). The full set of findings +
> exactly where the live demo stands is in
> [live-validation-findings.md](./live-validation-findings.md).

## 2. Sign in

Open <http://localhost:3000> (or your remapped `DASHBOARD_HOST_PORT`). With the
dev escape hatch on (`TANREN_DEV_LOGIN=1`, `TANREN_REQUIRE_AUTH=1`) you are sent
to **`/signin`**: click **"sign in (dev)"** — a single URL, one click. The
dashboard completes the `local_dev` handshake server-side and lands you
authenticated back at your destination (`next`), no cross-origin hop. For real
deployments, sign in with **GitHub OAuth** instead. See [auth.md](./auth.md) for
both flows and the OAuth app setup. After sign-in the shell shows your org in
the top-left and your projects in the sidenav.

## 3. Onboard an existing project + import credentials

If you have no project yet, follow the existing-project onboarding flow
(**link a repo** → `/onboarding/existing`). The native gate config Tanren reads
is `.tanren/ci.yml` (a `CiConfigV1`); the dashboard reads it and `CODEOWNERS` for
display and **writes nothing** to the target repo at link time. (A brownfield
link can later _propose_ `.tanren/ci.yml` as an injected file for the operator to
approve.)

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

A spec you declare a dependency on must reach `merged` before a dependent spec
can run — that gate is enforced at trigger time (step 5).

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

| What you see                                                                                        | Why                                                           | What to do                                        |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------- |
| _this spec is blocked: a spec it depends on has not finished yet_ (`409 spec_dependencies_blocked`) | A `dependsOn` spec is not `merged`.                           | Finish the dependency run first, then re-trigger. |
| _this spec is not runnable_ (`409 spec_not_runnable`)                                               | The spec already started a run or is not in a runnable state. | Open its existing run from the spec row instead.  |
| _you do not have access to start a run for this spec_ (`403`)                                       | Org/project access denied.                                    | Check you are in the right org/project.           |
| _could not reach the orchestrator_                                                                  | The API is down.                                              | Confirm the stack is up (step 1), then retry.     |

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

## 7b. Resolve a `needs_attention` escalation (requeue a stuck spec)

When a spec exhausts its bounded retry budget — the NEVER-STRAND reconciler
re-enqueued it the capped number of times with no progress, or the merge queue
judged its conflict genuinely irreconcilable — it parks at the terminal
`needs_attention` status. That frees the DAG slot but **blocks its dependents**:
the autonomous walker will not route past it on its own, because a human must
DECIDE how to unblock it (the escalation discipline). Once you have **addressed
the underlying blocker** (fixed a platform bug, re-scoped a dependency, etc.),
tell Tanren to proceed:

- **`POST /orgs/:orgId/projects/:projectId/specs/:specId/requeue`** (org-admin).
  It flips the spec `needs_attention → open` so the DagWalker re-picks it up,
  **resets its bounded re-enqueue budget** (so it genuinely re-runs the full
  retry budget rather than immediately re-escalating off the old halt history),
  and emits an actor-stamped `dag.spec.attention_resolved` audit event. The
  response carries the spec's new `open` status and which subsystem had parked it.
- A spec **not** parked at `needs_attention` is a clean `409 spec_not_in_attention`
  — the action never silently re-transitions a running/merged/open spec.

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
