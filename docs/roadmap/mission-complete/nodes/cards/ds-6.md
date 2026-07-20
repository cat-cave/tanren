<!-- cspell:ignore proofkey proofbacked premerge -->

# ds-6 — Queue/deploy/demo compounding (A4 ≡ demo)

**Phase**: full (design-system)
**Node ID**: `ds-6`
**Deps**: ds-4, ds-5 · SP-5/SP-4/SP-3
**Node credit**: **0** until independent audit, full green gates, and merge

## Purpose and boundary

Make an accepted design system compound through the actual integration queue and live,
proof-backed demo: each eager integrated matrix cell carries the already-defined design proof
key and is reconciled to the released artifact and runtime acceptance. It builds on the frozen
six-field `deriveDesignProofKey` in `engine/design/system/designProofKey.ts`, ds-4's
`verifyAndRecordDesignRender` / `verifyComposedDesignSystemRender`, queue proof-unit authority
in `engine/merge/batchIntegrationNodeDrive.ts` and `engine/dag/integrationProofUnits.ts`, and
the post-deploy `ProofBackedWebDemo.demo` in `engine/demo/proofBackedWebDemo.ts`. It extends,
not forks, those systems: A4 render evidence is not a mock demo and a demo result is not a new
design verifier.

## Production call graph

`BatchMergeCoordinator.coordinate` → `PgBatchChecker` → existing `driveBatchThroughNode` →
**`DesignAwareDeliveryCoordinator.run`** (new production entry, `phase: "pre_merge"`) →
existing design-system resolver/render verifier + `deriveDesignProofKey` → existing
`IntegrationProofUnitGraph.evaluate` for every eager matrix cell. After land,
`PostMergeSubscriber.runChain` → deploy watcher → `DemoOnDeployWatcher.check` → existing
`ProofBackedWebDemo.demo` → the same **`DesignAwareDeliveryCoordinator.run`**
(`phase: "production"`) links the exact artifact/deployment and behavior verdict to that
pre-merge matrix. The coordinator is called only at those two existing lifecycle seams.

## Contract / Data model

`engine/design/queue/designDeliveryProof.ts` freezes strict `DesignDeliveryProofV1`:
`version: 1`, `schemaVersion: "design_delivery_proof.v1"`, integration node, the exact
six-input `designProofKey`, release/fragment/artifact digests, adapter/environment/scenario,
pre-merge proof-unit/root, render-verdict/screenshot evidence, and production release/deploy /
proof-backed behavior-verdict identities. Refinements require the live artifact digest and
scenario set to equal the pre-merge binding; no client may provide a success boolean.

No migration: the canonical evidence remains in existing RLS-protected
`integration_nodes` / proof-unit records, `design_render_land_verdicts`, release/deployment
records, and behavior-verification evidence. The delivery-proof response is a verified join of
those sources, never a denormalized “green” table; its route must fail on an absent or
ambiguous link.

## Provable / callable / visible

- **Provable**: use the frozen `designRender.scenario.recorded`,
  `designSystem.proof.reused`, and `designSystem.regression.bisected` vocabulary alongside
  `integration.proof_unit.recorded` / `.reused` / `.root.composed`, `deploy.verified`, and
  `demo.completed`. Reuse is allowed only for the exact six-field key.
- **Callable**: add `GET /v1/orgs/:orgId/projects/:projectId/design-delivery-proof` to the
  existing `createDesignStudioRoutes` factory in `routes/designStudio/reads.ts`; it returns
  strict `DesignDeliveryProofV1` cells under the current org/project access checks.
- **Visible**: extend the existing Design Studio `DesignStudioBody` with a delivery trace:
  eager matrix → proof key/root → release/deploy → proof-backed demo. Any missing cell,
  failed assertion, or unobservable behavior is shown as blocked/unknown, never A4≡demo.

## Fail-closed proof

The coordinator must not reuse a cell when any release digest, sorted fragment digest,
adapter target, environment, scenario, or artifact digest differs, and must not report A4≡demo
unless the exact integrated artifact is the deployed live artifact and `ProofBackedWebDemo`
returns observable passing behavior. Render/setup uncertainty, an incomplete eager matrix, a
failed demo, or an ambiguous join produces no delivery proof and blocks the visible trace. The
gravest fail-open is presenting a pre-merge screenshot as a successful live demo for different
bytes. Local tests change each key component and a live artifact/behavior assertion; they prove
recompute or failure, then real-PG/RLS route coverage proves no cross-tenant trace. Independent
adversarial GO uses a 200-but-failing behavior assertion negative control and verifies no
`DesignDeliveryProofV1` claims equivalence.

## Size / migration

Target 850–1,000 lines across coordinator, frozen read contract, queue/demo wiring, Design
Studio API/panel, and tests; split files to keep each under 500. No migration and no edits to
serialized `schema.ts`, `screens.ts`, `main.ts`, or `mountFeatureRoutes.ts`: ds-5 already mounts
both the Design Studio screen and its route factory.

## Acceptance

1. An eager batch matrix records/reuses only exact design proof keys, composes its root, and a
   design-only regression feeds the existing bisector with the frozen bisection event.
2. A landed/deployed web release reaches `ProofBackedWebDemo`; only matching artifact bytes plus
   all observable passing assertions yield a `DesignDeliveryProofV1` and visible A4≡demo trace.
3. Key drift, missing matrix evidence, render infrastructure failure, changed live artifact,
   and a 200-but-failing demo assertion all remain blocked/unknown; focused tests plus
   `just fast-check`, `just ci`, and `just smoke` pass before independent audit GO.
