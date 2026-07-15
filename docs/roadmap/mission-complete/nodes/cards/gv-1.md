# gv-1 — auditPosture write-guard safety repair

**Phase**: governance Phase 0 (safety repairs) · `sm` (small mechanical)
**Base**: `origin/main` `458f38f8edde19fe38a48ad2ae5d2c4d27814ce9` (merged current main at restack; prior base was `e6a6ded0`)
**Branch**: `node/gv-1-audit-posture-write-guard`
**Worktree**: `.codex/worktrees/gv-1-audit-posture-guard`

**Purpose**: close the authorization bypass where a generic member `PATCH
/:orgId/projects/:projectId` can mutate the governance-owned `auditPosture`
setting because it is omitted from the canonical reserved-field guard. Add
`auditPosture` to the reserved-field list with structural/deep equality (it is a
nested object), so a genuine change is rejected while an unchanged value
round-trips untouched. The sole supported *authorization* path for mutating
`auditPosture` remains the org-admin
`PUT /:orgId/projects/:projectId/governance` surface.

Independently, every whole-config writer that shares `projects.config` must use
one expected-snapshot CAS authority (`ProjectStore.updateConfigIfCurrent`) so a
stale sibling write cannot clobber concurrent posture (or budget, credentials,
etc.). No compatibility wrapper and no parallel LWW authority once the leased
integration caller is cut over.

## Dependencies

**Spine / shared contracts (read-only)**

- `ProjectConfigV1` / `migrateProjectConfig`
  (`engine/config/projectConfig.ts`) — the versioned config the guard parses.
- `AuditPostureConfig` (`engine/config/auditPostureConfig.ts`) — the nested
  `{ blockReviewAt, p2p3Handling, autonomousRemediation }` governed setting.

**Reused proof surfaces**

- `routes/projects/governance.ts` — the sole governance PUT (org-admin
  authorized) that legitimately changes `auditPosture` (CAS).
- `routes/projects/index.ts` / `routes/projects/fullConfigPatch.ts` — member
  `PATCH` through the reserved-field guard + CAS.
- `routes/projects/budget.ts` — budget PUT on the same CAS authority (409 on
  conflict).
- `routes/brownfield/fullTrack.ts` — brownfield posture write on the same CAS
  authority (409 on conflict).

**Leased dependency — NOT cut over in this node**

- `services/orchestrator/src/engine/integrations/provisioningEngine.ts` is
  **owned by IN-1**. It still does unconditional
  `ProjectStore.updateConfig` (read-modify-write LWW) when persisting
  provisioned `projectConfig` surfaces. GV-1 must **not** edit that file while
  the lease is live.
- Residual `ProjectStore.updateConfig` remains only for that caller (plus
  conformance harness exercise). **GV-1 is NOT complete** while that writer is
  unconditional.
- **Post-IN-1 cutover for root / restack** (exact, no guessing):
  1. In `persistArtifact` (`provisioningEngine.ts` ~323–327): replace
     `getConfig` + unconditional `updateConfig` with
     `getConfigSnapshot` + `updateConfigIfCurrent(client, projectId, orgId,
     snapshot.config, next, actor)`.
  2. Source `orgId` from the provision request / project ownership (same org
     predicate the CAS SQL already uses: `org_id = $3 OR org_id IS NULL`).
  3. On CAS miss: fail loud or retry once from a fresh snapshot according to
     the provisioning workflow contract (do not silently LWW).
  4. Delete `ProjectStore.updateConfig` and the conformance suite call site that
     only exists to exercise LWW; leave `updateConfigIfCurrent` as the sole
     whole-config writer.
  5. Re-run focused provisioning + `projectConfigCas.integration.test.ts` +
     affected checks; then claim GV-1 complete.

## Exclusive ownership

- `services/orchestrator/src/engine/workflow/projectConfigWriteGuards.ts`
- `services/orchestrator/src/engine/repositories/projects.ts` (CAS authority +
  residual LWW doc until post-IN-1 delete)
- `services/orchestrator/src/routes/projects/fullConfigPatch.ts`
- `services/orchestrator/src/routes/projects/governance.ts`
- `services/orchestrator/src/routes/projects/budget.ts` (CAS convergence)
- `services/orchestrator/src/routes/brownfield/fullTrack.ts` (CAS convergence;
  unleased shared-config writer)
- `services/orchestrator/tests/projectCreateDeployGuard.test.ts`
- `services/orchestrator/tests/governanceRoutes.test.ts` (admin PUT auditPosture
  + bidirectional member/admin interleaving + wrong-org negative)
- `services/orchestrator/tests/budgetRoutes.test.ts` (budget ↔ sibling CAS
  conflict)
- `services/orchestrator/tests/projectConfigCas.integration.test.ts` (real-PG
  JSONB CAS proof; gated `TANREN_RLS_DB_TEST=1`)
- `services/orchestrator/tests/projectAuditPostureCreateAuthority.test.ts`
- `services/orchestrator/tests/helpers/routesPool.ts` (CAS SQL surface; documents
  that stringify equality ≠ JSONB)
- `services/dashboard/src/api/governance.ts`
- `services/dashboard/src/api/governanceClient.ts`
- `services/dashboard/src/routes/governance/index.tsx`
- `services/dashboard/src/components/governance/GovernanceBody.tsx`
- `services/dashboard/src/components/governance/styles.ts`
- `services/dashboard/tests/governance.render.test.ts`
- `docs/roadmap/mission-complete/nodes/cards/gv-1.md`

## Shared-resource leases, not owned paths

- `services/dashboard/src/app/routes.ts` (serialized lease: append the one real
  `/settings/governance` nav row)
- `services/dashboard/src/app/screens.ts` (serialized lease: append the one
  governance screen mount)
- `services/orchestrator/src/engine/integrations/provisioningEngine.ts` —
  **IN-1 exclusive**; inventory only (see Dependencies).

No migration, no event registry, and no `main.ts`. No new orchestrator route:
the dashboard is a strict BFF/UI consumer of the canonical governance GET/PUT.
Does not invent a mutation event for gate proof — the durable `projects.config`
row plus real-DB CAS proof is the node gate. Does not touch mq-1, rv-4, or #856.

## Consumes

- `checkFullProjectConfigPatch(rawConfig, currentConfig)` — the canonical guard
  the member PATCH route already calls.
- `ProjectStore.updateConfigIfCurrent` — sole expected-snapshot CAS for
  unleased whole-config writers.

## Produces

- Member `PATCH` that changes `auditPosture` → HTTP 400
  `reserved_project_config_patch` with `fields: ["auditPosture"]`; the persisted
  config is unchanged.
- Member `PATCH` carrying `auditPosture` identical to the current value → HTTP 200
  (the unchanged nested value round-trips) unless a concurrent sibling write
  produces HTTP 409 `project_config_conflict`.
- Governance / budget / brownfield posture writers on CAS → HTTP 409
  `project_config_conflict` on stale snapshot (fail loud; client reloads).
- `/settings/governance` reads the current project posture from the canonical
  GET and an org-admin save proxies only `auditPosture` to the canonical PUT.
- Save success and validation/authorization/server failures remain visibly
  actionable on the rendered screen; malformed success payloads fail loudly.
- Real-PG proof of successful CAS, stale miss, JSONB key-order normalization,
  and sibling non-clobber of posture.

## Negative controls

- A `PATCH` body that changes ONLY `auditPosture` (e.g. `blockReviewAt: "P3"`)
  → rejected, config byte-for-byte unchanged.
- A `PATCH` body that includes the unchanged default `auditPosture` plus a
  benign field (e.g. `credentials`) → accepted; the guard does not false-flag
  the structurally-equal nested object.
- Member-first then admin, and admin-first then member interleavings both leave
  the winner's fields intact and return 409 to the stale writer.
- Budget PUT holding a stale snapshot while governance lands → 409; posture
  survives; budget not applied.

## Validation

- Focused: `projectCreateDeployGuard.test.ts` (mutation-negative + positive).
- Existing proof: `governanceRoutes.test.ts` (org-admin PUT still changes
  `auditPosture`; non-admin and wrong-org writes are denied; bidirectional
  interleaving).
- Budget CAS conflict: `budgetRoutes.test.ts`.
- Real-PG (when `TANREN_RLS_DB_TEST=1`): `projectConfigCas.integration.test.ts`.
- Dashboard proof: `governance.render.test.ts` (current read, scoped admin save,
  invalid form, non-admin/server failure visibility, malformed-response failure).
- `just affected-typecheck` / `affected-test` for this pass. Full
  `fast-check`/CI deferred until branch is coherent after IN-1 cutover.

## Serialization

The orchestrator granted GV-1 the serialized dashboard `routes.ts` / `screens.ts`
lease for this repair. Integration provisioning remains IN-1-leased. No other
shared file is touched beyond the unleased config writers listed under exclusive
ownership.

## Completeness

**Not complete** until post-IN-1 removes the residual unconditional
`ProjectStore.updateConfig` call site in `provisioningEngine.ts` and deletes the
LWW method so `updateConfigIfCurrent` is the single authority.
