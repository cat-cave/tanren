# gv-3 — real policy / gate hashes (safety repair)

**Phase**: governance Phase 0 (safety repairs)
**Verdict**: `RETAIN-BUT-REBUILD-PARTS` — retained preparation, not a completed
node. Strict completed-node count remains zero; this card must not be PR'd,
merged, counted, or claimed done.
**Base**: exact current main `9f20c3ea9a4d972a2564374abd16c63ed5f6fe87` (owns
#953, the already-merged GV5 budget work #954, #955, #928, and the #943 org-cost
read model). `82aaa340` is the stale source's parent base, not current main.
**Branch**: `redrive/gv3-exact-main-clean`
**Worktree**: `.codex/worktrees/gv3-exact-main-clean`
**Source archive**: stale branch `node/gv-3-policy-gate-hashes` / worktree
`.codex/worktrees/gv-3-policy-gate-hashes` at `2afd0c6a`, built off `82aaa340`.
Its history carried the already-merged GV5 commit `458f38f8` and the `2118119c`
merge of it, so the stale source was **not** disjoint from GV5. This clean
rebuild reapplies only the GV3 policy/gate-identity semantics from `e1ac7831` +
`5addb58b` and the card-only `2afd0c6a` onto exact current main, deliberately
dropping the GV5 commits and their 13-path collateral (enumerated under Collision
notes) because main already owns GV5.

**Purpose**: close the TOCTOU / proof-identity gap where live MergeAuthority
carries an **empty** `gateConfigHash` and a **schema-literal** `policyVersion`
(`projectConfig.version === 1`). Those make policy-sensitive proof reuse and
land binding illusory. Replace both with deterministic, non-empty content
hashes of the real gate config and governance-sensitive project policy.

## Dependencies

**Spine / shared contracts (read-only)**

- `hashGateConfig` (`engine/dag/integrationProofKey.ts`) — sole stable hash of
  a resolved `CiConfigV1`.
- `resolveCiConfig` (`engine/ci/`) — parse/validate `.tanren/ci.yml`.
- `CodeHost.readFile` — land-time re-read of `.tanren/ci.yml` at the gated head.
- `MergeAuthorityBundle` land binding fields (`gateConfigHash`, `policyVersion`).

**Not modified (event audit envelope)**

- `AuditEnvelope.policyVersion` remains the small integer schema version for
  governing events (event schema is frozen for this unit).

## Rebuilt whole-diff manifest (39 paths)

This is the complete rebuilt diff against exact `9f20c3ea`. Every path is
derivable from the union of `e1ac7831`, `5addb58b`, and the card-only
`2afd0c6a`; no path outside that union is added or deleted.

**New production files (exclusive GV3 ownership)**

- `services/orchestrator/src/engine/governance/policyGateIdentity.ts`
- `services/orchestrator/src/routes/projects/policyIdentity.ts`
- `services/dashboard/src/api/policyIdentity.ts`
- `services/dashboard/src/api/policyIdentityClient.ts`
- `services/dashboard/src/components/config/PolicyIdentityPanel.tsx`

**Modified production files — exclusive GV3 ownership**

- `services/orchestrator/src/engine/merge/mergeAuthorityBundleBuild.ts`
- `services/orchestrator/src/engine/merge/mergeAuthorityGate.ts`
- `services/orchestrator/src/engine/merge/batchChecker.ts` (`resolvePolicyVersion` only)
- `services/orchestrator/src/routes/projects/createConfigGuard.ts`
- `services/orchestrator/src/routes/projects/index.ts` (mount one GET only)
- `services/dashboard/src/components/config/ConfigView.tsx` (render panel only)
- `services/dashboard/src/routes/config/index.tsx` (fetch + pass panel props)

**Modified production files — shared audit-hardening (bounded identity hunks)**

- `services/orchestrator/src/engine/dag/integrationNodesPg.ts`
- `services/orchestrator/src/engine/dag/baseShiftCoordinatorPg.ts`
- `services/orchestrator/src/engine/merge/batchIntegrationNodeDrive.ts`
- `services/orchestrator/src/engine/workflow/projectSpec.ts`
- `services/orchestrator/src/engine/workflow/plannerRun.ts`
- `services/orchestrator/src/engine/workflow/plannerRunJjLocalBootstrap.ts`
- `services/orchestrator/src/engine/worker/runExecutionContext.ts`
- `services/orchestrator/src/engine/providers/githubCodeHost.ts`

**New focused tests (exclusive GV3)**

- `services/orchestrator/tests/policyGateIdentity.test.ts`
- `services/orchestrator/tests/policyIdentityRoutes.test.ts`
- `services/dashboard/tests/policyIdentity.render.test.ts`

**Shared focused test fixtures (bounded identity-only edits)**

- `services/orchestrator/tests/acceptanceHardTier.fixtures.ts`
- `services/orchestrator/tests/auditFindingsMergeGate.test.ts`
- `services/orchestrator/tests/batchIntegrationNodeDrive.test.ts`
- `services/orchestrator/tests/eagerBaseNodeBootstrap.test.ts`
- `services/orchestrator/tests/fixtures/mergeDispatcherConflictFixtures.ts`
- `services/orchestrator/tests/helpers/jjLocalBootstrapFixtures.ts`
- `services/orchestrator/tests/helpers/workerExec.ts`
- `services/orchestrator/tests/integrationNodes.persistence.test.ts`
- `services/orchestrator/tests/integrationNodes.test.ts`
- `services/orchestrator/tests/integrationProofReuse.test.ts`
- `services/orchestrator/tests/mergeAuthority.writerBacked.integration.test.ts`
- `services/orchestrator/tests/mergeAuthorityGate.test.ts`
- `services/orchestrator/tests/plannerRunAuthority.fixtures.ts`
- `services/orchestrator/tests/reviewMerge.fixtures.ts`
- `services/orchestrator/tests/rlsRunLifecycleAuthority.fixtures.ts`

Plus this card: `docs/roadmap/mission-complete/nodes/cards/gv-3.md`.

No migration, event registry/schema, nav, `screens.ts`, or `main.ts`. The
rebuilt diff touches none of the 13 GV5-only paths and preserves current-main
#928/#943 files and cost authority.

## Consumes

- `migrateProjectConfig` for the governance-sensitive field slice.
- `hashGateConfig` as the sole gate-config hash (no second hash algorithm).
- Org-scoped project ownership via `ProjectStore.getOwnership`.

## Produces

- `hashProjectPolicy(config)` → non-empty hex digest over governance-sensitive
  fields (auditPosture, reviewPolicy, governancePosture, mergeIntegration,
  speculation knobs, insight thresholds, tanren/platform logins, budget
  ceiling/period when present). Schema `version` alone never equals this digest.
- `buildMergeAuthorityBundle` stamps `policyVersion` with that digest and
  `gateConfigHash` with a real hash (never `""`).
- `buildBundleForMergeStage` re-reads `.tanren/ci.yml` at `gatedHeadSha` via
  `CodeHost.readFile`, resolves `CiConfigV1`, and hashes it. A genuine 404/absent
  file hashes the canonical default config because that is what the native gate
  executes. Unreadable, malformed-200, or invalid-YAML responses abort bundle
  construction fail-closed; they never masquerade as absence.
- Every integration-node UPSERT requires and atomically persists the exact
  canonical gate/policy hashes used by its proof key. The legacy run-row
  projection and create-time identity-less placeholder write are deleted.
- `GET /:orgId/projects/:projectId/policy-identity` → org-scoped receipt of the
  current policy hash + source field list (runtime-validated).
- Config settings UI surfaces the active project's policy identity receipt with
  actionable failure states.

## Negative controls

- A land bundle that would previously carry `gateConfigHash: ""` is rejected
  (`blank_gate_config_hash`) — merge cannot authorize without a real hash.
- Schema-literal `policyVersion: "1"`, uppercase, whitespace-padded, and malformed
  identities are rejected; only lowercase 64-hex content identities authorize.
- Batch/eager-node persistence proves the exact canonical hashes survive, and
  refuses to issue SQL when either identity is empty or malformed.
- Two configs that differ only in a governance field produce distinct policy
  hashes; two that differ only in non-governance fields (e.g. preview URL)
  share the same policy hash.
- Two CiConfigs that differ only in `when` (load-bearing tier mapping) produce
  distinct gate hashes (existing `hashGateConfig` pin).
- Wrong-org / missing project → 403/404 with no hash leak.

## Validation

- Focused: `policyGateIdentity.test.ts`, `policyIdentityRoutes.test.ts`,
  `policyIdentity.render.test.ts`.
- Existing merge-authority / batch tests still green under real hashes.
- `just affected-typecheck` / `affected-test`, then `just fast-check` + `just ci`.
  No smoke.

## Serialized database follow-up — completion gate

GV-3 is **retained but frozen**; it is not complete and must not be PR'd,
merged, counted, or claimed done. The verified migration train is
`IN1 0041 -> RV4 0042 -> GV1 0043 -> GV2 0044 -> MQ1 0045 -> GV3 0046`, so GV-3
owns the terminal slot `0046` — not `0042` and not any earlier ordinal. The card
is frozen until GV-2's reviewed head composes; before re-entering the build it
must restack #928, compose GV-2's reviewed-head binding in `mergeAuthorityGate`
/ bundle build, compose GV-1 / #856 route and config edits as applicable, add
the DB clean-replacement constraints / purge / no-default migration `0046` (the
six-step follow-up below), close the typed-event and eager-write fail-closed
gaps, and rerun live Postgres / RLS / full gates / smoke / audit before PR /
merge / count. This node design is not rewritten; only the migration slot and
the serialized upstream dependencies are corrected here.

GV-3 is still **not complete** until the database boundary enforces the same
canonical identities. `db/src/schemaCore.ts` still gives both columns
`.default("")`, and the collapsed baseline still creates `gate_config_hash` /
`policy_version` with `DEFAULT ''`. This bounded repair deliberately did not
take a migration number while IN-1 owned migration `0041`; the serialized DB
follow-up is migration `0046`. It must:

1. delete proofs attached to integration nodes whose stored identities are not
   canonical lowercase 64-hex;
2. delete those unverifiable legacy nodes (their exact historic config/policy
   content cannot be honestly reconstructed or backfilled);
3. `ALTER COLUMN gate_config_hash DROP DEFAULT` and `ALTER COLUMN policy_version
DROP DEFAULT`;
4. add database `CHECK` constraints requiring `^[0-9a-f]{64}$` for both columns;
5. remove both Drizzle `.default("")` declarations and model the same checks in
   `schemaCore.ts`; and
6. generate migration `0046`, snapshot, and journal entry after MQ-1/`0045`
   lands (the slot immediately preceding GV-3's in the serialized train), then
   re-run this card's full validation.

Production write-path search proof: the sole `INSERT INTO integration_nodes` is
`upsertIntegrationNodeOnClient`; its only production model callers are the batch
integration drive and eager-base bootstrap. Both now supply exact validated
identities, and readers reject legacy empty/malformed rows. The outstanding
schema migration above remains the live go/no-go gate for declaring GV-3 done.

## Collision notes

The **rebuilt** diff is disjoint from all 13 GV5-only paths
(`docs/roadmap/mission-complete/nodes/cards/gv-5.md`,
`services/dashboard/src/api/budget.ts`,
`services/dashboard/src/components/budget/BudgetBody.tsx`,
`services/dashboard/tests/budget.render.test.ts`,
`services/orchestrator/src/engine/dag/budgetPause.ts`,
`services/orchestrator/src/engine/dag/budgetPauseObservation.ts`,
`services/orchestrator/src/engine/dag/walker.ts`,
`services/orchestrator/src/routes/projects/budget.ts`,
`services/orchestrator/tests/budgetPauseObservation.rls.integration.test.ts`,
`services/orchestrator/tests/budgetRoutes.test.ts`,
`services/orchestrator/tests/conformance/dagWalker.conformance.test.ts`,
`services/orchestrator/tests/conformance/dagWalkerConformance.ts`,
`services/orchestrator/tests/helpers/routesPool.ts`). The stale source was **not**
disjoint from GV5 — it carried GV5 via the already-merged `458f38f8` and the
`2118119c` merge. This clean rebuild deliberately drops those two commits and the
13-path collateral above because current main already owns GV5 (#954). It does
not replay `458f38f8` or `2118119c`.

The rebuilt diff is otherwise disjoint from active lanes it does not own:
gv-1 (auditPosture guard + governance settings UI), gv-4 (stack retarget), mq-1
(signal classification + event registry), rv-4 (behavior coverage), in-1
(integration lifecycle + mig 0041), #928 recovery, #856 dashboard read-client
redrive. #943's org-cost read model and #955's matrix route ordering are part of
the exact base and are preserved untouched.
