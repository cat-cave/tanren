# GitHub Workflow Playbook

Use short-lived branches named for the roadmap spec or fix. Keep changes scoped to declared owned paths.

## Pull Requests

- Open PRs as drafts until local checks and the relevant compose smoke pass.
- Include the spec, owned paths, test results, and any version-verification sources.
- Keep `permissions: contents: read` in CI unless the PR explicitly implements a workflow needing additional permissions.
- Do not merge with failing checks.

## Review And Merge

Address requested changes in the same branch. If review feedback changes a shared contract, update dependent specs before merging. Merge only after CI is green and required review policy is satisfied.

## CI Expectations

The required local gate is `corepack pnpm run check`. Infrastructure or workflow changes also need the compose smoke described in `AGENTS.md`.
