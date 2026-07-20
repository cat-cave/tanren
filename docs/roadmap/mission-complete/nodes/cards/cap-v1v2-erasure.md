<!-- cspell:ignore respec dtcg normaliz -->

# cap-v1v2-erasure — delete the DesignContract V1 dual-read + demote name-only V-suffixes

**Phase**: capstone (legacy collapse)
**Node ID**: `cap-v1v2-erasure`
**Deps**: cap-migrations, cap-schema-versions · ALL 142 nodes merged
**Node credit**: **0** until independent audit, full green gates, and merge

## Purpose and boundary

Erase the last genuine **v1↔v2 duality with a live old path**, and demote the many
V-suffixed types that are just names (a `V2`/`V1` with no sibling) so the suffix stops
implying a compat story that does not exist. The survey census (services + db, non-test)
found the V-suffixed type population, but only ONE pair has a **live migrator that runs
on every read**:

**The one genuine live dual — `DesignContractV1` → `DesignContractV2`.**
`design_contracts` **persists the parsed `DesignContractV1`** (repo doc:
`engine/repositories/designContracts.ts:97,105` — `contract: DesignContractV1`, column
`contract`), and the composer upgrades it on **every** head read:
`composeProjectWebDesignSystem.ts:119` calls `migrateDesignContractV1ToV2(head.contract)`
(defined `designContractV2.ts:198`, a LOSSLESS V1→V2 upgrade filling V2-only fields
with empty-but-valid defaults). So the stored schema is V1 and V2 is a read-time compat
layer. With zero users there are **zero V1 rows to preserve** — the migrator exists only
to bridge a format that nothing needs to keep.

**The collapse:** persist `DesignContractV2` natively. The design agent / design-oracle
authors and stores V2 directly; `design_contracts.contract` holds V2; the head read
returns V2 with no upgrade step. **Delete** `DesignContractV1` (the type + its Zod
schema + `normalizeDesignContract`/`parseDesignContract` V1 entry points),
**`migrateDesignContractV1ToV2`**, and the `contract: DesignContractV1` typing on the
repo. `withDerivedDesiredSurfaces` (the SEPARATE, opt-in dimension→surface projection)
stays — it is real composition logic, not a version bridge. A row that fails the V2
parse **fails loud** (the existing `DesignContractCorruptError` class) — never a silent
re-parse-through-V1 coerce.

**Name-only V-suffixes (demote, lower priority, do NOT invent a migrator):** the survey
confirms these have **no V1 sibling on disk** — `MergeAuthorityV2` (V1=0 files, V2=10;
README: "V1 deleted"), `GateProofBundleV2` (V1=0, V2=3), and the single-version V1
family (`CiConfigV1`, `ProjectConfigV1`, `OrgConfigV1`, `RespecPacketV1`,
`SymptomContractV1`, `ExecutableBehaviorPlanV1`, `QueuePolicyV1`,
`IntegrationRequirementV1`, `AffectedSelection*V1`, `DesignFragment*V1`, `AcceptanceSpecV1`,
etc.). These carry NO live old path — dropping the suffix is a **pure rename** (or a
deliberate keep if the suffix is a wire/schema discriminant coordinated with
cap-schema-versions). This card only _renames_ them for honesty; it deletes no behavior.
Renames are mechanical and high-blast-radius, so they may be split into their own PR or
deferred — the load-bearing work of this card is the DesignContract V1 deletion.

## The exact surface it collapses

- **Delete:** `DesignContractV1` type + schema (`engine/design/designContract.ts`),
  `migrateDesignContractV1ToV2` (`designContractV2.ts:198`), the V1 typing at
  `repositories/designContracts.ts:97,105,151` and its `contract: DesignContractV1`
  reads, the `migrateDesignContractV1ToV2` import + call at
  `composeProjectWebDesignSystem.ts:30,119`.
- **Rewrite:** `design_contracts.contract` now stores/reads V2; the writer + design
  oracle produce V2 directly; head read returns V2 with no upgrade.
- **Rename (optional split):** the name-only V-suffixed types above, per the census.

## Fail-closed invariant

Anything that previously reached the V1→V2 upgrade must now be **authored as V2 at
source**. A persisted contract that is not valid V2 raises the typed corrupt-contract
error and halts the design DAG — it does NOT silently degrade through a V1 re-parse.
The LOSSLESS-migration comment ("cannot invent surfaces") is preserved as behavior: the
native V2 author must supply the same real, persisted content the migrator carried
forward (`accessibilityPosture`, `visualVerification` default-OFF, empty-but-valid
`desiredSurfaces`/`targetProfiles`) — no field silently defaults to a stronger posture.

## Acceptance test

- `grep -rn 'DesignContractV1\|migrateDesignContractV1ToV2' services/*/src` → **zero**
  production hits (doc-comments only, or gone).
- A fresh design run persists a V2 contract and composes from it with no upgrade call.
- Design-system + composer + F2D tests green against native-V2 persistence.
- Negative control: a hand-written V1-shaped `design_contracts` row fails the V2 parse
  loudly (typed error), never composes.
- `just ci` + `just smoke` green.

## Size

Medium, ~300–500 lines (DesignContract V1 deletion + repo/composer rewrite + the
design-oracle/writer produce-V2 change). The name-only renames, if included, add churn
but no logic — split them out if the combined diff exceeds ~1000 lines.

## CRITICAL sequencing

Runs in the capstone after cap-migrations + cap-schema-versions, after all 142 nodes.
It rewrites the `design_contracts` persistence contract that design-bucket nodes
(`ds-0..8`, F2D) build against — so it can only land once those are merged, and it
serializes against any design-contract-touching node. DANGER: this deletes the only
bridge between the persisted format and the composed format; if the writer is not fully
switched to author V2 first, the design DAG halts on every run. Prove the produce-V2
path end-to-end (a real compose) before deleting the migrator — green CI on the compose
test is the gate.
