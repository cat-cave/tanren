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
- `justfile`
- `compose.dev.yml`
- `services/orchestrator/Dockerfile`
- `services/allocator/Dockerfile`
- `services/dashboard/Dockerfile`
- `runner/Dockerfile`
- `cli/src/main.ts`
- `cli/tests/commands.test.ts`
- `scripts/smoke/plane-split-worker.ts`
- `scripts/smoke/plane-split-deprivilege.ts`
- `scripts/smoke/run-stack.ts` (new)
- `scripts/smoke/stack-context.ts` (new)
- `scripts/smoke/stack-provenance.ts` (new)
- `scripts/smoke/stack-context.test.ts` (new)
- `scripts/smoke/stack-provenance.test.ts` (new)
- `scripts/smoke/run-stack.test.ts` (new)
- `docs/operator-guide/deploy.md`
- `docs/roadmap/mission-complete/smoke-stack-identity.md` (this card)

No DB migration, event registry, event writer, navigation, or product authority
file is owned.

## Dependency and merge order

Implementation may proceed from `origin/main` now. The mission-control-plane
unit also edits `justfile`, so this branch must rebase onto and merge **after**
`mission/control-plane-recon`; all other overlaps require explicit coordination
before editing. After that rebase, rerun the full gate and exact-stack smoke
before merge.

## Gate proof

Narrow tests and affected checks run during implementation, followed by
`just fast-check`, `just ci`, adversarial decoy/isolation tests, and the strongest
available live exact-stack proof. The final JSON receipt records only non-secret
commit/tree, project, image/container, endpoint, and probe evidence.
