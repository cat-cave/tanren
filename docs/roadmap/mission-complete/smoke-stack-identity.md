# Smoke stack identity — ownership card

This PR clean-replaces the dependency-only `just smoke` path with one fail-closed
coordinator. A passing receipt must bind every probe to one explicit Compose
project, one clean Git commit/tree, the images built from that tree, and the
candidate stack's discovered endpoints. Decoy/default stacks are negative
controls, never fallbacks.

## Owned paths

- `.github/workflows/ci.yml`
- `.dockerignore`
- `.gitignore`
- `cspell.json` (pgid / process-fence terms only)
- `justfile` (collision-sensitive with control-plane; keep scoped)
- `compose.dev.yml`
- `services/orchestrator/Dockerfile`
- `services/allocator/Dockerfile`
- `services/dashboard/Dockerfile`
- `runner/Dockerfile`
- `cli/src/main.ts`
- `cli/src/httpClient.ts`
- `cli/tests/commands.test.ts`
- `scripts/check-architecture-timeouts.mjs`
- `scripts/check-architecture-timeouts.test.ts`
- `scripts/acceptance/common.ts` (timeout-doctrine field cleanup only)
- `scripts/acceptance/config.ts` (timeout-doctrine field cleanup only)
- `scripts/smoke/plane-split-worker.ts`
- `scripts/smoke/plane-split-deprivilege.ts`
- `scripts/smoke/plane-split-tx.ts` (new)
- `scripts/smoke/plane-split-tx.test.ts` (new)
- `scripts/smoke/stack-db-stage-runners.ts` (new)
- `scripts/dev/seed-platform-creds.test.ts`
- `scripts/dev/seed-platform-creds.ts`
- `scripts/smoke/run-stack.ts` (new)
- `scripts/smoke/stack-bootstrap.ts` (new)
- `scripts/smoke/stack-context.ts` (new)
- `scripts/smoke/stack-paths.ts` (new)
- `scripts/smoke/stack-provenance.ts` (new)
- `scripts/smoke/stack-runtime.ts` (new)
- `scripts/smoke/stack-lifecycle.ts` (new)
- `scripts/smoke/stack-gates.ts` (new)
- `scripts/smoke/stack-operations.ts` (new)
- `scripts/smoke/stack-worker.ts` (new)
- `scripts/smoke/stack-process.ts` (new)
- `scripts/smoke/stack-progress.ts` (new)
- `scripts/smoke/stack-build.ts` (new)
- `scripts/smoke/stack-cleanup.ts` (new)
- `scripts/smoke/stack-stages.ts` (new)
- `scripts/smoke/stack-finalize.ts` (new)
- `scripts/smoke/stack-receipt.ts` (new)
- `scripts/smoke/stack-context.test.ts` (new)
- `scripts/smoke/stack-provenance.test.ts` (new)
- `scripts/smoke/run-stack.test.ts` (new)
- `scripts/smoke/stack-lifecycle.test.ts` (new)
- `scripts/smoke/stack-worker.test.ts` (new)
- `scripts/smoke/stack-process.test.ts` (new)
- `scripts/smoke/stack-build.test.ts` (new)
- `scripts/smoke/stack-cleanup.test.ts` (new)
- `scripts/smoke/stack-operations.test.ts` (new)
- `scripts/smoke/stack-paths.test.ts` (new)
- `scripts/smoke/stack-progress.test.ts` (new)
- `scripts/smoke/stack-receipt.test.ts` (new)
- `scripts/smoke/stack-stages.test.ts` (new)
- `docs/operator-guide/deploy.md`
- `docs/roadmap/mission-complete/README.md`
- `docs/roadmap/mission-complete/smoke-stack-identity.md` (this card)

No DB migration, event registry, event writer, navigation, or product authority
file is owned. Do not edit the frozen `docs/roadmap/mission-complete/build-workflow.mjs.txt`.

## Dependency and merge order

Implementation may proceed from `origin/main` now. The mission-control-plane
unit also edits `justfile`, so this branch must rebase onto and merge **after**
`mission/control-plane-recon`; all other overlaps require explicit coordination
before editing. After that rebase, rerun the full gate and exact-stack smoke
before merge. README/justfile remain collision-sensitive — keep their changes
scoped and report them for later rebase.

Runtime socket selection stays in the already-authorized operator `justfile`
boundary. The TypeScript coordinator accepts only the resulting explicit,
validated provider/socket pair; this unit adds no architecture exception.

## Gate proof

The uncommitted handoff runs the focused adversarial decoy/isolation suite,
affected checks, namespace-masked `just fast-check`, and namespace-masked `just ci`.
Live `just smoke` remains an explicit post-commit, post-rebase prerequisite
because the coordinator correctly rejects a dirty candidate tree; it is not
replaced by a weaker synthetic claim. The eventual JSON receipt records only
non-secret commit/tree, project, image/container, endpoint, and probe evidence.
