# gv-1 — auditPosture write-guard safety repair

**Phase**: governance Phase 0 (safety repairs) · `sm` (small mechanical)
**Base**: `origin/main` / `98457ad02c1550aec8f24e6d965df804d160c5aa` (post EV-SUB-W0 + CAS-SUB + #961)
**Branch**: `mission/gv-1-final`
**Worktree**: `.codex/worktrees/gv-1-final`

**Purpose**: close the authorization bypass where a generic member `PATCH
/:orgId/projects/:projectId` can mutate the governance-owned `auditPosture`
setting because it is omitted from the reserved-field guard. Reserve
`auditPosture` with structural/deep equality (nested object), so a genuine
change is rejected while an unchanged value round-trips. The sole supported
mutation path remains the org-admin
`PUT /:orgId/projects/:projectId/governance` surface, which CAS-writes through
`ProjectStore.compareAndSwapConfig` and, on an actual posture transition,
appends `governance.audit_posture.updated` through `PgEventStore` in the **same
org-scoped transaction**.

## Dependencies

**Spine / shared contracts (read-only, already on main)**

- `ProjectConfigV1` / `migrateProjectConfig` — versioned config the guard parses.
- `AuditPostureConfig` — nested governed setting.
- CAS-SUB sole config authority: `getConfigSnapshot` + `compareAndSwapConfig`
  (LWW `updateConfig` deleted; no residual dual authority in this node).
- EV-SUB-W0 catalog row + payload schema + sensitivity + default severity for
  `governance.audit_posture.updated` (consumer emit only — **no** catalog
  migration ownership).

**Production surfaces reused**

- `routes/projects/governance.ts` — sole org-admin governance GET/PUT.
- Member `PATCH` through `checkFullProjectConfigPatch` + revision CAS.
- `PgEventStore` — sole event append seam.

## Exclusive ownership

| Path                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ |
| `docs/roadmap/mission-complete/nodes/cards/gv-1.md`                                                          |
| `services/orchestrator/src/engine/workflow/projectConfigWriteGuards.ts`                                      |
| `services/orchestrator/src/routes/projects/governance.ts`                                                    |
| `services/orchestrator/src/routes/projects/index.ts` (governance PUT actor + create raw-config pass-through) |
| `services/orchestrator/src/mountRootApiRoutes.ts` (root create raw-config pass-through only)                 |
| `services/orchestrator/tests/projectCreateDeployGuard.test.ts`                                               |
| `services/orchestrator/tests/governanceRoutes.test.ts`                                                       |
| `services/orchestrator/tests/helpers/routesPoolEvents.ts` (new)                                              |
| `services/orchestrator/tests/helpers/routesPool.ts` (event INSERT capture wire only)                         |
| `services/dashboard/src/api/governance.ts`                                                                   |
| `services/dashboard/src/api/governanceClient.ts`                                                             |
| `services/dashboard/src/api/httpClient.ts` (`getJsonResponse` only)                                          |
| `services/dashboard/src/routes/governance/index.tsx`                                                         |
| `services/dashboard/src/components/governance/GovernanceBody.tsx`                                            |
| `services/dashboard/src/components/governance/styles.ts`                                                     |
| `services/dashboard/tests/governance.render.test.ts`                                                         |

## Shared-resource leases (minimal wire only)

| Path                                             | Wire                                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `services/dashboard/src/routes/config/index.tsx` | one `mountGovernanceScreen(app, deps)` call so `/settings/governance` is reachable without editing leased `screens.ts` |

## Exclusions (hard — do not edit)

- `db/migrations/**`, Drizzle journal/meta/schema exports (IN-1 exclusive until land)
- `services/dashboard/src/app/screens.ts`, `services/dashboard/src/app/routes.ts`,
  `services/dashboard/src/main.tsx` (shared mount/nav lease; IN-1 / serialization)
- Event registry / seed / sensitivity / severity / generated JSON contracts
  (already EV-SUB-W0; consumer emit only)
- IN-1 / IN-2 / MQ-1 / RV-4 exclusive paths; PR #856 retained successor surfaces
  beyond the one config-mount wire
- New migration or parallel config write authority

## Consumes

- `checkFullProjectConfigPatch` / create-config guard path on member PATCH/create.
- `ProjectStore.compareAndSwapConfig` as sole whole-config CAS.
- Frozen event `governance.audit_posture.updated` payload (actorUserId + previous/current).
- Org-admin gate on governance PUT (`actorIsOrgAdmin`).

## Produces

### Engine / HTTP

- Member PATCH that changes `auditPosture` → `400 reserved_project_config_patch`
  with `fields: ["auditPosture"]`; persisted config unchanged; **no** success event.
- Member PATCH restating structurally-equal current `auditPosture` + benign fields
  → accepted (no false-flag on re-parse).
- Create body supplying `auditPosture` → `400 manual_autonomous_project_config`.
- Org-admin governance PUT with actual posture transition → CAS + exactly one
  `governance.audit_posture.updated` in the same transaction; no-op posture PUT
  emits nothing; failed append rolls back the CAS.
- Stale revision → `409 project_config_conflict`; non-admin → `403`; wrong org →
  `404`; invalid body → `400`; none of these emit the success fact.

### Named event / gate proof

- Production path only: `governance.audit_posture.updated` via `PgEventStore.append`
  with `{ actorUserId, previous, current }` matching the CAS transition.

### UI

- Dashboard BFF `GET|POST /settings/governance` (project picker, current posture
  cards, admin form proxying **only** `auditPosture` + revision to the canonical
  PUT). Mounted via thin config-screen wire (no parallel orchestrator route).
- **Barrier (nav)**: sidenav row in `routes.ts` and `SCREEN_MOUNTS` append in
  `screens.ts` remain leased — surface is reachable at the URL (and from the
  existing onboarding link) but not yet a permanent sidenav row until the lease
  releases. No invented alternate mutation path.

## Negative controls

1. PATCH changing only `auditPosture` rejected; config byte-stable; no event.
2. PATCH with unchanged nested posture + benign field accepted.
3. Non-admin / foreign-org / invalid / stale CAS PUT: no event, no partial write.
4. Event-append failure rolls back posture mutation (transactional).
5. No-op posture PUT: config may no-op-CAS; zero mutation events.

## Validation

- Focused: `projectCreateDeployGuard.test.ts`, `governanceRoutes.test.ts`,
  `governance.render.test.ts`.
- `just affected-typecheck` / `affected-test`; format/lint/architecture on owned files.
- Line counts ≤ 500.

## Salvage note

Inspected `node/gv-1-audit-posture-write-guard` and `archive/gv-1-pre-9f20-eef14077`
for unique behavior only. Restacked onto post-CAS-SUB / EV-SUB-W0 main:
revision CAS (not JSONB `updateConfigIfCurrent`), no event-catalog ownership,
dashboard `revision` in GovernanceView, thin config mount instead of leased
screens/nav.
