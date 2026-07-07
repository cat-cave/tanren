# Template fragments

The single, fragment-only scaffold composition path for Tanren templates. See
`docs/roadmap/templating-system.md` for the doctrine of record: fragments are the
primitive, the composer is the sole materialization path, and a missing fragment
spawns the per-fragment authoring DAG (F2) — there is no fallback path, no
`scaffoldOrigin: "template_build"` mode, and no agent template-build DAG. Inspired
by [`create-better-t-stack`](https://github.com/AmanVarshney01/create-better-t-stack)
(BTS): pre-built composable fragments + a deterministic composer assemble a project
scaffold in seconds.

## The 9-phase pipeline

`composeTemplate(config, library)` runs these phases in order; each fragment lands at
its declared phase. Ordering is load-bearing — a downstream phase reads contracts the
upstream phase declared.

| #   | Phase    | Always runs? | Notes                                                                                              |
| --- | -------- | ------------ | -------------------------------------------------------------------------------------------------- |
| 1   | base     | yes          | Emits the non-negotiable Tanren surface (justfile, .tanren/ci.yml, BDD home, base skeleton tests). |
| 2   | runtime  | yes          | Language + package manager (node-pnpm / ruby-bundler). Declares `testRunner` + `reportPath`.       |
| 3   | frontend | optional     | UI framework. Depends on runtime.                                                                  |
| 4   | backend  | optional     | API framework. Depends on runtime.                                                                 |
| 5   | db       | optional     | Database + ORM. Depends on runtime.                                                                |
| 6   | auth     | optional     | Auth provider. Depends on db (auth usually needs a user table).                                    |
| 7   | addons   | per-config   | Each addon a separate fragment; resolved in stable id order via `FragmentLibrary.resolveOrder`.    |
| 8   | examples | per-config   | Demo features. Run after addons (an example uses everything).                                      |
| 9   | deploy   | yes          | Deploy target. `deploy: "none"` is the explicit no-deploy marker.                                  |

After every phase, post-processors run as a single batch so they see the full set of
fragment declarations:

- `processDeps` — merge + dedupe + sort `package.json` (node-pnpm only).
- `processEnvVars` — collect every `addEnvVar` into `.env.example`.
- `processJustfile` — splice `appendToJustfileTarget` fills into the base justfile's
  `# TANREN-HOOK: <target>` markers. **Throws on an unknown target name** (a writer
  typo).
- `processCiYml` — fill the evidence block's `reportPath` from the runtime's
  declared contract. **Throws when no fragment declared a test runner.**
- `processReadme` — write a minimal README naming the composed config.
- `assertBaseInvariantsHeld` — re-check `BASE_PROTECTED_FILES` are still present.

## The `base/` fragment (non-negotiable Tanren opinions)

The user's load-bearing constraint: _"Just because we want to take advantage of
templates does not mean we want to allow users to sidestep all of the things that
Tanren is opinionated on, like green CI, strong behavior tie-ins to tests, and
functional demos."_ The `base/` fragment is ALWAYS injected and STRUCTURAL —
runtime/frontend/etc fragments FILL hooks INSIDE this surface, they never REPLACE
it.

`base/` emits:

- `justfile` — recipe SHELL with the required targets (`bootstrap`, `tier-1`,
  `tier-2`, `tier-3`, `build`) and `# TANREN-HOOK: <target>` insertion markers.
- `.tanren/ci.yml` — native CI gate config with evidence declarations on tier-2 +
  tier-3. The reportPath is a placeholder the runtime fills.
- `.gitignore` — Tanren-mandatory exclusions.
- `mise.toml` — toolchain pin (runtime fills `[tools]`).
- `features/.gitkeep` — Cucumber BDD home.
- `tests/.gitkeep` — unit-test home.
- `tests/mutation-baseline.test.ts` — asserts a stryker config file exists, so a
  writer cannot ship a template structurally without mutation testing.
- `tests/functional-demo.test.ts` — asserts a public-surface demo entry exists, so
  "functional demo" is structurally required by the test gate.
- `README.md` stub.

`BASE_PROTECTED_FILES` names the files re-checked after every fragment phase: a
fragment that silently deleted them is rejected with `TemplateComposeError(
"post_process", "base-protected file ... is missing post-compose")`.

## How to add a fragment

1. Create a file under `library/<kind>-<label>.ts`. Export a `Fragment` with:
   - `id`: stable, opaque (`"<kind>-<label>"` is the convention).
   - `version`: semver. The dogfood snapshot's `fragmentVersions` rides on this; a
     bump forces a snapshot diff so reviewers see the version change.
   - `kind`: one of the 9 phases (`FragmentKind`).
   - `contract`: what the fragment provides (`testRunner`, `reportPath`,
     `dbMigrationsDir`, `ciTier2`). Optional per field.
   - `dependsOn`: other fragment ids required before this one applies. Throws at
     resolve time on a missing dependency.
   - `apply(vfs, config)`: mutates the VFS in place via the typed surface
     (`write`, `mergeJson`, `addPackageJsonDep`, `addEnvVar`,
     `appendToJustfileTarget`).
2. Register the fragment in `library/index.ts`'s `ALL_FRAGMENTS` array.
3. If the fragment introduces a new enum value (a new addon, a new deploy
   target), extend the enum in `types.ts`.
4. Re-run the dogfood test with `TANREN_UPDATE_FRAGMENT_SNAPSHOTS=1` to refresh the
   snapshots for any curated config the fragment is part of, AND add a new curated
   config exercising it if appropriate.
5. Commit the fragment, the snapshot diff, and any enum extension in ONE PR — the
   snapshot diff is the review unit.

## The dogfood test mechanism

`tests/templateFragmentDogfood.test.ts` is the load-bearing self-maintenance
mechanism. It does three things:

1. For every fragment in `loadFragmentLibrary()`, runs `apply()` against a fresh
   VFS and asserts no throw.
2. For every curated `TemplateConfig`, composes the full template and asserts the
   resulting VFS hash + flat-map matches a stored snapshot at
   `tests/__snapshots__/templates/<slug>.snap.json`. A drift prints the per-file
   diff naming every changed path.
3. Drives several enforcement scenarios: an unknown-justfile-target fill is
   rejected, a base-protected-file removal is rejected, a missing base fragment is
   rejected, a runtime that declared no test runner is rejected.

To regenerate snapshots after a deliberate fragment change:

```sh
TANREN_UPDATE_FRAGMENT_SNAPSHOTS=1 pnpm vitest run services/orchestrator/tests/templateFragmentDogfood.test.ts
```

Commit the snapshot diff alongside the fragment change. Reviewers read the
snapshot diff as the review unit (file-by-file content delta of every affected
composed config).

## Selection: curated vs synthesized

`selectFragmentConfig` (`selectFragmentConfig.ts`) resolves a lifecycle to a
`TemplateConfig`:

- A curated stack label (`registry/curated.ts` — e.g. _"ts/pnpm + Remix + Prisma +
  PostgreSQL on Fly.io"_) short-circuits to a known `TemplateConfig`.
- A no-match synthesizes a config from the captured lifecycle's stack + deploy
  tokens (open-world: any token maps to a fragment label, no closed enum gates it).
- The returned `TemplateConfig` is walked: every referenced fragment id is either
  present in the library (→ `ready`) or absent (→ `missing-fragments` with
  `FragmentSpec[]`). A missing fragment triggers the per-fragment authoring DAG
  (F2); a fixed-point failure of authoring raises `FragmentAuthoringFailedError`
  and halts the derive loud — no silent skip, no fallback path.
