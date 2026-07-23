# Contributing to Tanren

Tanren is the engine for end-to-end agentic code delivery. Start with the
[README](README.md) for the product and current proof state, then use this guide
to contribute a small, auditable engine change.

## Contribution flow

The live work roster is GitHub issues. Every issue carries a **type** (exactly one:
`bug` for a failure in Tanren itself — not in a product Tanren built — or
`enhancement` for a scoped, PR-sized engine capability). Triage adds a **bucket**
(`runtime` / `governance` / `back-half` / `merge-queue`) and a **priority** (`P1`
critical / `P2` normal / `P3` low). Ordering is native GitHub issue dependencies:
`A blocked_by B` means B lands first. There is no wave or milestone scheme.

1. Pick a ready issue and [claim it](#claiming-an-issue).
2. Work from an isolated Git worktree on a short-lived branch.
3. Keep one independently reviewable unit of work in each PR.
4. Open the PR with the [PR template](.github/pull_request_template.md) and
   reference the issue (`Closes #N`). Use the [enhancement issue
   template](.github/ISSUE_TEMPLATE/enhancement.yml) or [bug issue
   template](.github/ISSUE_TEMPLATE/bug.yml) to record the capability, seam, and
   required negative control when filing.
5. Submit it for central audit, address findings on the same branch, and merge
   only after the audit and gate evidence are green and the branch is current
   with `main`.

For the broader parallel-work protocol, including path ownership and dependency
planning, read the [parallel orchestration playbook](docs/playbooks/parallel-orchestration.md).

## Claiming an issue

There is no claim bot, and external contributors do not have write access, so the
mechanism is deliberately simple:

1. **Pick a ready issue.** An issue is ready only when it is not `blocked_by` an
   open issue — check the issue's Dependencies panel ("blocked by"). Skip anything
   still blocked; its blocker lands first.
2. **Comment to claim it.** Say you're taking it; a maintainer assigns it to you.
   Hold **one** open claim at a time.
3. **Release if you stall.** If you can't finish, comment to release it so someone
   else can pick it up. Reclaiming an abandoned claim is currently manual — a
   maintainer may reassign an issue whose claim is stale and has no PR activity.

## Feature requests & questions

Propose ideas and feature requests in **[Discussions →
Ideas](https://github.com/cat-cave/tanren/discussions/new?category=ideas)**, and ask
questions in **[Discussions →
Q&A](https://github.com/cat-cave/tanren/discussions/new?category=q-a)**. File a
GitHub issue only for an actionable bug or a scoped engine task.

## Worktree and PR discipline

Declare and respect the paths your work owns. Parallel PRs must have disjoint
paths. Serialize any PR that edits a database migration or a shared composition
file, including navigation, `screens.ts`, or `main.ts`; a migration has one
owner and one serialized slot. Do not make concurrent edits to those barriers.

Target roughly 1,000 changed lines or fewer per PR. Split larger work into a
chain of small PRs rather than one broad change. Each PR must state its issue,
owned paths, validation, and any required merge sequencing in the template.

## The two-layer gate

Never bypass CI. Before review, complete both layers.

1. **Local evidence.** Run `just fast-check`, then `just ci`. For any schema,
   RLS, or org-scoping change, also run the applicable real-Postgres
   `smoke-rls-*` recipe from the `justfile`; Postgres is the ground truth.
   `just ci` does not invoke the RLS smoke recipes. `just smoke` is the full
   stack aggregate when its wider smoke coverage is required.
2. **Adversarial review.** A different model reviews the change against a
   required negative control: a concrete bad input, cross-org access, malformed
   state, or other fail-open case that the change must reject. The reviewer tries
   to refute the claimed fail-closed behavior; a happy-path-only review is not
   sufficient.

The repository uses TypeScript 7's native `tsc`, `oxlint` (including its
type-aware pass), `oxfmt`, Vitest 4, and Turborepo. The `justfile` is the
canonical interface for the gate.

## Database migrations and RLS

Treat every tenant table as a security boundary. A migration adding a tenant
table must enable and force Row-Level Security, define the organization policy
with both `USING` and `WITH CHECK`, and use composite same-organization foreign
keys wherever a relationship crosses tenant-owned tables. Pair the migration
with the applicable real-Postgres RLS smoke proof, including its negative
cross-org or invalid-write case. Coordinate the migration slot before editing:
only one migration PR may occupy it at a time.

## Fixtures are not engine features

An apex-difficulty run is a fixture that exercises Tanren's normal, general
operator flow. Do not add apex-shaped engine code, symbols, comments, workflows,
or hard-coded fixture assumptions. Fixes must be capabilities that any project
or tenant can use. A fixture may be mentioned only as provenance for a general
bug or proof result, never as a special engine path.
