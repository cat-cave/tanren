<!-- cspell:ignore apiVersion respec dtcg -->

# cap-schema-versions — collapse schema-format version fields to one current value

**Phase**: capstone (legacy collapse)
**Node ID**: `cap-schema-versions`
**Deps**: cap-migrations (schema truth frozen first) · ALL 142 nodes merged
**Node credit**: **0** until independent audit, full green gates, and merge

## Purpose and boundary

Erase every **schema-format** version field that, on a single baseline, can only ever
hold one value — and delete the read-side branching that pretends to dispatch on it.
Survey of `main` finds **58** `schema_version`/`schemaVersion`/`SCHEMA_VERSION` hits,
**17** single-constant `*_SCHEMA_VERSION` literals, and **65** `version: 1` /
`z.literal(1)` contract discriminants. A version field only earns its keep if two
values can genuinely coexist; with one baseline and zero users, none can. Each such
field is a latent false-green: a `z.literal(1)` that "validates" but gates nothing, a
`schema_version` column read into a branch whose second arm is dead.

**The critical boundary — what must NOT be collapsed.** Two kinds of "version" live in
this codebase and only ONE is a collapse target:

- **Schema-FORMAT version** (collapse): "which shape is this blob" —
  `WEB_CATALOG_SCHEMA_VERSION = 1`, `DESIGN_MANIFEST_SCHEMA_VERSION = 1`,
  `RESPEC_PACKET_SCHEMA_VERSION`, the `manifest_schema_version` column, the
  `z.literal(1)` discriminants on `RespecPacketV1`/`SymptomContractV1`/fragments/policy
  documents, `apiVersion: "tanren.dev/governance/v2"`. Single-valued forever → collapse
  to a single interned constant or drop the field where it gates nothing.
- **Immutable-revision lineage** (KEEP — load-bearing): the monotonic per-entity
  `version`/`revision_number` that the **never-discard doctrine** mints on each change —
  `design_contracts.version` (`COALESCE(MAX(version))+1`), `policy_revisions`
  `revision_number` + `schema_version`, behavior/persona revisions. These are NOT a
  format tag; they are content lineage. Collapsing them would delete history and break
  never-discard. **This card must not touch them** — that is its fail-closed invariant.

## The exact surface it collapses

- `engine/design/system/webCatalog.ts` `WEB_CATALOG_SCHEMA_VERSION = 1` +
  `webWriterContext.ts` `z.literal(WEB_CATALOG_SCHEMA_VERSION)` read.
- `engine/design/system/designArtifactSchemas.ts` `DESIGN_MANIFEST_SCHEMA_VERSION = 1`,
  `manifestVersion: z.literal(...)`, `manifestSchemaVersion: z.number().min(1)`.
- `engine/design/system/designSystemStore.ts` `manifestSchemaVersion` column +
  round-trip (`design_system_releases.manifest_schema_version`, CHECK `>= 1` in
  `db/src/schemaDesignSystems.ts:195`) — collapse to a single interned value or drop.
- `engine/contracts/respecPacket.ts` `RESPEC_PACKET_SCHEMA_VERSION` + `schemaVersion`
  literal; `events/schemas/symptomContract.ts`, `governance/policyAst.ts`,
  `reviewRules.ts`, `governance/fragments/model.ts` `schemaVersion: z.literal(1)`.
- The **17** single-constant `_SCHEMA_VERSION` literals + **65** `version: 1` /
  `z.literal(1)` sites — audit each: KEEP as a harmless closed discriminant only where
  it participates in a live discriminated union that another contract reads; DELETE the
  field + any `if (version === X)` branch elsewhere.

## Fail-closed invariant

A collapse is legal ONLY where the field has exactly one possible value AND no live
branch selects on a second value. Where a version read guarded a fallback ("unknown
version → coerce/default"), that fallback dies and the parse **fails loud** on an
unexpected shape (typed error), never silent-coerces. The immutable-revision lineage
columns above are explicitly out of scope — a diff that touches `design_contracts.version`,
`revision_number`, or the never-discard MAX+1 mint is a rejected audit.

## Acceptance test

- No `if`/`switch` in production reads a schema-format version to pick between arms
  (grep: version reads feed validation only, not dispatch).
- Every collapsed literal is a single interned `const`; no removed field leaves a
  dangling reader.
- `just ci` + `just smoke` green; design-system + governance + respec + symptom
  contract tests green (they exercise the surviving single-value path).
- Negative control: feeding a wrong version literal FAILS the parse with a typed error
  (no silent acceptance/coerce).

## Size

Small–medium, ~200–400 lines net (mostly deletions across ~12 files). Splittable by
subsystem (design-system / governance / respec+symptom) if it exceeds ~1000 lines.

## CRITICAL sequencing

Runs in the capstone, **after cap-migrations** (schema truth frozen) and after all 142
nodes. Touches many contract files that consumer nodes author against, so it serializes
against them — it can only run once they are merged. DANGER: the KEEP/COLLAPSE line is
subtle; mistaking a never-discard revision counter for a format tag deletes lineage.
Every deletion must cite "single baseline → one value, no live second arm" and be proven
by green CI + the revision-lineage tests still passing.
