# Mission-complete control-plane reconciliation

**Unit**: `mission/control-plane-recon`

**Consumes**: PR #931 (`e64c4828`) and the mission handover in PR #932
(`2e4d87ce`).

**Produces**: the fail-closed manifest and scheduler contract that must admit a
consumer node before authoring begins. This unit does not implement a consumer
capability.

## Owned paths

- `docs/roadmap/mission-complete/control-plane-reconciliation.md`
- `docs/roadmap/mission-complete/README.md`
- `docs/roadmap/mission-complete/build-workflow.mjs`
- `docs/roadmap/mission-complete/manifest/index.json`
- `docs/roadmap/mission-complete/manifest/schema.json`
- `docs/roadmap/mission-complete/nodes/cards/mq-1.md`
- `docs/roadmap/mission-complete/nodes/cards/mq-2.md`
- `docs/roadmap/mission-complete/nodes/cards/mq-3.md`
- `docs/roadmap/mission-complete/nodes/cards/mq-4.md`
- `docs/roadmap/mission-complete/nodes/cards/mq-5.md`
- `docs/roadmap/mission-complete/nodes/cards/mq-11.md`
- `scripts/mission-complete/validate-manifest.mjs`
- `scripts/mission-complete/validate-manifest.test.ts`
- `package.json`
- `justfile`

No product source, database migration, event registry, generated contract,
route mount, dashboard navigation, lockfile, or spine contract is owned by this
unit.

## Required behavior

1. Materialize exactly 142 stable node identities: 13 spine-backed claims, 76
   remaining MVP nodes (including the Wave-3 implementation `rv-26`), and 53
   full-tier nodes.
2. Leave `build-workflow.mjs.txt` frozen and copy its orchestration constants
   byte-for-byte into the runnable workflow as historical input. Correct stale
   execution assumptions only in a separate current-state layer: feature
   migrations begin at `0041`, all dependencies resolve to exact IDs, and range
   or generic dependencies cannot enter the ready frontier.
3. Represent node state, dependency merge receipts, owned paths, shared-resource
   leases, clean-replace deletions, events, HTTP/UI surfaces, positive proof,
   negative control, RLS evidence, gate receipts, verifier verdicts, PR state,
   merge SHA, and post-merge proof.
4. Fail closed when a node is marked ready without merged dependencies, complete
   acceptance fields, collision-free ownership, or required shared-resource
   serialization.
5. Detect dependency cycles and report the exact cycle. Cyclic roadmap prose is
   reconciled by separating interface dependencies from final integration
   obligations before a node becomes ready; the checker never silently ignores
   an edge.
6. Treat the 13 spine-backed nodes as audit claims, not automatic completion.
   Each needs behavior, proof, HTTP, UI, and merged-main evidence or it is
   returned to implementation.
7. Keep completion durable: `complete` requires an exact merge SHA plus green
   post-merge proof; an opened or locally green PR never counts as complete.

## Validation

- Checker fixture proves the canonical manifest has exactly 142 unique nodes
  and the declared `13 + 76 + 53` accounting.
- Negative fixtures prove rejection of a missing node, range ID, unresolved or
  generic dependency, cycle, ownership collision, stale migration reservation,
  incomplete ready node, and complete node without post-merge evidence.
- `just affected-typecheck` and the focused manifest test run while editing.
- The unit must pass `just fast-check`, `just ci`, and `just smoke` before
  handoff, then repeat after rebasing onto current `origin/main`.

## Landing dependency

PR #928 overlaps the first merge-queue implementation files and has an unresolved
ordering defect. It may proceed independently because this reconciliation unit
owns documentation and checker wiring only, but `mq-3`/`mq-4` product authoring
cannot claim those overlapping paths until #928 is corrected and landed or
explicitly superseded.
