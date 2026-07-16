# cas-sub-config-revision — sole config-write authority (migration 0041)

**Phase**: shared spine substrate (config generation) · not a consumer node  
**Base**: `origin/main` `1f1eda2ed678f8ea7f12eef4a8362e22dbd39fee`  
**Branch**: `mission/cas-sub-config-revision`  
**Worktree**: `.codex/worktrees/cas-sub-config-revision`  
**Migration slot**: **0041** (`0041_config_revision`) — sole owner of this slot

**Purpose**: install the one application-owned concurrency token and the one store
CAS for `projects.config` and `organizations.config`. Delete last-write-wins
`ProjectStore.updateConfig` and every production `UPDATE … SET config` path. This PR
is a **substrate** for later #856 dashboard restack and for IN-1/train renumber
(`0042+`). **Zero consumer-node credit.**

## Outcome (exact)

1. `projects.config_revision` and `organizations.config_revision` are
   `BIGINT NOT NULL DEFAULT 1` with CHECK `1..Number.MAX_SAFE_INTEGER`
   (application generation — **never** `xmin`; ORM keeps `mode: "number"`).
2. Sole project write API: `getConfigSnapshot` + `compareAndSwapConfig` on
   `ProjectStore`; LWW `updateConfig` is **deleted**.
3. Parallel org write API on the repository layer (same snapshot/CAS vocabulary).
4. Internal merge-intent writers use progress-based `mutateProjectConfig` /
   `mutateOrgConfig` (no fixed attempt cap).
5. External/member HTTP writes are **one-shot** revision CAS → **409** with the
   repository conflict vocabulary + current revision when safely readable.
6. Non-config column updates do not bump `config_revision`.
7. Org RLS / ambient GUC preserved; foreign-org probes = absence, zero effects.
8. Revision exposed on relevant project/org read/write HTTP representations.

## Dependencies / base pin

- Frozen base: `1f1eda2e…` (latest landed migration **0040**).
- Decision authority:
  - `.codex/orchestration-prompts/config-cas-one-authority-grok-report.md`
  - `.codex/orchestration-prompts/config-revision-migration-slot-grok-report.md`
- Consumes existing org-scoped clients / `runWithOrgScope`; does **not** invent a
  second proof store or MergeAuthority change.

## Exclusive ownership (hard lease)

Exact set-equal to the worktree dirty path set (no wildcards; no external
handoff paths). Update this table before adding any new repository path.

| Path                                                                       |
| -------------------------------------------------------------------------- |
| `db/migrations/0041_config_revision.sql`                                   |
| `db/migrations/meta/0041_snapshot.json`                                    |
| `db/migrations/meta/_journal.json`                                         |
| `db/src/schemaCore.ts`                                                     |
| `docs/roadmap/mission-complete/nodes/cards/cas-sub-config-revision.md`     |
| `services/orchestrator/src/engine/config/configRevision.ts`                |
| `services/orchestrator/src/engine/config/orgConfig.ts`                     |
| `services/orchestrator/src/engine/config/orgConfigMutate.ts`               |
| `services/orchestrator/src/engine/config/projectConfig.ts`                 |
| `services/orchestrator/src/engine/config/projectConfigMutate.ts`           |
| `services/orchestrator/src/engine/credentials/orgGithubApp.ts`             |
| `services/orchestrator/src/engine/integrations/provisioningEngine.ts`      |
| `services/orchestrator/src/engine/repositories/organizations.ts`           |
| `services/orchestrator/src/engine/repositories/projects.ts`                |
| `services/orchestrator/src/routes/aiProvider/index.ts`                     |
| `services/orchestrator/src/routes/brownfield/fullTrack.ts`                 |
| `services/orchestrator/src/routes/orgs/index.ts`                           |
| `services/orchestrator/src/routes/projects/budget.ts`                      |
| `services/orchestrator/src/routes/projects/configConflict.ts`              |
| `services/orchestrator/src/routes/projects/governance.ts`                  |
| `services/orchestrator/src/routes/projects/index.ts`                       |
| `services/orchestrator/tests/budgetRoutes.test.ts`                         |
| `services/orchestrator/tests/configRevisionAuthority.grep.test.ts`         |
| `services/orchestrator/tests/configRevisionCas.rls.integration.test.ts`    |
| `services/orchestrator/tests/configRevisionCas.test.ts`                    |
| `services/orchestrator/tests/conformance/conformanceMemoryDb.ts`           |
| `services/orchestrator/tests/conformance/repositories.conformance.test.ts` |
| `services/orchestrator/tests/conformance/repositoriesConformance.ts`       |
| `services/orchestrator/tests/governanceRoutes.test.ts`                     |
| `services/orchestrator/tests/helpers/routesPool.ts`                        |
| `services/orchestrator/tests/helpers/routesPoolConfigCas.ts`               |
| `services/orchestrator/tests/integrationProvisioningEngine.test.ts`        |
| `services/orchestrator/tests/orgConfigGateRoutes.test.ts`                  |
| `services/orchestrator/tests/orgsRoutes.test.ts`                           |
| `services/orchestrator/tests/projectAutonomousConfigPolicies.test.ts`      |
| `services/orchestrator/tests/projectCreateDeployGuard.test.ts`             |

If another path becomes necessary, **update this card first**.

## Exclusions (do not touch)

- Integration-lifecycle migrations / IN-1 tables (`0041_integration_lifecycle` is
  **renumbered away** — this slot is config revision only).
- Event vocabulary / MergeAuthority / gate proofs / SP-3 CAS byte store.
- Dashboard portfolio / #856 consumer UI (substrate only; zero node credit).
  HTTP 409 bodies intentionally carry only safe row identity + current revision;
  richer dashboard identity (e.g. `repoUrl` on conflict) is **#856**, not this
  substrate.
- Global nav / `screens.ts` / `main.ts` composition.
- Queued train migrations (RV-4/GV-1/GV-2/MQ-1/GV-3) and their cards beyond this
  lease — renumber is a **post-merge** restack consequence, not authored here.
- Unrelated queue-recovery `xmin` effect probes in merge tests (grep must not ban them).

## Invariants

- One authority, one token, one SQL CAS per table — no LWW residual, no xmin ETag,
  no JSONB-only dual spine, no `updateConfig` alias/shim/retry-cap overload.
- Failed / no-op / conflict writes never claim success with a false advanced revision.
- Equal-config CAS is concurrency-safe: one revision-predicated UPDATE with
  `config IS DISTINCT FROM` (bump only on real change); on zero rows, authoritative
  re-read decides `not_found` / `conflict` / same-rev `ok` — never an unlocked
  pre-read short-circuit.
- HTTP stale full-document writes are **not** silently auto-retried.
- Internal mutators re-read/recompute after lost races until semantic completion or
  a typed terminal error (missing project/org).
- Tenant identity + row identity + expected revision predicate every CAS UPDATE.
- Files stay ≤ 500 lines unless an existing documented exception applies.

## Proof matrix

| #   | Proof                                                                             |
| --- | --------------------------------------------------------------------------------- |
| 1   | Fresh `0000→0041` migrate + `0040→0041` upgrade                                   |
| 2   | Initial revision `1` for existing + new project/org rows                          |
| 3   | Two concurrent same-revision writers → one winner, one conflict                   |
| 4   | `mutateProjectConfig` interleaving preserves independent field changes            |
| 5   | Same-org success; cross-org denial / zero effects; missing≡foreign non-disclosure |
| 6   | One-shot HTTP stale write → exact 409, no mutation                                |
| 7   | Non-config updates do not increment revision                                      |
| 8   | Architecture grep: no LWW/direct config SQL / production xmin config token        |
| 9   | Route-level cutover (incl. no-op + response identity) for all writers             |
| 10  | No-op cannot stale-succeed around a competing writer; key-order JSONB is no-op    |
| 11  | Shared range validator: min/max/max+1/long-digit reject; unsafe JS numbers reject |
| 12  | HTTP out-of-range revision → 400 before store (zero effect); store rejects too    |
| 13  | Real-PG CHECK rejects increment past MAX_SAFE_INTEGER (fail-closed, no wrap)      |

Gates: focused unit/conformance + `TANREN_RLS_DB_TEST=1` real-PG; then
`just fast-check`, `just ci` from this worktree. Smoke is out of band for this
substrate authoring pass.

## Merge / restack consequences

| After this lands  | Action                                                                      |
| ----------------- | --------------------------------------------------------------------------- |
| #856              | Restack revision UX onto `config_revision` (never xmin); no second store    |
| IN-1              | Migration renumber **0042**; bind writers to sole primitive; drop JSONB CAS |
| RV-4 → GV-3 train | Renumber claims **0043–0047**; restack after predecessors                   |
| This PR           | Substrate only — **0 node credit**                                          |

## Serialization

Owns migration **0041** exclusively until merge. No concurrent author may define
`projects.ts` config write API or invent another `0041_*` migration.
