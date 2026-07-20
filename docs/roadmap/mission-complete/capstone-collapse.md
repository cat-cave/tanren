<!-- cspell:ignore respec jsonb backcompat -->

# Capstone: legacy & backwards-compat path collapse

**The final work item of the mission-complete build — runs AFTER all 142 consumer
nodes merge, immediately BEFORE the apex-v97 acceptance trial.** It is the most
destructive pass in the whole program, and it is only safe *because* it runs last, on a
fully-built engine, against the real-Postgres smoke + RLS suites as ground truth.

## Why this is worth doing (and why now)

Tanren has **zero users** and a **single live baseline**. Under that condition every
backwards-compat construct is pure downside: a version fork, a compat shim, a silent
fallback, a `?? {}` on a required field — each keeps the OLD path alive and turns a real
bug into a green build. CLAUDE.md's doctrine is explicit ("Clean-replace, never
cosplay… DELETE superseded code/tables outright — a green gate must mean the NEW path
runs end-to-end, not that a shim kept the old one alive"). The 142-node build necessarily
accreted transitional scaffolding while nodes landed in parallel. This capstone removes
it — collapsing to "only the real, latest, and correct implementation" — so the apex-v97
acceptance trial runs against an engine with no latent false-greens.

It runs **now** (post-142, pre-apex) because: (a) the schema truth is only final once the
last migration slot is claimed; (b) the V-type deletions touch contracts many nodes
build against, so they must wait until those nodes exist; (c) the point of the collapse
is to harden the engine that apex will test — doing it earlier would just re-accrete.

## The survey (grounded on `main`, non-test)

| Collapse target | Quantified surface |
| --- | --- |
| **Migrations** | **94** `db/migrations/*.sql` (`0000_collapsed_baseline` → `0095`), **94**-entry journal, **94** snapshots. `0000` is itself the prior v21-collapse residue; 94 re-accreted. |
| **Schema-format versions** | **58** `schema_version`/`schemaVersion`/`SCHEMA_VERSION` hits; **17** single-constant `_SCHEMA_VERSION` literals; **65** `version: 1`/`z.literal(1)` discriminants — all single-valued on one baseline. |
| **V1/V2 with a LIVE old path** | **1** genuine: `DesignContractV1` persisted in `design_contracts`, upgraded on every read by `migrateDesignContractV1ToV2` (`composeProjectWebDesignSystem.ts:119`). The rest (`MergeAuthorityV2`, `GateProofBundleV2`, ~30 single-version `*V1`) are **name-only** — no sibling, no migrator → rename, not delete. |
| **Silent fallbacks** | **56** jsonb literal defaults across **26** files (18 `db/src` + 8 services; `schemaCore.ts` is the named latent-500 source); a tenant-critical subset of **2195** `??` sites; **181** legacy/deprecated/fallback markers (most are LLM prompt copy — excluded); **15** TODO/FIXME. `catch`-and-swallow: **0**. |

**Headline:** 94 migrations → 1; exactly **1** V1/V2 duality carries a live old path to
delete; ~**56** jsonb-default silent-fallback sites (plus a triaged `??` subset) to make
fail-loud.

## The four nodes (ordered — serialized, single-owner)

1. **`cap-migrations`** — squash 94 migration files → one `0001_baseline.sql` + one
   snapshot + a reset journal. Gate = zero-diff `pg_dump` vs the 94-chain tip + full RLS
   smoke. **Freezes the schema truth first.**
2. **`cap-schema-versions`** — collapse schema-FORMAT version fields/constants to a
   single value; delete version-branching reads. **Explicitly preserves** immutable
   never-discard revision lineage (`design_contracts.version`, `revision_number`).
3. **`cap-v1v2-erasure`** — delete `DesignContractV1` + `migrateDesignContractV1ToV2`,
   persist V2 natively; demote name-only V-suffixes (rename, no logic change).
4. **`cap-fallback-eradication`** — the 56 jsonb defaults + tenant-critical `??`/`?.`
   subset + code-path legacy shims → typed fail-loud; each removal paired with a test
   asserting the new loud failure. **Runs last; widest blast radius; splits into ~4 PRs.**

## Risk posture (the never-cosplay discipline, applied to deletion)

- **Serialized, last, single-owner.** These nodes rewrite migrations and delete types
  many nodes touch — they are hard barriers (orchestration §4) and cannot run concurrently
  with each other or with any consumer node. They land only after the 142 are merged.
- **Every deletion needs a three-word justification: "no user, no caller, superseded"** —
  and it must be *proven*, not asserted, by green CI + the real-Postgres RLS smoke. The
  suites are the ground-truth safety net: anything that only "worked" via a fallback now
  fails loud, and a test must assert that failure.
- **The one guarantee we must not weaken: tenant isolation.** Every collapse (dropped RLS
  policy in the baseline, dropped tenant `??`, collapsed scope check) is validated by
  `*.rls.integration.test` — a cross-org read returning rows instead of zero is the
  tripwire.
- **Keep the honest keeps.** Not everything version-shaped is legacy: never-discard
  revision counters, genuinely-optional domain defaults, and closed discriminants in live
  unions STAY, each documented as intentional. The danger is over-collapsing — deleting
  lineage or a real optional default. Each card draws that KEEP/COLLAPSE line explicitly.

## Definition of done

Same four-part bar as every node (orchestration §3): merged with green hosted CI +
up-to-date-with-`main`; provable; callable; visible — plus the capstone-specific proof
that the collapse **weakened nothing**: zero-diff schema, all RLS smoke green, and a
fail-loud test for every removed fallback. Only then does the engine enter the apex-v97
acceptance trial.
