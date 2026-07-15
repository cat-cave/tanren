# Smoke stack identity — ownership card

This PR clean-replaces the dependency-only `just smoke` path with one fail-closed
coordinator. A passing receipt must bind every probe to one explicit Compose
project, one clean Git commit/tree, the images built from that tree, and the
candidate stack's discovered endpoints. Decoy/default stacks are negative
controls, never fallbacks.

## Owned paths

- `package.json` (root typecheck composition only)
- `.github/workflows/ci.yml`
- `.dockerignore`
- `.gitignore`
- `cspell.json` (pgid / process-fence terms only)
- `justfile` (collision-sensitive with control-plane; keep scoped)
- `compose.dev.yml`
- `services/orchestrator/Dockerfile`
- `services/allocator/Dockerfile`
- `services/dashboard/Dockerfile`
- `runner/Dockerfile`
- `cli/src/main.ts`
- `cli/src/httpClient.ts`
- `cli/tests/commands.test.ts`
- `scripts/check-architecture-timeouts.mjs`
- `scripts/check-architecture-timeouts.test.ts`
- `scripts/acceptance/common.ts` (timeout-doctrine field cleanup only)
- `scripts/acceptance/config.ts` (timeout-doctrine field cleanup only)
- `scripts/smoke/plane-split-worker.ts`
- `scripts/smoke/plane-split-deprivilege.ts`
- `scripts/smoke/plane-split-tx.ts` (new)
- `scripts/smoke/plane-split-tx.test.ts` (new)
- `scripts/smoke/stack-db-stage-runners.ts` (new)
- `scripts/dev/seed-platform-creds.test.ts`
- `scripts/dev/seed-platform-creds.ts`
- `scripts/smoke/run-stack.ts` (new)
- `scripts/smoke/stack-bootstrap.ts` (new)
- `scripts/smoke/stack-context.ts` (new)
- `scripts/smoke/stack-paths.ts` (new)
- `scripts/smoke/stack-provenance.ts` (new)
- `scripts/smoke/stack-runtime.ts` (new)
- `scripts/smoke/stack-lifecycle.ts` (new)
- `scripts/smoke/stack-gates.ts` (new)
- `scripts/smoke/stack-operations.ts` (new)
- `scripts/smoke/stack-worker.ts` (new)
- `scripts/smoke/stack-process.ts` (new)
- `scripts/smoke/stack-progress.ts` (new)
- `scripts/smoke/stack-build.ts` (new)
- `scripts/smoke/stack-build-corepack.ts` (new)
- `scripts/smoke/stack-cleanup.ts` (new)
- `scripts/smoke/stack-stages.ts` (new)
- `scripts/smoke/stack-finalize.ts` (new)
- `scripts/smoke/stack-receipt.ts` (new)
- `scripts/smoke/stack-context.test.ts` (new)
- `scripts/smoke/stack-provenance.test.ts` (new)
- `scripts/smoke/run-stack.test.ts` (new)
- `scripts/smoke/stack-lifecycle.test.ts` (new)
- `scripts/smoke/stack-worker.test.ts` (new)
- `scripts/smoke/stack-process.test.ts` (new)
- `scripts/smoke/stack-build.test.ts` (new)
- `scripts/smoke/stack-build-install.test.ts` (new)
- `scripts/smoke/stack-build-offline.test.ts` (new)
- `scripts/smoke/tsconfig.json` (new persistent smoke typecheck gate)
- `scripts/smoke/stack-cleanup.test.ts` (new)
- `scripts/smoke/stack-operations.test.ts` (new)
- `scripts/smoke/stack-paths.test.ts` (new)
- `scripts/smoke/stack-progress.test.ts` (new)
- `scripts/smoke/stack-receipt.test.ts` (new)
- `scripts/smoke/stack-stages.test.ts` (new)
- `docs/operator-guide/deploy.md`
- `docs/roadmap/mission-complete/README.md`
- `docs/roadmap/mission-complete/smoke-stack-identity.md` (this card)

No DB migration, event registry, event writer, navigation, or product authority
file is owned. Do not edit the frozen `docs/roadmap/mission-complete/build-workflow.mjs.txt`.

## Dependency and merge order

Implementation may proceed from `origin/main` now. The mission-control-plane
unit also edits `justfile`, so this branch must rebase onto and merge **after**
`mission/control-plane-recon`; all other overlaps require explicit coordination
before editing. After that rebase, rerun the full gate and exact-stack smoke
before merge. README/justfile remain collision-sensitive — keep their changes
scoped and report them for later rebase.

Runtime socket selection stays in the already-authorized operator `justfile`
boundary. The TypeScript coordinator accepts only the resulting explicit,
validated provider/socket pair; this unit adds no architecture exception.

## Gate proof

The uncommitted handoff runs the focused adversarial decoy/isolation suite,
affected checks, namespace-masked `just fast-check`, and namespace-masked `just ci`.
Live `just smoke` remains an explicit post-commit, post-rebase prerequisite
because the coordinator correctly rejects a dirty candidate tree; it is not
replaced by a weaker synthetic claim. The eventual JSON receipt records only
non-secret commit/tree, project, image/container, endpoint, and probe evidence.

## Clean-source dependency materialization

The clean build context archives exact HEAD into an owned source directory,
verifies every blob/mode against the recorded tree, then materializes
dependencies inside that owned source with `corepack pnpm install
--frozen-lockfile --prefer-offline --store-dir <owned>`. The candidate-root
`node_modules` is never borrowed or symlinked; resolution never traverses the
candidate checkout. Installed link farms live under the clean source with an
owned HOME/cache/config/state/TMPDIR area under the build base. The install
environment is a CONSTRUCTED ALLOWLIST (only the owned paths plus deterministic
benign `CI`/`LANG`/`LC_ALL`/`TZ` and a trusted PATH built from the Node
executable directory plus fixed system directories) — there is no copy step, so
`DATABASE_URL`, `TANREN_*`, GitHub/provider/cloud/runner keys, arbitrary auth,
`NODE_OPTIONS`, npm/pnpm/yarn/corepack config, proxy/CA overrides, and the
ambient `PATH` cannot reach the install. `COREPACK_ENABLE_NETWORK` is first-class
deterministic policy state inside that exact allowed-key contract: constructed as
`"1"` for production prefer-offline and `"0"` for strict offline, never copied
from an ambient value, and threaded from `createCleanBuildContext` through
`isolatedInstallEnv` to the child with no later spread/overlay. corepack is
resolved on that trusted PATH and the install fails closed if it is absent; the
pnpm store is an owned directory under the build-base cache. A failed install
fails closed: the build base is removed by bootstrap cleanup, leaving no usable
prepared context.

The production default remains `--frozen-lockfile --prefer-offline` (with
`COREPACK_ENABLE_NETWORK="1"`) against an owned empty store. A typed
`InstallNetworkPolicy` seam allows the real workspace fixture to select strict
offline mode (`--offline` + `COREPACK_ENABLE_NETWORK="0"`) through the same
`defaultInstallMaterializer`. Strict offline mode passes only a data-only
`CorepackCacheSeed` descriptor (`{ sourceRoot, packageManager }`, never an
executable callback) into the materializer; production code in `seedCorepackCache`
reads the clean source `package.json`, requires its exact `packageManager`
(currently `pnpm@11.1.0` in the fixture), verifies the seed's matching
`v1/<name>/<version>/package.json` manifest, recursively rejects every symlink
and non-regular/non-directory entry, requires the seed root be neither equal to
nor an ancestor/descendant of the destination (path-segment aware, so sibling
names are never mistaken for nesting), byte-copies the seed into the owned
`COREPACK_HOME`, then re-verifies the copied manifest. The fixture prefetched the exact cache outside the protected
invocation (asserting the prefetch command returns exactly `11.1.0`) and passes
only the descriptor — no test-only authority can derive `<base>/source`, write
`node_modules`, rewrite package metadata, or populate the pnpm store. Strict mode
with an empty cache (no seed) fails closed at the child rather than reaching the
network, proving Corepack cannot fetch under `COREPACK_ENABLE_NETWORK="0"`.

Because the install runs before any of the 56 production stages exist, its
command/process evidence is recorded on a distinct typed bootstrap-install
ledger entry (sanitized executable/argv, the exact clean-source cwd, the owned
process-group start+exit, and terminal exit status — never env/secrets) that
survives into `PreparedSmokeRun` and the final/partial receipt as
`bootstrap.install`, outside the production-stage list. The execution
fingerprint is taken after materialization and truthfully records `node_modules`
(at any depth, including package-local) as opaque tool state — never hashing
dependency bytes and never allowing `node_modules` to masquerade as source.

## Persistent smoke typecheck gate

`scripts/smoke/tsconfig.json` typechecks every production and test TS file in
`scripts/smoke` under the repo's strict TypeScript 7/NodeNext rules (`noEmit`,
Node types). It is composed into the canonical root `typecheck` path as the
named `typecheck:smoke` script, so `just typecheck` / `just fast-check` /
`just ci` cover the smoke scripts that otherwise only run through `tsx`.
