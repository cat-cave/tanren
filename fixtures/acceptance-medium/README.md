# tanren-fixture-medium (initial content)

This directory is the initial content the Phase 2A medium acceptance gate
(`just acceptance-medium`, P2A-0015) pushes to the pre-created
`cat-cave/tanren-fixture-medium` GitHub repo on its first run. The medium
acceptance spec is crafted to force the planner to emit at least two
subtasks and to trigger at least one checker-rejection loop, so the
repo needs a multi-file surface to exercise.

Files:

- `src/status.ts` — placeholder `getStatus()` export the writer fills in.
- `tests/status.test.ts` — placeholder vitest case the writer extends.
- `package.json` — minimal vitest setup so CI green is meaningful.
- `README.md` — repo top-level README; the writer adds a "Status" section.

This is fixture content for an acceptance test, not production code.
