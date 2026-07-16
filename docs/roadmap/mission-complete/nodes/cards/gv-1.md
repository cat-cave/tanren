# gv-1 — auditPosture write-guard safety repair

**Phase**: governance Phase 0 (safety repairs) · `sm` (small mechanical)
**Base**: `origin/main` `9f20c3ea9a4d972a2564374abd16c63ed5f6fe87`
(`#943`; exact-main restack). The pre-restack head is preserved locally as
`archive/gv-1-pre-9f20-eef14077`.
**Branch**: `node/gv-1-audit-posture-write-guard`
**Worktree**: `.codex/worktrees/gv-1-audit-posture-guard`

**Purpose**: close the authorization bypass where a generic member `PATCH
/:orgId/projects/:projectId` can mutate the governance-owned `auditPosture`
setting because it is omitted from the canonical reserved-field guard. Add
`auditPosture` to the reserved-field list with structural/deep equality (it is a
nested object), so a genuine change is rejected while an unchanged value
round-trips untouched. The sole supported _authorization_ path for mutating
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

**Serialized event/migration dependency — reserved, NOT yet materialized**

- Root released RV-4's event/nav lease and assigned GV-1 the event registry,
  severity, sensitivity, generated-seed, and dashboard mount slice.
- The new typed `governance.audit_posture.updated` fact requires a catalog row
  because `events.event_type` has a foreign key to the global `event_types`
  table. `db/src/eventTypesSeed.ts` is a generated mirror, not a runtime seed.
- Migration ordering is fixed as `0041` IN-1 → `0042` RV-4 → `0043` GV-1.
  GV-1 owns the future `0043` catalog insert but must not create its SQL,
  snapshot, or journal entry until both predecessors land.

## Exclusive ownership

- `services/orchestrator/src/engine/workflow/projectConfigWriteGuards.ts`
- `services/orchestrator/src/engine/repositories/projects.ts` (CAS authority +
  residual LWW doc until post-IN-1 delete)
- `services/orchestrator/src/engine/events/schemas/governance.ts`
- `services/orchestrator/src/engine/events/schemas/registryFragments.ts`
  (dependency-cap aggregation for the event registry)
- `services/orchestrator/src/engine/events/registry.ts` (serialized event lease)
- `services/orchestrator/src/engine/events/sensitivityRules.governance.ts`
- `services/orchestrator/src/engine/events/sensitivityRules.ts` (serialized
  event lease)
- `services/orchestrator/src/engine/notifications/eventDefaultSeverity.ts`
- `db/src/eventTypesSeed.ts` (generated; serialized event lease)
- `contracts/json/events/governance_audit_posture_updated.json` (generated
  neutral contract mirror)
- `db/migrations/0043_*` + matching Drizzle journal/snapshot metadata (future
  serialized migration lease; do not create before `0041`/`0042` land)
- `services/orchestrator/src/mountRootApiRoutes.ts`
- `services/orchestrator/src/routes/projects/fullConfigPatch.ts`
- `services/orchestrator/src/routes/projects/createConfigGuard.ts`
- `services/orchestrator/src/routes/projects/index.ts`
- `services/orchestrator/src/routes/projects/governance.ts`
- `services/orchestrator/src/routes/projects/budget.ts` (CAS convergence)
- `services/orchestrator/src/routes/brownfield/fullTrack.ts` (CAS convergence;
  shared-config writer without a separate lease)
- `services/orchestrator/tests/projectCreateDeployGuard.test.ts`
- `services/orchestrator/tests/governanceRoutes.test.ts` (admin PUT auditPosture
  - bidirectional member/admin interleaving + wrong-org negative)
- `services/orchestrator/tests/governanceAuditPostureEvent.test.ts`
- `services/orchestrator/tests/budgetRoutes.test.ts` (budget ↔ sibling CAS
  conflict)
- `services/orchestrator/tests/projectConfigCas.integration.test.ts` (real-PG
  JSONB CAS proof; gated `TANREN_RLS_DB_TEST=1`)
- `services/orchestrator/tests/governanceAuditPosture.rls.integration.test.ts`
  (future `0043` real-PG route/state/event atomicity + tenant proof)
- `services/orchestrator/tests/projectAuditPostureCreateAuthority.test.ts`
- `services/orchestrator/tests/helpers/routesPool.ts` (CAS SQL surface; documents
  that stringify equality ≠ JSONB)
- `services/orchestrator/tests/helpers/routesPoolEvents.ts` (typed EventStore
  envelope capture for route proofs)
- `services/dashboard/src/api/httpClient.ts`
- `services/dashboard/src/api/governance.ts`
- `services/dashboard/src/api/governanceClient.ts`
- `services/dashboard/src/routes/governance/index.tsx`
- `services/dashboard/src/components/governance/GovernanceBody.tsx`
- `services/dashboard/src/components/governance/styles.ts`
- `services/dashboard/tests/governance.render.test.ts`
- `docs/roadmap/mission-complete/nodes/cards/gv-1.md`

## Shared-resource leases, not owned paths

- `services/dashboard/src/app/routes.ts` and
  `services/dashboard/src/app/screens.ts` are now GV-1's serialized lease; their
  existing governance nav/mount must preserve RV-4's eventual convergence.
- `services/orchestrator/src/engine/integrations/provisioningEngine.ts` —
  **IN-1 exclusive**; inventory only (see Dependencies).

No `main.ts` and no new orchestrator route: the dashboard is a strict BFF/UI
consumer of the canonical governance GET/PUT. The route's successful
audit-posture CAS and the named EventStore fact will share one org-scoped
transaction; rejected, unauthorized, foreign-org, invalid, and stale writes
must append no success fact. The `0043` catalog insert is deferred behind IN-1
and RV-4 rather than competing for their migration slots. Does not touch MQ-1,
RV-4's exclusive behavior-coverage repair, or #856.

## Consumes

- `checkFullProjectConfigPatch(rawConfig, currentConfig)` — the canonical guard
  the member PATCH route already calls.
- `ProjectStore.updateConfigIfCurrent` — sole expected-snapshot CAS for
  whole-config writers without a separate lease.

## Produces

- Member `PATCH` that changes `auditPosture` → HTTP 400
  `reserved_project_config_patch` with `fields: ["auditPosture"]`; the persisted
  config is unchanged.
- Member `PATCH` carrying `auditPosture` identical to the current value → HTTP 200
  (the unchanged nested value round-trips) unless a concurrent sibling write
  produces HTTP 409 `project_config_conflict`.
- Governance / budget / brownfield posture writers on CAS → HTTP 409
  `project_config_conflict` on stale snapshot (fail loud; client reloads).
- A successful, actual `auditPosture` transition appends exactly one typed
  `governance.audit_posture.updated` fact through `PgEventStore`, in the same
  transaction as the CAS. The non-secret payload records the initiating user
  id plus the previous and current postures. A no-op posture PUT emits nothing.
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
- Member-first then admin, and admin-first then member execution orders both leave
  the winner's fields intact and return 409 to the stale writer.
- Budget PUT holding a stale snapshot while governance lands → 409; posture
  survives; budget not applied.
- Reserved member PATCH, invalid governance payload, non-admin/foreign-org PUT,
  and stale governance CAS append no `governance.audit_posture.updated` event.
- If the EventStore append fails, the preceding config CAS rolls back; a state
  transition without its durable fact is impossible.

## Validation

- Focused: `projectCreateDeployGuard.test.ts` (mutation-negative + positive).
- Existing proof: `governanceRoutes.test.ts` (org-admin PUT still changes
  `auditPosture`; non-admin and wrong-org writes are denied; bidirectional
  interleaving).
- Budget CAS conflict: `budgetRoutes.test.ts`.
- Real-PG (when `TANREN_RLS_DB_TEST=1`): `projectConfigCas.integration.test.ts`.
- Dashboard proof: `governance.render.test.ts` (current read, scoped admin save,
  invalid form, non-admin/server failure visibility, malformed-response failure).
- Typed event/route proof: event registry + field-sensitivity coverage and
  `governanceRoutes.test.ts` positive/no-op/negative event assertions.
- Real-PG after `0043`: production HTTP route under `tanren_app` proves one
  transaction commits state + event, an injected event failure rolls both back,
  and foreign-tenant rows remain inaccessible.
- Pre-migration preparation on the exact base: focused event/route tests,
  `just affected-typecheck`, `just affected-test`, `just fast-check`, and
  `just ci` are green (2026-07-15). Re-run the full gates after the IN-1 cutover
  and `0043`; the gated real-Postgres proof and `just smoke` remain deferred.

## Serialization

The orchestrator granted GV-1 the serialized dashboard mount and event
registry/seed/severity/sensitivity leases. The migration train is
`0041` IN-1 → `0042` RV-4 → `0043` GV-1; no GV-1 migration artifact exists
until the first two land. Integration provisioning remains IN-1-leased.

## Completeness

**Not complete** until (1) post-IN-1 removes the residual unconditional
`ProjectStore.updateConfig` call site in `provisioningEngine.ts` and deletes the
LWW method so `updateConfigIfCurrent` is the single authority, and (2) serialized
`0043` installs the event catalog row and the real-Postgres atomic route proof is
green. The pre-migration branch is repair-in-progress and is not countable.
