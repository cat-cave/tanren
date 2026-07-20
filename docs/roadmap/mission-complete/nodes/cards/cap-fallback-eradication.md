<!-- cspell:ignore jsonb schemaCore nullish -->

# cap-fallback-eradication — silent fallbacks + jsonb defaults → fail loud

**Phase**: capstone (legacy collapse)
**Node ID**: `cap-fallback-eradication`
**Deps**: cap-migrations, cap-schema-versions, cap-v1v2-erasure · ALL 142 nodes merged
**Node credit**: **0** until independent audit, full green gates, and merge

## Purpose and boundary

Convert every **silent degrade** into a **loud failure**. On a zero-user single
baseline, a fallback never "keeps a real user working" — it only lets a bug ship green:
a missing required field silently becomes `{}`, an absent tenant scope silently becomes
unscoped, an unhandled case silently no-ops. CLAUDE.md's residual-hardening item names
`schemaCore.ts` jsonb defaults as a latent-500 source; this card is the systematic
sweep of that whole class.

**Boundary:** this is a *behavior-preserving-for-the-happy-path, fail-loud-for-the-sad-path*
change. It does not add features. Each site is triaged: a fallback that supplies a
genuinely-optional value with a real domain default STAYS (and is documented as
intentional); a fallback that masks a missing REQUIRED input is deleted and replaced
with a typed throw. The full test suite + RLS smoke is the net: anything that only
"worked" via a fallback now fails loud and a test must assert the throw.

## The exact surface it collapses (from the survey)

- **jsonb literal defaults — 56 sites across 26 files** (`'{}'::jsonb` / `'[]'::jsonb`):
  **18 in `db/src`** (`schemaCore.ts`, `schema.ts`, `schemaEvents.ts`,
  `schemaFragments.ts`, `schemaDesignSystems.ts`, `schemaDesignFragments.ts`,
  `schemaIntegrationNodes.ts`, `schemaIntegrationConnections.ts`,
  `schemaIntegrationOperations.ts`, `schemaIssueLoops.ts`, `schemaIssueSourceSync.ts`,
  `schemaSymptomEvidence.ts`, `schemaRegressionBisections.ts`, `schemaProjectDerivations.ts`,
  `schemaInbox.ts`, `schemaClaims.ts`, `schemaBenchmark.ts`, `schemaBehaviorQuarantines.ts`)
  **+ 8 in services** (`config/projectConfig.ts`, `merge/batchMaxSize.ts`,
  `merge/batchChecker.ts`, `forge/audits/scheduler.ts`, `repositories/projectDerivations.ts`,
  `worker/runStateLifecycleSql.runSpec.ts`, `repositories/verificationEnvironments.ts`,
  `routes/runs/progressRoute.ts`). Each column-default `'{}'::jsonb` on a NOT-NULL
  payload lets an INSERT that forgot the field land a structurally-empty row that later
  reads as valid-but-meaningless (the latent 500). Triage: a column whose emptiness is a
  real state keeps the default; a column that must always carry real content drops the
  default so the INSERT fails loud on omission.
- **Nullish-coalescing on critical fields — subset of 2195 `??` sites** (services,
  non-test). The vast majority are legitimate optional-value defaults and STAY. The
  card targets the subset on **tenant/identity/required-dependency** fields — an
  `orgId ?? ...`, a required-config `?? {}`, a `?.` optional chain on a dep the code
  cannot actually run without. Precedent already set: the `resolveCredentials.ts`
  `orgId === ''` silent-BYOK branch was replaced with a typed `UnscopedOrgError`
  (`OrgScope` discriminated mode) — this card applies the SAME pattern to the remaining
  tenant-critical `??`/`?.` sites.
- **Legacy/compat markers — 181 hits** of `legacy|deprecated|backcompat|fallback|compat
  shim` (services + db, non-test). Most are LLM prompt copy (e.g.
  `answererPrompts.ts` 12, `designOraclePrompt.ts` 5) and are NOT code — exclude those.
  The real targets are the code-path markers (`projectSpecRowSchema.ts`,
  `plannerRunJjLocalBootstrap.ts`, `reviewMerge/*`, `ci/schema.ts`,
  `repositories/designContracts.ts` "corrupt / legacy-shaped row") — each a shim to
  audit and either delete or convert to fail-loud.
- **15 TODO/FIXME/HACK** markers (non-test) — resolve or delete; a capstone leaves no
  "fix later" on a shipped path. (`catch`-and-swallow scan returned 0 empty catches —
  good, none to fix.)

## Fail-closed invariant

After this node, no production path silently substitutes a value for a missing
**required** input. A dropped jsonb default means an INSERT missing that column errors
(loud); a dropped tenant `??` means a missing scope raises a typed error, never
degrades to unscoped/all-orgs. The RLS smoke is the isolation net: any change that
weakened a tenant guard makes a cross-org read return rows and fails
`*.rls.integration.test`. Every retained fallback carries a one-line comment justifying
"genuinely optional, real domain default."

## Acceptance test

- Each removed default has a test asserting the now-loud failure (typed throw / INSERT
  error) on the omission it used to mask.
- No tenant/identity field reads through a silent `??`/`?.` degrade (grep audit +
  reviewer sign-off per surviving site).
- `just ci` + `just smoke` green, including all `*.rls.integration.test`.
- Negative control: an INSERT/entry that omits a now-required field is REJECTED, not
  silently stored empty.

## Size

Medium–large; splittable and SHOULD split — natural seams: (a) `db/src` jsonb defaults
(18 files, migration-adjacent), (b) service jsonb defaults (8 files), (c) tenant-critical
`??`/`?.` sweep, (d) legacy-marker + TODO cleanup. Each ≤ ~1000 lines per orchestration
Rule 0.

## CRITICAL sequencing

The **last** capstone node — runs after cap-migrations, cap-schema-versions, and
cap-v1v2-erasure, after all 142 nodes. The `db/src` jsonb-default arm touches the schema
the baseline just dumped, so it must either fold into the cap-migrations baseline or land
as a follow-on migration that alters the defaults — coordinate the ordering explicitly.
DANGER: this is the widest-blast-radius pass — 56 defaults + a `??` subset across the
whole surface. Every deletion must be justified by "single baseline → this masked a real
bug, no user relied on it" and proven by a test that asserts the new loud failure. A
fallback removed without a corresponding fail-loud test is a regression, not a collapse.
