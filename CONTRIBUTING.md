# Contributing to Tanren

Tanren is the engine for end-to-end agentic code delivery. Start with the
[README](README.md) for the product and current proof state, then use this guide
to contribute a small, auditable engine change.

## Contribution flow

The live work roster is GitHub issues, not the historical ledger. Claim a planned
engine node labelled `node`, or file an engine bug labelled `bug`. A bug is a
failure in Tanren itself, not in a product Tanren built.

1. Work from an isolated Git worktree on a short-lived branch.
2. Keep one independently reviewable unit of work in each PR.
3. Open the PR with the [PR template](.github/pull_request_template.md); use the
   [node issue template](.github/ISSUE_TEMPLATE/node.yml) or [bug issue
   template](.github/ISSUE_TEMPLATE/bug.yml) to record the capability, seam, and
   required negative control.
4. Submit it for central audit, address findings on the same branch, and merge
   only after the audit and gate evidence are green and the branch is current
   with `main`.

For the broader parallel-work protocol, including path ownership and dependency
planning, read the [parallel orchestration playbook](docs/playbooks/parallel-orchestration.md).

## Worktree and PR discipline

Declare and respect the paths your work owns. Parallel PRs must have disjoint
paths. Serialize any PR that edits a database migration or a shared composition
file, including navigation, `screens.ts`, or `main.ts`; a migration has one
owner and one serialized slot. Do not make concurrent edits to those barriers.

Target roughly 1,000 changed lines or fewer per node. Split larger work into a
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
