# Tanren — Mission-Complete Build Handover

**Objective:** finish building the strengthened Tanren engine — the 8 shared spine
contracts (DONE, merged in #931) plus the ~142 consumer nodes fanning off them — so
that we can return to **apex fixtures** and prove a full autonomous loop (rough notes
→ built + deployed product → planted issue → auto-triage → merged fix → verified
live) on an engine that no longer has the gaps v96 exposed.

This directory is the durable, self-contained handover. Everything a fresh agent (or
contributor) needs to drive the remaining work is here or linked from here.

---

## 1. Where we are

- **The spine is built and on `main`** (PR #931, commit `e64c4828`). The 8 shared
  contracts compile, passed a spec-compliance audit, and passed full CI including the
  real-Postgres smoke suite. See §3.
- **The 142 consumer nodes are NOT yet built.** They are fully specified (see
  `nodes/*.md`) and depend on the now-real spine. This is the remaining work.
- **The plan is not a pile of six products — it is one integrated engine.** Read
  `integrated-build-dag.html` (open in a browser) for the visual blueprint and the
  cross-feature seams. That is the thesis: because Tanren owns the whole stack, these
  capabilities compound instead of duplicating.

## 2. The artifacts in this folder

| File | What it is |
|---|---|
| `README.md` (this) | The master handover: objective, DAG, principles, build flow |
| `integrated-build-dag.html` | The visual blueprint — spine + 142 nodes + seams + waves. Open in a browser |
| `build-workflow.mjs` | **The authoritative frozen spec + the build workflow-as-code.** Contains the `RECON`, `CLEAN`, `TYPES`, `PINS` consts (the reconciliation that makes the contracts compose — obey them exactly), the `SPINE`/`CONSUMER`/`MIG` node data, and the runnable Tanren `Workflow` (design → sol audit → build → PR). This is how the spine was built and how the consumers get built |
| `nodes/{mergequeue,runtime,integrations,backhalf,design,governance}.md` | The full per-node specs (data-model, HTTP, UI, apex-proof, deps, validation) from the six `sol` audits. The authoritative node detail |

## 3. The spine (built) — 8 shared contracts

These are the load-bearing interfaces every consumer node builds against. Get them
right and the 142 nodes fan out in parallel; the reason we froze them first is that
six independently-brilliant pitches did **not** compose (two merge authorities,
colliding migrations, duplicate proof stores) — the `sol` integration audit caught it
and produced the reconciliation now frozen in `build-workflow.mjs`.

| # | Contract | Lives at | Migration |
|---|---|---|---|
| SP-1 | Behaviors/personas as immutable revisions | `engine/contracts/behaviorRevision.ts` | `0034` |
| SP-2 | Generalized F2 authoring kernel | `engine/contracts/authoringKernel.ts` | (code) |
| SP-3 | CAS proof/artifact substrate (sole `Digest`/`domainHash`/`CasByteStore`) | `engine/contracts/cas.ts` | `0035` |
| SP-4 | The Authority pattern — `MergeAuthorityV2` (sole land decision; V1 deleted) | `engine/contracts/mergeAuthority.ts`, `engine/merge/mergeAuthorityV2Impl.ts` | `0039` |
| SP-5 | Runtime-verification harness (DSL/driver/observer/render/verdict) | `engine/contracts/runtimeVerification*.ts` | `0037` |
| SP-6 | Extended DeployAdapter (digest/preview/canary/promote/rollback) | `engine/contracts/deployAdapter.ts` | `0036` |
| SP-7 | Native gate evidence + `GateProofBundle` (a profile over SP-3) | `engine/contracts/gateProof.ts` | `0038` |
| SP-8 | Event vocabulary (`event_types` catalog + FK; codegen seed) | `db/src/schemaEventTypes.ts` | `0040` |

The migration band is `0034–0040`, single-owner-per-slot, foundation tables never FK
forward. (The spec's original `0033` base shifted +1 because `origin/main` took `0033`
during the build.)

## 4. The 142 consumer nodes

Full specs are in `nodes/<bucket>.md`. Node IDs, phase (`MVP` = the v97 target that
closes v96's failures; `full` = comparator-beating remainder), and key spine deps
below. Every node = one PR-sized spec.

### merge-queue (16) — builds the never-blockable speculative queue + bisection
`mq-1..5,11` (MVP: v96-clog fix, MergeAuthorityV2 multi-member eval, safe-subset
solver, member isolation, atomic land-group, jj materializer) · `mq-6..10,12..16`
(full: granular proof reuse, flake quarantine, EAGER beam search, semantic partitions,
respec router, deploy/rollback, QueuePolicyV1, dashboard, V2 cutover).

### runtime-verification (26) — behavior→executable tests, "proven not just reachable"
Most of the *spine* was built here (rv-1/2/3/5/6/9/10/11/14/15/21). Remaining consumer
MVP: `rv-4,7,8,12,13,16,17,18,19,20,22,23,24,25,26` (coverage edges, fixture leases,
side-effect observers, A3 causal-correlation, A4 visual, behavior-aware bisection,
flake governance, proof-backed demo, post-merge re-proof, dashboards, apex vertical).

### integrations (22) — provision + bind + cross-validate integrations in the DAG
`in-1..22` (all MVP): lifecycle model + RLS, typed contracts, requirement compiler,
capability DAG nodes, reconciliation saga, ApplicationIntegrationProvisioner, Slack
product binding (fix the wrong-plane bug), BindingMaterializer → `project_app_env`,
transactional delivery outbox, A3 live trigger/observe, Control Center UI, apex
attestation. **This is what makes the fixture's "Slack at 100 clicks" buildable.**

### back-half (35) — trustworthy self-healing that verifies the fix live
MVP closed loop `bh-1..14`: IssueLoop aggregate, provenance, webhook hardening,
`SymptomContractV1`, `SymptomProbeAdapter`, `ResolutionDagWalker`, baseline
reproduction, production symptom verification, `ResolutionAuthority` (sibling, never
lands), source-sync outbox, P0 repair routing, Self-Healing UI. `bh-15..35` full
(rich probes, preview/canary, counterfactual, more sources, signed certificates).

### design-system (9 phase-nodes) — real, fragment-style, framework-adaptive
`ds-0..5` MVP (DesignContractV2, executable token core + base/plain, web adapter
shadcn, F2D missing-fragment authoring, A4 visual gate, Studio/API/theme-reuse);
`ds-6..8` full (queue/demo compounding, Bevy/mobile adapters, cross-org themes).

### governance (34) — control plane that *parameterizes* MergeAuthority
`gv-1..15` MVP: safety repairs (auditPosture guard, strict simulated-review, real
hashes, transitive retarget, truthful budget, notification RLS), immutable policy
revisions + compiler, tiers, bindings + effective-policy receipt, governance F2
kernel, private-repo predicate, review rules + reviewer identity, simulator, admin
API, Governance Studio. `gv-16..34` full (audit-lineage → spec, integration-nodes
authoritative, budget envelopes, CODEOWNERS, host projection, PromotionAuthority,
DORA-by-revision).

### Cross-feature seams (why it's one product)
One fragment kernel (5 families) · A4-render ≡ demo-engine · one trace ID from Forge
sentence → deployed demo · behaviors→tests for free · one Authority pattern with three
heads (Merge/Resolution/Promotion) · one extended DeployAdapter for five consumers ·
audit-finding↔spec · one proof substrate → one `verify` CLI family. Detail in
`integrated-build-dag.html` §"Where the six become one product".

## 5. Principles & motivations (the durable doctrine — do not violate)

1. **Spine-first.** Freeze the shared contracts before building consumers. A wrong
   contract poisons every node that builds on it.
2. **One authority, one proof store, one of each shared thing.** No competing
   authorities, no duplicate CAS/proof stores, no parallel fragment composers.
   `MergeAuthorityV2` is the sole land decision; SP-3 is the sole byte store.
3. **Clean-replace, never cosplay.** Tanren has no real users. DELETE superseded
   code/tables outright — no backwards-compat, no legacy support, no facades, no
   dual-run, no backfill, no "for legacy rows" columns. A green gate must mean the
   NEW path runs end-to-end, not that a shim kept the old one alive.
4. **Compile-first — the compiler is the integration audit.** Prose descriptions
   drift; `just affected-typecheck` (and the real-Postgres smoke suite) are ground
   truth. Do not declare a contract "done" until it compiles and its tests pass.
5. **Supervise the tools, never blindly relay them.** When an agent shells out to
   codex, it OWNS correctness: validate the output, and shell back to fix until it is
   genuinely done. A passive relay that emits a `"test"` stub is a failure.
6. **Convergence-gating.** A `sol` integration audit gates the spine; each round it
   finds finer issues (architecture → types → mechanical pins) — fold them into the
   frozen spec and re-run until `go`. This is the process hardening the foundation.
7. **Model routing by task weight.** Reserve `gpt-5.6-sol` (ultra) for the few large,
   poison-everything audits (integration audit, apex design). Use `codex`
   (`gpt-5.6-luna`) for production authoring. Use `grok`/`glm` for the many light
   verifies (`glm` for the smallest). Not workforce-bound — shell out for capacity.
8. **Provable + callable + visible.** A node is done only when it (a) fires named
   events a live apex run asserts, (b) exposes an HTTP surface, and (c) surfaces in
   the dashboard UI. See each node's `apex-proof`/`http`/`ui` in `nodes/*.md`.
9. **More than the sum.** Design every node to exploit the seams in §4 — the point is
   an integrated engine, not six good tools bolted together.

## 6. The build flow — many parallel agents in worktrees

- **Node = spec = worktree = PR.** Each of the 142 nodes is one PR-sized spec, built
  by a subagent (or a shelled-out codex/grok/glm) in an **isolated git worktree** off
  the latest `origin/main`, gated on `just affected-typecheck` + the node's tests,
  then opened as a **PR to `main`** (`cat-cave/tanren`). It does **not** auto-merge —
  the human/gate agent reviews + merges (routing audits to Claude/GLM to preserve
  Codex).
- **Serialize shared-file / migration work.** Migrations (next free slot `0041+`),
  the event registry, and `screens.ts`/nav are single-owner barriers — never
  concurrent edits. Everything else fans out at `min(16, cores-2)` per workflow.
- **Adversarial cross-model verify per node.** A second agent (different model)
  verifies each built node against its `nodes/*.md` validation column + a negative
  control before it counts as done.
- **The runnable mechanism** is `build-workflow.mjs`: default phase freezes+builds the
  spine (already done); relaunch it with `args: {phase: "consumers"}` to fan out the
  76 MVP consumer nodes off the now-merged spine (build → push PR → verify, sequential
  where shared-branch, gated). Waves: `0` spine (done) → `1` spine impl (done) → `2`
  consumer MVP → `3` the v97 apex vertical → `4` full-tier.

## 7. The objective, restated: back to apex fixtures

The whole point is to return to apex with an engine that closes what v96 could not:
- **v96's persistence bug was a deploy-infra gap** (fixed: single-instance reap, #930)
  — the back-half loop fired but couldn't autonomously fix an infra bug.
- **The fair test** the engine must now pass: a clean apex run with a **product-level**
  planted bug — notes → build → deploy → planted issue → auto-triage → merged fix →
  **re-verified live symptom** (SP-5 + back-half) → working product, no human in the
  inner loop; plus the Slack-at-100 integration actually firing (integrations bucket)
  and the merge queue never hard-stalling on an unconvergeable spec (merge-queue
  bucket, the v96 halt).
- The v97 apex vertical is authored as Wave 3 (`rv-26` + `in-22`) — it is the
  acceptance test for the whole program.

Provenance: this plan came from six `gpt-5.6-sol` "unlimited-ambition" audits (one per
bucket) → 142 extracted nodes → the integrated synthesis (`integrated-build-dag.html`)
→ the convergence-gated spine build (this handover). Full history is in the session.
