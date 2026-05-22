# GitHub Workflow Playbook

Use short-lived branches named for the roadmap spec or fix. Keep changes scoped to declared owned paths.

Mergify stacks are the default workflow for Phase 1 and later dependent PRs. Use manual branch chains only if stack tooling is unavailable.

## Pull Requests

- Open PRs as drafts until local checks and the relevant compose smoke pass.
- Include the spec, owned paths, test results, and any version-verification sources.
- Keep `permissions: contents: read` in CI unless the PR explicitly implements a workflow needing additional permissions.
- Do not merge with failing checks.

## Mergify Stacks

- Create new dependent work with `mergify stack new <name>`.
- Push and create/update PRs with `mergify stack push`.
- Keep each commit self-contained; each commit becomes its own PR and must pass CI independently.
- Put the PR title, context, and validation in the commit message because stack pushes derive PR metadata from commits.
- Amend the relevant commit for fixes instead of adding cleanup commits.
- If amending a pushed commit, add a `mergify stack note -m "<reason>"` before pushing so reviewers can see why the revision changed.
- Keep stacks short. Independent specs should be separate stacks.
- Do not manually edit stack-managed PR titles/bodies or manually merge stack PRs.

Phase 1 lesson: manual stack merging is fragile. After one stacked PR lands, run `mergify stack sync` before updating remaining work. If a stack becomes dirty after a squash/rebase merge, prefer a clean stack-tool sync or a new short replacement stack over manual retargeting. Long dependent stacks should be split unless every commit genuinely depends on the prior commit.

## Review And Merge

Address requested changes in the same branch. If review feedback changes a shared contract, update dependent specs before merging. Merge only after CI is green and required review policy is satisfied.

## CI Expectations

The required local gate is `corepack pnpm run check`. Infrastructure or workflow changes also need the compose smoke described in `AGENTS.md`.

Use `just fast-check` for a quicker pre-push signal when iterating, then run the full gate before marking work ready.
