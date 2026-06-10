# Architecture Notes

This directory documents the **shipped** architecture of Tanren — the durable
seams and the substrate behind them. Phases 0–3 and the autonomy engine
(Phases 1 + 2) are built and merged; these notes describe the system as it runs
on `main`, not a plan. For the phase history and the forward roadmap, see
[`ROADMAP.md`](../../ROADMAP.md); for the durable vision and invariants, see
[`PROJECT_BRIEF.md`](../../PROJECT_BRIEF.md).

## The substrate (always true)

- Postgres schema is defined in `db/src/schema.ts`; the committed Drizzle
  migrations are a **single collapsed baseline**
  (`db/migrations/0000_collapsed_baseline.sql`) **plus additive migrations** layered
  on top of it, and are drift-checked.
- Tenant isolation is **Postgres-RLS-enforced** (denies by default) keyed on a
  session-set org via `db/src/orgScope.ts`; a query off the org-scoped client
  sees zero cross-tenant rows.
- The orchestrator reaches runner workloads through `SshSubstrate`; credentials
  are injected per-session over SSH (Vault per-run scoped tokens), never as
  ambient env or CI secrets.
- Planner, Writer, Checker, and Auditor tasks are queued, claimed, completed, or
  failed through durable run/task/job state; the queue is Postgres-native
  (`FOR UPDATE SKIP LOCKED` + lease) with `LISTEN/NOTIFY` wake (channel
  `tanren_run`).
- Events are appended only through `services/orchestrator/src/engine/eventStore.ts`.
- Writer output is captured from git state (diff bytes + commit metadata), never
  from self-reported completion text.
- The native shell-tier gate (`.tanren/ci.yml`, a `CiConfigV1`) runs over SSH and
  is the **sole merge authority** — delivery is Action-less. The verdict
  publishes as the `tanren/gate` commit status. Mergify is removed; the native
  merge queue (`engine/merge/coordinator.ts`) is the merge engine.

The fake-adapter and in-memory fixtures referenced by tests are **test fixtures
only** (`services/orchestrator/tests/fixtures/`), never in runtime source.

## Adapter seams (slottable behind contracts + conformance suites)

Every backend is a new implementation + registry entry behind a stable contract,
proven by a shared conformance suite — not a refactor. The general-purpose seams:
`Allocator`, `SecretStore`, `JobQueue`, `EventStore`, `SourceConnector`,
`IdentityProvider`, `WriterAdapter`/`AnswererAdapter`, `CostResolver`, and the
`Repositories` data-access seam. (~21 conformance suites live under
`services/orchestrator/tests/conformance/`.)

### The four VCS/merge seams (purpose-decomposed)

The old monolithic `VcsProvider` — one ~26-method GitHub-shaped interface that
embedded forge semantics (`mergeable_state`, `update-branch`, the GitHub PR-merge
endpoint) into engine control flow — is decomposed into four
purpose-shaped contracts, so the merge **decision** is Tanren's and the **host**
is swappable (the host just lands what Tanren authorized). See
[`tanren-owns-the-engine.md`](./tanren-owns-the-engine.md) for the full rationale:

- **`WorkspaceVcsCore`** (`engine/contracts/workspaceVcsCore.ts`) — the local,
  jj-backed VCS core that owns the runner's working copy: clone/import, branch,
  commit, **rebase-onto-a-shifting-base**, first-class conflict recording +
  resolution + descendant restack, and the clean-ref export. jj-only, no git
  fallback.
- **`CodeHost`** (`engine/contracts/codeHost.ts`) — the **minimal** (8-method)
  hosting half: create repo, read default branch, push/fetch a ref, read a
  commit/diff/file, and land an already-authorized ref. GitHub becomes a code
  source / OAuth surface / issue source — **not** the engine.
- **`MergeAuthority`** (`engine/contracts/mergeAuthority.ts`) — the owned,
  host-independent, **fail-closed** decision: what makes merging into `main`
  okay. It unifies the formerly scattered gate + `governancePosture` + review +
  audit + mergeability into one authority.
- **`VisibilityProjection`** (`engine/contracts/visibilityProjection.ts`) — the
  **best-effort** mirror of the change as a PR / check / comment on a forge UI for
  humans. Every method is optional and best-effort by type.

The unified **`integration_nodes`** run model (`engine/contracts/integrationNodes.ts`)
is the one shape for an eager dependent build, a merge-queue batch, and a stacked
PR — work on a base that may shift (`main` + an ordered set of not-yet-landed
ancestor branches). The **never-discard `BaseShiftCoordinator`**
(`engine/dag/baseShiftCoordinator.ts`) jj-rebases dependent work **in place** when
an ancestor lands, rather than superseding-and-regenerating it.

## Documents in this directory

- [`harness-protocol.md`](./harness-protocol.md) — the versioned
  harness↔orchestrator protocol and the capability table (which CLIs write vs.
  answer).
- [`harness-adapter-specs.md`](./harness-adapter-specs.md) — the per-adapter
  mapping onto that protocol.
- [`forge.md`](./forge.md) — the Forge conversation substrate and the thick
  LLM-backed Forge author (propose → approve → execute write actions).
- [`insights.md`](./insights.md) — typed operator-facing workflow insights and
  the DORA / queue / CI analytics families.
- [`product-entities.md`](./product-entities.md) — the Persona → Behavior → Spec
  product model with milestones and DAG dependency edges.
- [`portability-and-longevity.md`](./portability-and-longevity.md) — the
  contracts-as-durable-asset north star (JSON-Schema export, conformance suites,
  mutation testing) and the OSS↔hosting billing seam (budget gate +
  metering-export).
- [`future-refactor-and-scale.md`](./future-refactor-and-scale.md) — the
  10 → 1M scale map and the highest-leverage structural moves (data-access seam,
  plane split) that remain.
- `autonomy-engine.md` — the autonomy core + native merge coordination design
  rationale (DagWalker, real-LLM Forge, the never-discard rebase +
  `MergeAuthority` engine, the stub-ban and real-e2e guardrails).
- [`tanren-owns-the-engine.md`](./tanren-owns-the-engine.md) — the merge-engine
  cutover: the four VCS/merge seams above, the jj `WorkspaceVcsCore`,
  `integration_nodes`, and the never-discard `BaseShiftCoordinator`.
