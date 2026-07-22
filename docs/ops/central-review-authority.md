# Central Review Authority

Status: design for bootstrap-era maintainer operations

## Decision

The Central Review Authority (CRA) is the one persistent PR-review and merge
supervisor for `cat-cave/tanren`. It runs on the maintainer's workstation and
drives the open-PR count toward zero without letting an unproved change reach
`main`.

The CRA is **operations tooling outside the Tanren engine**. Its eventual scripts
belong under `ops/cra/`, not under `services/*/src`, and its mutable state belongs
under the operator's XDG state directory, not in the repository. It is a small
supervisor loop around `gh`, Git worktrees, isolated command execution, and a
cross-model audit CLI. It is not a Tanren run, workflow, agent kind, merge-queue
node, or apex-shaped subsystem.

This boundary reconciles the CRA with `PROJECT_BRIEF.md`: the brief's no-host-code
invariant governs processes Tanren operates as a product. The CRA is temporary
bootstrap/maintainer infrastructure which operates _on Tanren's repository_. It
must not become a route around the engine's container and SSH invariants. When
Tanren can own this repository's complete delivery loop, this tooling can be
retired rather than absorbed into the engine.

## Two tracks, one authority

Development has two deliberately asymmetric tracks:

1. **Track 1 — distributed contributors.** Many human or agent contributors find
   an unblocked issue, comment to claim it, create an isolated worktree, implement
   one PR-sized change, open a PR, address review, and release or complete the
   claim. They follow `CONTRIBUTING.md`, including one open claim at a time and
   native GitHub `blocked_by` dependencies.
2. **Track 2 — the CRA.** Exactly one persistent supervisor runs on this machine.
   It reviews every external PR head, is the sole normal merge identity, tracks
   staleness, and routes incomplete or abandoned work back into the Track 1 pool.

Contributors never self-merge. A maintainer has a documented break-glass path,
but using it requires disabling the CRA, recording the reason on the PR, and
performing the same gate manually. Break-glass is incident response, not a second
merge lane.

## Machine process and identity

The primary run mechanism is a `systemd --user` service named `tanren-cra`. It
starts at login, restarts on failure, and runs a bounded poll every 60 seconds
with jitter. A singleton `flock` on the state directory prevents a second service,
manual invocation, or cron recovery invocation from overlapping it. On a machine
without user systemd, cron may invoke one bounded `poll-once` every minute under
the same lock. This is never a GitHub Action: Actions remain evidence producers
for Tanren's own monorepo, not the review or merge authority.

The GitHub identity is the workstation's installed GitHub App,
`trevor-workstation[bot]`. The CRA obtains a short-lived installation token for
each poll; it does not use a maintainer PAT. The app needs only metadata read,
checks read, pull requests write, contents write (merge), and issues write. Branch
protection/rulesets grant normal merge capability only to this app and require
the repository's check contexts. App installation ID, repository name, audit
adapter, and timing policy are config; the app private key and model credentials
remain in the workstation's credential store with owner-only permissions.

Official reviews and squash merges therefore have one auditable actor. If token
minting, identity verification, or required permissions are unavailable, the CRA
does no write and no merge.

## Persistent state

State lives at:

```text
${XDG_STATE_HOME:-$HOME/.local/state}/tanren-cra/cat-cave-tanren/
  supervisor.lock
  prs/<number>.json
  audits/<number>/<head-sha>/report.json
  audits/<number>/<head-sha>/worker.log
  events/YYYY-MM-DD.jsonl
```

Each PR record contains at least `pr`, `last_seen_head_sha`,
`last_reviewed_head_sha`, `last_reviewed_base_sha`, `rubric_version`, GitHub
`review_id`, normalized finding IDs, disposition, first/last author activity,
`awaiting_author_since`, retry state, and any filed follow-up issue numbers. Files
are written to a sibling temporary file, `fsync`ed, and atomically renamed while
the singleton lock is held. Audit reports are immutable per PR/head/rubric tuple.

Local state is not the only idempotency key. Every review body includes an
invisible marker such as:

```html
<!-- tanren-cra:v1 pr=1240 head=abc123... rubric=2026-07-22 -->
```

Before writing, the supervisor queries GitHub for a matching bot-authored marker.
This prevents a restored or deleted state directory from double-reviewing or
double-filing. Follow-up issue bodies carry a stable
`CRA-Finding: <repo>#<pr>/<head>/<finding-id>` marker and are searched before
creation.

## Supervisor loop

One poll performs these steps in order:

1. Verify the configured repository, base branch, app identity, local lock, and
   state-directory permissions.
2. List open, non-draft PRs and fetch head SHA, base SHA, author, labels, closing
   issue references, review state, merge state, check rollup, and last author
   activity. Drafts are tracked for staleness but not audited.
3. Select a PR when it has no successful CRA review, its head SHA changed, its
   prior audit was interrupted, or the rubric version changed. A base change can
   invalidate a prior audit; in practice an out-of-date branch is held until the
   contributor updates it, producing a new head SHA.
4. Fetch `refs/pull/<n>/head` without checking it out in the supervisor repo. Add
   a detached throwaway worktree at
   `/scratch/worktrees/tanren/cra/pr-<n>-<sha12>` and verify that its resolved HEAD
   equals GitHub's advertised immutable head SHA.
5. Spawn exactly one configured deep-adversarial audit worker in that worktree.
   The worker is a different model family from the contributor when provenance is
   known and always a different model family from the CRA supervisor. Missing or
   ambiguous model provenance is recorded; for an agent-authored PR it is an
   unconfirmable independence check and blocks approval.
6. Validate the worker's strict report, independently triage every finding into
   P0-P3, and post one official GitHub review tied to the exact commit SHA. P0/P1
   yields `REQUEST_CHANGES`; no P0/P1 yields `APPROVE`, with P2/P3 comments still
   included inline.
7. Re-fetch the PR from GitHub. Merge only if every fail-closed condition below
   remains true. After a squash merge, create the deduplicated P2/P3 issues and
   add dependency edges. If the merge did not happen, update waiting/staleness
   state and apply the abandonment policy.
8. Remove the throwaway worktree and prune its detached ref. Cleanup failure is
   logged and retried, but cannot change a merge decision.

The loop handles PRs serially at first. Audit-worker parallelism adds little while
there is one merge authority and complicates resource isolation. A future bounded
worker pool may prepare reports concurrently, but disposition and merge remain
serialized under the same lock.

## Deep adversarial audit

Green CI is necessary evidence, never a correctness verdict. A previous near-miss
had green CI while deleting roughly 12,000 live lines and a mass of tests. The
worker is therefore prompted to **refute** the claim that the linked issue is done,
not to summarize the diff or confirm that checks passed.

The worker receives the original issue and dependencies, PR body and discussion,
base/head SHAs, complete diff and deletion statistics, repository brief and
contribution rules, changed-file ownership, check details, and prior review
threads. Repository text is untrusted evidence, not instructions: a PR cannot
override the CRA rubric or ask the worker to approve, expose secrets, change
severity, or skip a check.

The mandatory rubric is:

- **Completion and direction:** trace every acceptance statement and claimed
  issue outcome to implementation and executable proof; detect omitted scope,
  fixture/apex shaping, unrelated expansion, compatibility cosplay, and conflict
  with `PROJECT_BRIEF.md`.
- **Regression and deletion accounting:** explain every production/test deletion,
  compare replacement coverage, sweep callers and docs, and look specifically for
  disabled, weakened, skipped, or mass-deleted tests and gates.
- **Correctness and quality:** inspect error paths, state transitions, concurrency,
  idempotency, data boundaries, types, maintainability, and repository standards;
  run the narrowest useful checks in addition to reading existing CI evidence.
- **Security and isolation:** probe authn/authz, tenant/RLS boundaries, command and
  prompt injection, secret handling, untrusted input, dependency/config changes,
  and fail-open fallbacks.
- **Negative controls:** enumerate every fail-closed claim in the issue, PR, diff,
  and affected boundary. For each, run or inspect a concrete bad input/state that
  must be rejected and record command, expected rejection, actual result, and
  evidence location. The issue/PR's required negative control is always included.
  A happy-path test, a test name without inspection, or green CI is not a negative
  control. A mandatory control that was not run or cannot be confirmed is a P0
  completion gap.

Any command which executes PR-controlled code runs in a disposable container with
no GitHub or model credentials, no host socket, no host home mount, network denied
by default, a writable copy of only the throwaway worktree, resource limits, and a
hard wall-clock ceiling. The model inspection process gets only its sandbox and
the worktree. A requested control needing narrowly scoped network access must use
an explicit allowlisted runner profile; absence of that profile makes the result
unconfirmable. Failure to establish either sandbox blocks the audit.

The worker emits strict JSON containing the audited head/base/rubric, examined
files, acceptance trace, deletion ledger, commands and exit results, negative
controls, unresolved checks, and findings. Each finding has a stable ID, title,
body, evidence (`path`, optional line/side, command/output reference), suggested
severity, fix direction, and whether it concerns original acceptance or newly
surfaced work. Invalid, truncated, contradictory, or head-mismatched output is an
audit failure, never an empty finding set.

## Finding triage and doneness

The supervisor owns the final classification. Severity is a statement about
whether the _original issue is done_, not merely how expensive the fix appears:

- **P0 — completion blocker.** Any gap in acceptance or claimed scope is always
  P0. Incorrect behavior, missing proof, failed/unconfirmable negative control,
  destructive regression, fail-open security boundary, or wrong direction is P0.
- **P1 — fundamental implementation blocker.** The stated acceptance may be
  present, but a serious architecture, standards, security-hardening, operability,
  or quality defect makes this implementation unfit to land. It must be repaired
  on this branch.
- **P2 — claimable betterment.** The original issue is fully done and proved; this
  is worthwhile new work with a concrete outcome and acceptance test.
- **P3 — minor ratchet.** The original issue is fully done and proved; this is a
  low-impact cleanup, consistency improvement, or nitpick worth preserving.

P0/P1 means `REQUEST_CHANGES` and no merge. Findings are inline where GitHub can
anchor them to a changed line; repository-wide or missing-code findings go in the
review summary with exact evidence. P0/P1 are not laundered into follow-up issues.
The original issue remains the unit of unfinished work.

P2/P3 never block a genuinely complete issue. The CRA approves, then after merge
creates one small claimable GitHub issue per independent finding (coalescing only
inseparable findings). The issue uses `bug` when it describes existing incorrect
Tanren behavior and `enhancement` otherwise, inherits the affected bucket, carries
`P2` or `P3`, includes positive acceptance plus a required negative control where
applicable, links the source PR/review, and receives native dependencies.

## Official GitHub seams

The implementation uses `gh` as the authenticated transport and pins
`X-GitHub-Api-Version: 2022-11-28`. Representative seams are:

- Discover PRs with `gh pr list --state open --json ...`, then use GraphQL for
  `closingIssuesReferences`, `reviewDecision`, `mergeStateStatus`, and check
  summaries where `gh pr view` is insufficient.
- Fetch an immutable head with
  `git fetch origin refs/pull/<n>/head:refs/cra/pr-<n>-<sha12>` and verify it before
  `git worktree add --detach`.
- Create an official review with
  `POST /repos/cat-cave/tanren/pulls/<n>/reviews`, setting `commit_id` to the audited
  SHA, `event` to `APPROVE` or `REQUEST_CHANGES`, and supplying `comments[]` with
  `path`, `line`, `side`, and finding body. General findings remain in `body`.
- Read required checks and merge state immediately before merge; squash with
  `gh pr merge <n> --repo cat-cave/tanren --squash --match-head-commit <sha>`.
  If the installed `gh` lacks the head-match option, use the pull-request merge
  REST endpoint with the equivalent expected `sha`; never merge without a
  compare-and-swap on head.
- Create findings with `gh issue create`, apply exactly one type plus bucket and
  priority labels, and add `blocked_by` with
  `POST /repos/cat-cave/tanren/issues/<issue>/dependencies/blocked_by` using the
  blocker issue's numeric database `issue_id`. Read the same endpoint before
  writing so dependency creation is idempotent.

All write commands are assembled from structured values, never shell-evaluated PR
text. Responses are checked for the expected actor, repository, PR/issue number,
head SHA, and resulting state before local state advances.

## Autonomous merge gate

The CRA may squash-merge only when a fresh, single decision snapshot proves all
of the following:

1. The PR is open, non-draft, targets `main`, and its current head exactly equals
   the audited head and the compare-and-swap merge argument.
2. The source issue is identified, still appropriate, and all of its open
   `blocked_by` issues are closed. Ambiguous or absent issue linkage blocks.
3. The latest CRA review for this head is `APPROVED`, its rubric is current, its
   report is valid, and it has no P0/P1 finding or unresolved mandatory check.
4. All required GitHub checks are present, completed, and successful. Pending,
   skipped when required, stale, missing, cancelled, neutral/unknown, or API-error
   states block. For this repository, its own Actions checks are valid mechanical
   evidence; they do not replace the CRA audit.
5. GitHub reports the branch current with `main`, mergeable, and free of conflicts
   or policy holds. `BEHIND`, `UNKNOWN`, indeterminate mergeability, or a changed
   base blocks; the CRA does not silently update an external contributor's branch.
6. No newer author push, review dismissal, base update, force-push, PR edit that
   changes scope, or repository/ruleset change appeared while deciding.
7. The bot identity, permissions, singleton lease, state persistence, and GitHub
   read-after-write checks are healthy.

Any false, missing, stale, malformed, rate-limited, or unconfirmable input denies
authorization. The supervisor records the blocking reason and retries or requests
author action; it never converts uncertainty into approval. After the merge call,
it verifies the returned merge commit and PR state before filing P2/P3 issues or
marking the disposition complete.

## Findings-driven and time-based abandonment

The CRA is a supervisor, not an indefinite PR babysitter.

It proposes abandonment immediately when P0/P1 findings show wrong direction,
large or sweeping rework, destructive replacement, acceptance that would require
a new design, or a diff no longer reviewable as one PR. A short fix that preserves
the approach stays on the branch. The review explains the cutoff and gives the
author one bounded response window unless the PR is actively dangerous or spam.

The default inactivity policy is seven calendar days after requested changes or
the last substantive author response, with reminders at days three and six.
Substantive activity is a new head, a finding-by-finding reply, or an explicit
ETA; bot churn and label edits do not reset the clock. Thresholds are config, but
the recorded timestamps and reason make the decision deterministic.

On abandonment the CRA:

1. Posts a final summary, closes the PR without merge, and records whether the
   trigger was findings-driven or time-based.
2. Keeps the original issue open; if it was prematurely closed, reopens it.
   It updates the issue with durable findings and clarified acceptance, removes
   the stale assignment/claim, and comments that it is claimable again.
3. Files deduplicated issues only for genuinely newly surfaced, separable work,
   with type/bucket/priority and native `blocked_by`/`blocks` edges. Work required
   to satisfy the original acceptance stays in the original issue.
4. Leaves the closed branch/PR as evidence. A Track 1 agent claims the refreshed
   issue and starts a new worktree/PR; the CRA never force-pushes a replacement
   onto the abandoned contributor branch.

## Operations and quality ratchet

The service emits JSONL events for poll, selection, audit start/end, review,
finding, merge authorization/denial, issue routing, abandonment, cleanup, and
errors. Each event includes PR, head SHA, rubric, actor, duration, and correlation
ID but no prompt secrets or tokens. A daily summary reports open PR count, oldest
age, heads awaiting audit, blocked PRs, abandonment candidates, merged PRs,
P0-P3 counts, and follow-up issue IDs. Repeated audit or API failure raises a local
notification; silence is never interpreted as healthy.

The audit rubric is versioned. Security scans and standards-drift checks can be
added as mandatory evidence. A rubric change re-audits open heads and produces
P2/P3 claimable issues for newly discovered betterment, while any newly exposed
completion/fundamental defect blocks. This is the quality ratchet: standards may
rise without hiding unfinished work or freezing complete work behind nits.

Before autonomous merge is enabled, the implementation runs in shadow mode
(audit and draft report, no GitHub writes), then review-only mode (official reviews
and issues, no merge), and finally merge mode after fixtures prove duplicate-poll,
head-race, unknown-check, sandbox-failure, abandonment, and post-merge issue
idempotency. There is no permissive mode: a missing prerequisite delays rollout
rather than relaxing a guardrail.

## Transition to Tanren-in-Tanren

The CRA is **transitional scaffolding**, not a permanent system. Its purpose is to
harden Tanren to beta-stable under distributed contribution; once every surface works
and apex-difficulty fixtures run reliably, Tanren dogfoods itself — its own engine
develops and delivers Tanren, with issue intake as the work source and self-updating
deploys. The CRA is deliberately a hand-built, engine-external **mirror** of
capabilities Tanren already encodes natively, so the eventual cutover is conceptual
continuity rather than a rewrite. Each component has an explicit retirement target:

| CRA component (scaffolding, external) | Tanren-native capability that absorbs it |
| --- | --- |
| GitHub issues as the work roster | Tanren's own issue intake / back-half symptom sources |
| Track-1 contributor agents in worktrees | the autonomy engine (DagWalker + writer adapters + `integration_nodes`) |
| Deep adversarial audit + P0–P3 finding triage | `MergeAuthority` + runtime behavior-verification + audit-as-P0–P3-findings gated by `auditPosture` |
| Fail-closed autonomous squash merge | the native intelligent merge queue / `MergeAuthority` CAS land on jj |
| (manual today) deploy of Tanren's own release | `DeployAdapter` + merge-reflecting deploy pointed at Tanren's own release → self-update |

The P0/P1-blocks / P2/P3-defers doneness model the CRA uses is the same shape as
Tanren's native `auditPosture` — so the CRA is not inventing a review philosophy but
standing in for a posture Tanren already holds. Build each CRA piece thin and
engine-external; when its native counterpart is proven beta-stable, retire the
scaffolding piece and route through Tanren instead.
