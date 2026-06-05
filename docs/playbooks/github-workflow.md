# GitHub Workflow Playbook

Parallel work runs in **isolated git worktrees, one unit of work per PR**. Use a short-lived branch named for the roadmap spec or fix, branched off `main`, and keep changes scoped to the declared owned paths. Serialize any PR that edits a DB migration or a shared file (nav, `screens.ts`, `main.ts`).

There is no stack tooling and no Mergify. Each PR is independent and must pass CI on its own; the **native merge queue** (`native_queue`) is the merge engine.

## Pull Requests

- Open PRs as drafts until the local gate and the relevant compose smoke pass.
- Include the spec, owned paths, test results, and any version-verification sources.
- Keep each PR a single, self-contained unit of work.
- Do not merge with failing checks.

## Review And Merge

Address requested changes in the same branch. If review feedback changes a shared contract, update dependent specs before merging. **Merge only after full green CI and up-to-date-with-`main`** — CI is the gatekeeper.

## CI Expectations

The full gate is **`just ci`** (`just fast-check` for the non-build steps) **plus `just smoke`**. Run them before pushing. Use `just fast-check` for a quicker pre-push signal when iterating, then run the full gate before marking work ready. Infrastructure or workflow changes also need the compose smoke described in `AGENTS.md`.
