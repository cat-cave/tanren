<!-- cspell:ignore requirementCompiler requirementCompilerPrompt -->

# in-5 — requirement compiler (G/W/T + DesignContract → IntegrationRequirementV1 set)

**Phase**: MVP (integrations)
**Node ID**: `in-5`
**Base**: `origin/main` @ `af537d2e` (#1154 capstone inventory)
**Branch**: `mission/in5`
**Predecessors**: in-2 (IntegrationRequirementV1 contract), in-1 (integration lifecycle data model + RLS), SP·1 (immutable behavior revisions), ds·0 (DesignContract)
**State**: ✅ implemented — LLM-intent compile, fail-loud on malformed, no lexical fallback

## Purpose

The **requirement compiler** is the LLM-intent derivation that reads a spec's
Given/When/Then acceptance criteria + the project's HEAD `DesignContract` and
produces a typed `IntegrationRequirementV1` set (in-2's contract) the integration
provisioner (in-8..12) consumes. This is the **rejected-design guard**: the prior
"deferred — needs an LLM-intent design, not lexical matching" note is resolved
here by using an LLM actor (the allocating Forge adapter) that reasons over the
G/W/T + design intent, then **re-validates every candidate** via the full
`parseIntegrationRequirement` path (Zod + semantic plane/provider/effect rules).
A malformed candidate is a typed `MalformedRequirementCompilerResultError` —
**never a silent skip, never a lexical fallback, never a default**.

## Dependencies

- **in-2** (hard): `IntegrationRequirementV1Schema`, `parseIntegrationRequirement`,
  `integrationRequirementDigest`, `integrationContractCatalog`, the golden vectors.
- **in-1** (hard): the `integration_requirements` table (migration 0043, FORCE RLS)
  is the persist target — `source_kind='design_contract'`, the contract row id is
  `source_revision_id`, the canonical digest is `source_digest`.
- **ds·0** (hard): `DesignContractStore.getLatestState` — the compile REQUIRES the
  project's HEAD `DesignContract` (a missing contract is a 409, never a silent
  compile from G/W/T alone).
- **SP·1** (transitive via the spec): `SpecStore.get` reads the acceptance criteria.

## Exclusive ownership

| Path                                                                                         | Role                                                                                                                                                              |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/roadmap/mission-complete/nodes/cards/in-5.md`                                          | this card                                                                                                                                                         |
| `services/orchestrator/src/engine/answerers/schemas/requirementCompiler.ts`                  | the `RequirementCompilerAnswer` Zod schema + schema id                                                                                                            |
| `services/orchestrator/src/engine/workflow/requirementCompiler/requirementCompiler.ts`       | the pure actor (`invokeRequirementCompiler`), `validateCompiledRequirements`, `MalformedRequirementCompilerResultError`, `createRequirementCompilerActor` wrapper |
| `services/orchestrator/src/engine/workflow/requirementCompiler/requirementCompilerPrompt.ts` | the LLM prompt builder (`buildRequirementCompilerPrompt`)                                                                                                         |
| `services/orchestrator/src/engine/repositories/integrationRequirements.ts`                   | the persistence seam (`IntegrationRequirementStore.compile` / `listActive`)                                                                                       |
| `services/orchestrator/src/routes/requirementCompiler/index.ts`                              | the HTTP route factory (`createRequirementCompilerRoutes`)                                                                                                        |
| `services/orchestrator/tests/requirementCompilerStage.test.ts`                               | the actor unit tests (negative controls)                                                                                                                          |
| `services/orchestrator/tests/requirementCompilerRoute.test.ts`                               | the route wiring tests                                                                                                                                            |

## Shared-resource leases (minimal wire only — no ownership expansion)

| Path                                                          | Role                                                                                                         |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `services/orchestrator/src/mountFeatureRoutes.ts`             | one `app.route("/orgs", createRequirementCompilerRoutes({...}))` mount (the allocating Forge adapter wiring) |
| `services/orchestrator/src/engine/answerers/schemas/index.ts` | re-export of `RequirementCompilerAnswer` (barrel surface)                                                    |

## Forbidden paths

- Any new migration slot (the `integration_requirements` table already exists at 0043 with FORCE RLS + `source_kind IN ('behavior_revision','design_contract')` — in-5 does NOT own a migration).
- Editing the `IntegrationRequirementV1Schema` or `parseIntegrationRequirement` (in-2's frozen contract — in-5 CONSUMES it, never redefines it).
- Adding a lexical/keyword-matching fallback (the explicitly rejected design — the compile is LLM-intent ONLY).
- Embedding the `IntegrationRequirementV1Schema` directly in the answerer schema (proof≠effect: the schema's `.optional()` fields render as nullable under OpenAI strict mode but would NOT re-parse through the contract's Zod schema; the unknown-items design breaks that cycle).
- Editing `docs/roadmap/mission-complete/LEDGER.md` (reconciled centrally).

## Consumes

- `IntegrationRequirementV1Schema`, `parseIntegrationRequirement`, `integrationRequirementDigest`, `integrationContractCatalog`, `goldenProductMessagingRequirement` — the integration-requirement contract (in-2).
- `DesignContractStore.getLatestState` — the typed-state HEAD-contract read (ds·0; `found` | `absent` | `corrupt`).
- `SpecStore.get` — the spec's `acceptance_criteria` (the G/W/T source).
- `forgeAllocatingAnswererAdapter` — the allocating Forge adapter (the SAME infra every Forge surface uses — no deterministic fallback).
- `renderAnswererJsonSchema` — the inline JSON-Schema renderer (the specQuality path — NOT in `answererSchemaCatalog`, no `generated/*.json` mirror).
- `runWithOrgScope` — the org-scoped transaction primitive (the compile runs org-scoped so the spec/contract/requirement reads + writes all carry the request's RLS GUC).
- `PgEventStore.append` — the sole event writer (Brief invariant; emits `integration.requirement.derived`).

## Produces

### HTTP

| Method | Path                                                                              | Status codes                                                                                                   | Purpose                                                                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/orgs/:orgId/projects/:projectId/specs/:specId/compile-integration-requirements` | 200 (compiled), 403 (off-scope org), 404 (spec not found), 409 (no DesignContract), 502 (malformed LLM result) | the CALLABLE PRODUCER — loads the spec + HEAD contract, invokes the requirement-compiler actor, validates + persists the compiled `IntegrationRequirementV1` set org-scoped, emits `integration.requirement.derived` per requirement. |

### Named event

- `integration.requirement.derived` (Wave-1 vocabulary, in-3 freeze) — emitted per persisted requirement, carrying `requirementId` / `capability` / `plane` / `direction` / `criticality` / `sourceKind:"design_contract"` / `sourceRevisionId` (contract row id) / `desiredStateHash` (the canonical digest). **in-5 is the first production emitter** of this event (the vocabulary was frozen but had no producer before this node).

### Persisted state

- Rows in `integration_requirements` (table 0043) with `source_kind='design_contract'`, `source_revision_id=<contract row id>`, `source_digest=<canonical requirement digest>`, `desired_state=<IntegrationRequirementV1 jsonb>`, `policy_version='integration-catalog.v3'`, `status='active'`. The partial unique index `integration_requirements_active_source_unique` makes a re-compile of the SAME contract idempotent per-requirement (`ON CONFLICT DO NOTHING`).

## The production call-graph wiring (REAL producer → consumer path)

```
operator/dashboard/curl
  └─ POST /orgs/:orgId/projects/:projectId/specs/:specId/compile-integration-requirements
       └─ createRequirementCompilerRoutes (routes/requirementCompiler/index.ts)
            └─ runWithOrgScope(pool, orgId, client => {         ← org-scoped txn
                 ├─ SpecStore.get(client, specId, ...)           ← G/W/T source (RLS)
                 ├─ DesignContractStore.getLatestState(client, ...) ← design intent (RLS)
                 ├─ forgeAllocatingAnswererAdapter.runAnswerer({ ← the REAL allocating Forge adapter
                 │    prompt: buildRequirementCompilerPrompt(spec + contract),
                 │    outputSchema: { renderAnswererJsonSchema(RequirementCompilerAnswer), parse }
                 │  })
                 │  └─ validateCompiledRequirements(answer)     ← re-validates EVERY candidate
                 │       └─ parseIntegrationRequirement(candidate) ← Zod + semantic rules
                 │            └─ fail → MalformedRequirementCompilerResultError → route 502
                 ├─ IntegrationRequirementStore.compile(client, ...) ← INSERT (RLS, ON CONFLICT DO NOTHING)
                 └─ eventStore.append("integration.requirement.derived") ← per requirement (sole PgEventStore)
```

The REAL producer is the HTTP request (an operator / dashboard / curl call). The
`mountFeatureRoutes.ts` wiring builds the allocating Forge adapter from the SAME
`forgeInfra` every Forge surface uses (the shared allocator / SSH / identity ref),
so production wires a REAL provider answerer (Codex/Claude) — there is no
deterministic / template fallback (§8a). The actor is pure; the adapter is
CALLER-SUPPLIED so tests inject a fake that passes through `outputSchema.parse`
(exercising the real parse path), while the route test verifies the REAL store +
event wiring through a fake pool.

## Trap-class self-checks

1. **Dead production trigger** — the route IS the real producer; there is no phantom event listener. The HTTP request is the wake. The automatic trigger (wire into the deriving/active lifecycle) is the follow-up that builds on this callable surface.
2. **Fake-masks-prod** — the route test exercises the REAL stores (SpecStore, DesignContractStore, IntegrationRequirementStore) through a fake pool, and verifies the REAL event emit. The actor test's fake adapter PASSES THROUGH `outputSchema.parse` (the prod parse path). The `mountFeatureRoutes.ts` wiring builds the REAL allocating adapter.
3. **Unfenced claim/lease** — no shared-row claims; the INSERT uses `ON CONFLICT DO NOTHING` against the partial unique index (idempotent per-requirement).
4. **Vacuous-truth / empty-set** — an empty `requirements` array is valid ONLY with a non-empty `rationale` (`.min(1)` on the Zod schema); the rationale MUST explain the empty set.
5. **Coercion / blank-slip** — a non-object candidate is rejected loudly (`MalformedRequirementCompilerResultError`); missing/blank fields fail `parseIntegrationRequirement`; the `rationale` Zod parse rejects empty strings before the actor runs.
6. **Wall-clock / retry-cap** — no `*_MS` timeouts, no retry caps, no `Date.now()` deadlines anywhere.
7. **Proof ≠ effect** — the validated `IntegrationRequirementV1` returned by the actor is the EXACT object persisted to `desired_state`; the `source_digest` column carries the canonical `integrationRequirementDigest(req)`; the event payload's `desiredStateHash` matches the persisted `source_digest`.
8. **Deny-list vs allow-list** — `parseIntegrationRequirement` is an ALLOW-LIST (strict Zod + semantic rules); an intermediate/unknown state fails.
9. **Org-scoped RLS** — the compile runs inside `runWithOrgScope`; every store read/write carries the request's org GUC; an off-scope actor gets 403 before any query.
10. **Unchecked cast** — `decodeRow` re-parses `desired_state` via `parseIntegrationRequirement` (no `as IntegrationRequirementV1`); `source_kind` is validated against the enum.
11. **Orphan writes** — 404 / 409 / 502 short-circuit BEFORE any persist; validation runs BEFORE the INSERT.

## Negative controls (the malformed-result fail-loud proofs)

| Bad input                                                     | Blocks at                                                                                            | Typed failure                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| LLM returns a candidate missing `capability`                  | `parseIntegrationRequirement` (Zod)                                                                  | `MalformedRequirementCompilerResultError` → route 502 |
| LLM returns `control.notify` capability on `product` plane    | `parseIntegrationRequirement` (semantic `plane_capability_mismatch`)                                 | ditto                                                 |
| LLM embeds a secret-shaped string (`xoxb-…`, `sk_live_…`)     | `parseIntegrationRequirement` (`scanSecrets` / `secret_value_forbidden`)                             | ditto                                                 |
| LLM returns the golden cross-plane-forbidden vector           | `parseIntegrationRequirement` (`binding_plane_mismatch` / `control_credential_as_product_messaging`) | ditto                                                 |
| LLM returns a non-object candidate (`"string"`, `42`, `null`) | `validateCompiledRequirements` (coercion guard)                                                      | ditto                                                 |
| LLM returns empty `rationale`                                 | `RequirementCompilerAnswer.parse` (Zod `.min(1)`)                                                    | Zod parse throws BEFORE the actor                     |
| Actor returns valid requirements but contract row is corrupt  | `DesignContractStore.getLatestState` (`corrupt` arm)                                                 | `DesignContractCorruptError` (re-thrown)              |

## Validation

- `corepack pnpm run typecheck` — green.
- `corepack pnpm exec vitest run services/orchestrator/tests/requirementCompilerStage.test.ts services/orchestrator/tests/requirementCompilerRoute.test.ts` — 18 tests, all green.
- `just fast-check` (the full non-build gate) — see the handoff report.
- RLS: the `integration_requirements` table is ENABLED + FORCE RLS (migration 0043); the compile runs inside `runWithOrgScope`. RLS-gated integration tests are the follow-up (the unit tests are DB-free; the fake pool does not enforce RLS).

## Line-cap plan

All owned files are under 500 lines:

- `requirementCompiler.ts` (actor) — ~190 lines.
- `requirementCompilerPrompt.ts` (prompt) — ~170 lines.
- `integrationRequirements.ts` (store) — ~200 lines.
- `routes/requirementCompiler/index.ts` (route) — ~230 lines.
- `requirementCompiler.ts` (schema) — ~70 lines.
- Tests — ~300 + ~440 lines.
- This card — ~200 lines.
