# gv-1 — auditPosture write-guard safety repair

**Phase**: governance Phase 0 (safety repairs) · `sm` (small mechanical)
**Base**: `origin/main` `e6a6ded0c813b61f1ec6634158b30471f48b14f0`
**Branch**: `node/gv-1-audit-posture-write-guard`
**Worktree**: `.codex/worktrees/gv-1-audit-posture-guard`

**Purpose**: close the authorization bypass where a generic member `PATCH
/:orgId/projects/:projectId` can mutate the governance-owned `auditPosture`
setting because it is omitted from the canonical reserved-field guard. Add
`auditPosture` to the reserved-field list with structural/deep equality (it is a
nested object), so a genuine change is rejected while an unchanged value
round-trips untouched. The sole supported mutation path remains the org-admin
`PUT /:orgId/projects/:projectId/governance` surface.

## Dependencies

**Spine / shared contracts (read-only)**

- `ProjectConfigV1` / `migrateProjectConfig`
  (`engine/config/projectConfig.ts`) — the versioned config the guard parses.
- `AuditPostureConfig` (`engine/config/auditPostureConfig.ts`) — the nested
  `{ blockReviewAt, p2p3Handling, autonomousRemediation }` governed setting.

**Reused proof surfaces (not modified)**

- `routes/projects/governance.ts` — the sole governance PUT (org-admin
  authorized) that legitimately changes `auditPosture`.
- `routes/projects/index.ts` — the member `PATCH` route that calls the guard.

## Exclusive ownership

- `services/orchestrator/src/engine/workflow/projectConfigWriteGuards.ts`
- `services/orchestrator/tests/projectCreateDeployGuard.test.ts`
- `services/orchestrator/tests/governanceRoutes.test.ts` (add the positive
  admin-PUT auditPosture proof and wrong-org negative; the existing harness is
  reused)
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

No migration, no event registry, and no `main.ts`. No new orchestrator route or
store: the dashboard is a strict BFF/UI consumer of the canonical governance
GET/PUT. Does not touch mq-1, rv-4, integration lifecycle, or #856.

## Consumes

- `checkFullProjectConfigPatch(rawConfig, currentConfig)` — the canonical guard
  the member PATCH route already calls (`routes/projects/index.ts:152`).

## Produces

- Member `PATCH` that changes `auditPosture` → HTTP 400
  `reserved_project_config_patch` with `fields: ["auditPosture"]`; the persisted
  config is unchanged.
- Member `PATCH` carrying `auditPosture` identical to the current value → HTTP 200
  (the unchanged nested value round-trips).
- `/settings/governance` reads the current project posture from the canonical
  GET and an org-admin save proxies only `auditPosture` to the canonical PUT.
- Save success and validation/authorization/server failures remain visibly
  actionable on the rendered screen; malformed success payloads fail loudly.

## Negative controls

- A `PATCH` body that changes ONLY `auditPosture` (e.g. `blockReviewAt: "P3"`)
  → rejected, config byte-for-byte unchanged.
- A `PATCH` body that includes the unchanged default `auditPosture` plus a
  benign field (e.g. `credentials`) → accepted; the guard does not false-flag
  the structurally-equal nested object.

## Validation

- Focused: `projectCreateDeployGuard.test.ts` (mutation-negative + positive).
- Existing proof: `governanceRoutes.test.ts` (org-admin PUT still changes
  `auditPosture`; non-admin and wrong-org writes are denied).
- Dashboard proof: `governance.render.test.ts` (current read, scoped admin save,
  invalid form, non-admin/server failure visibility, malformed-response failure).
- `just affected-typecheck` / `affected-test`, format/lint/diff-check, <500
  lines per file.

## Serialization

The orchestrator granted GV-1 the serialized dashboard `routes.ts` / `screens.ts`
lease for this repair. No other shared file is touched; the guard file remains a
single-owner path under this card.
