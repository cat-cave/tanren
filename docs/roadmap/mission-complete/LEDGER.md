<!-- cspell:ignore evsub descoped -->

# Mission-complete node ledger — the single source of truth

**This file is the authoritative live status of the 142 consumer nodes.** Prose
counts anywhere else (README, CLAUDE.md) are derived from here. When a node lands,
update its row here in the **same PR** that merges it. Node IDs and specs are frozen
by `integrated-build-dag.html` + `build-workflow.mjs.txt`; this file tracks _status_.

**Last reconciled:** 2026-07-17 (post #997 — WAVE-4 COMPLETE: barrier 0056-0060 + ds-1/gv-8/bh-5/mq-5/bh-7; mq-4 also landed).

## Status vocabulary

| Status           | Meaning                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| ✅ `done`        | Merged to `main` + independent audit GO + provable/callable/visible. **Node credit counted.**                                      |
| 🟡 `in-flight`   | Has a live worktree/PR; not yet merged. **0 credit until merged.**                                                                 |
| 🧱 `spine-built` | Substrate already built as part of the 8-contract spine (#931). Not a separate consumer-node credit.                               |
| ⬜ `todo`        | Specced, dependency-ready or waiting on deps; not started.                                                                         |
| 🚧 `spec-debt`   | Counted in the 142 but **not individually specced** in the repo yet (collapsed capability group). Must be broken out before build. |

## Rollup

| Bucket               | Total   | MVP     | ✅ done         | 🟡 in-flight | 🚧 spec-debt   |
| -------------------- | ------- | ------- | --------------- | ------------ | -------------- |
| merge-queue          | 16      | 6       | 6 (mq-1..5,11)  | 0            | 0              |
| runtime-verification | 26      | 15¹     | 1² (rv-4)       | 0            | 0              |
| integrations         | 22      | 22      | 5 (in-1,2,3,4,16) | 0          | 0              |
| back-half            | 35      | 14      | 7 (bh-1..5,7,9) | 0            | 21 (bh-15..35) |
| design-system        | 9       | 6       | 3 (ds-0,1,2)    | 0            | 0              |
| governance           | 34      | 15      | 9 (gv-1..9)     | 0            | 19 (gv-16..34) |
| **Total**            | **142** | **~78** | **31**          | **0**        | **40**         |

¹ 11 rv nodes (rv-1/2/3/5/6/9/10/11/14/15/21) were built as spine → `spine-built`, not consumer MVP.
² Strict completion **31/142 = 22%**. Serial chain in-1/gv-2/rv-4/mq-2 (2026-07-16). **Wave-1 parallel fan-out (2026-07-16/17):** barrier pre-flight #971 (notif RLS 0045 + 52-event freeze 0046) → in-16/gv-3/gv-6 merged; **rv-20 deferred** (blocked on the unbuilt runtime-verification attempt-writer / rv-11) and **in-5 deferred** (requirement compiler needs an LLM-intent design, not lexical matching) — both branches preserved on origin. **Wave-2 (2026-07-17):** pre-flight #975 (gov 0047 + wave-2 4-event 0048) → **gv-7** (#977, deterministic policy compiler + append-only revision store), **in-3** (#978, typed integration event emitter + read surface), **mq-3** (#979, ddmin/QuickXPlain safe-subset solver); **bh-1** (#976, IssueLoop aggregate + immutable findings, 0049) and **ds-0** (#981, DesignContractV2 + design foundation, 0050) landed the back-half + design spines. **Wave-3 (2026-07-17):** barrier #983 (0051–0055 + 7-event freeze) → **bh-4** (#985 symptom store), **bh-9** (#982 DeployAdapter/release_instances), **bh-2** (#988 provenance/triage-task), **bh-3** (#986 webhook hardening). **mq-4** (#987 partition leases) landed after the coordinator-regression fix. Two real bugs the audits missed but full CI caught: #989 (invalid inbox_sources kind, masked since bh-1) + #990 (vitest .codex/worktrees contamination). **Wave-4 (2026-07-17):** barrier #992 (0056–0060 + event freeze) → **bh-5** (#995), **bh-7** (#997 forge intake + sibling-outbox), **mq-5** (#996), **gv-8** (#994 repo_visibility), **ds-1** (#993 web adapter foundation). **Wave-5 (2026-07-17):** barrier #999 (0061–0062) → **mq-11** (#1002 IntegrationNodeMaterializer), **in-4** (#1000), **ds-2** (#1003 web adapter MVP), **gv-9** (#1001, migration 0063, policy bindings + immutable effective-policy receipts — one-active-binding-per-project via `is_active` partial unique index, fixing the A→B→A tier-re-promotion supersession bug the grok audit caught). Next free migration slot: **0064**. Each RLS proof asserts as the non-superuser `tanren_app` role + is wired into a `smoke-rls-*` recipe.

> **Honesty flag — the 142 is partly aspirational.** The **MVP tier (~78 nodes, the
> v97 acceptance target) is fully specced.** The **full tier has 40 nodes of spec
> debt**: back-half `bh-15..35` (21) is collapsed into 16 named capabilities, and
> governance `gv-16..34` (19) is a single collapsed group (only gv-16/21/29/32 are
> named). These must be broken into real per-node specs before they can be built —
> that authoring is itself pre-work, not a countable node.

## In-flight worktrees → nodes

| Worktree              | Node             | State                                                                                                                                    |
| --------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| ~~`in-1-final-fold`~~ | in-1             | ✅ **MERGED #966** (2026-07-16) — org-costs FK reconciled, 22-table RLS proof, grok GO. Worktree retired.                                |
| ~~`rv-4-final`~~      | rv-4             | ✅ **MERGED #969** (2026-07-16) — 0044 composite-FK cross-org proof, wired into smoke, grok GO. Worktree retired.                        |
| ~~`gv-2-final`~~      | gv-2             | ✅ **MERGED #968** (2026-07-16) — rebased onto post-in-1, cred-ref reconcile, intent_pending cosplay removed, grok GO. Worktree retired. |
| ~~`mq-2-final`~~      | mq-2             | ✅ **MERGED** (this PR) — re-ported clean; 7 dispositions genuine (2 read-side descoped from cosplay), grok GO. Worktree retired.        |
| `in-7-evsub-w1a`      | (in-7 substrate) | Event substrate, ci passed; 0 node credit until in-7 producer+HTTP+UI+apex lands.                                                        |

---

## merge-queue (16)

| Node  | Phase | Status  | Purpose                                                             | Deps             |
| ----- | ----- | ------- | ------------------------------------------------------------------- | ---------------- |
| mq-1  | MVP   | ✅ done | v96 regression lock + typed authority reasons (policy ≠ infra)      | SP·4             |
| mq-2  | MVP   | ✅ done | MergeAuthority-V2 multi-member eval, 7 typed dispositions           | mq-1 · SP·1/3    |
| mq-3  | MVP   | ✅ done | Generalized safe-subset solver (ddmin / QuickXPlain) (#979)         | mq-2 · SP·3      |
| mq-4  | MVP   | ✅ done | Member isolation + partition-scoped leases (no project-wide lock)   | mq-2 · SP·1      |
| mq-5  | MVP   | ✅ done | Atomic land-group reconciliation (one CAS, all members)             | mq-2/3 · SP·3/4  |
| mq-11 | MVP   | ⬜ todo | IntegrationNodeMaterializer behind jj WorkspaceVcsCore              | mq-5 · SP·3/4    |
| mq-6  | full  | ⬜ todo | Granular Merkle proof graph — per-unit reuse                        | mq-2 · SP·3/5    |
| mq-7  | full  | ⬜ todo | Flake classification + exact quarantine + epochs                    | mq-3/6 · SP·5    |
| mq-8  | full  | ⬜ todo | EAGER speculative beam search (build before ready)                  | mq-4/6 · SP·4    |
| mq-9  | full  | ⬜ todo | IntegrationGraphScheduler + semantic partitions + dynamic batches   | mq-3/4/6         |
| mq-10 | full  | ⬜ todo | Autonomous repair + re-spec router (RespecPacketV1)                 | mq-2/3 · SP·1/2  |
| mq-12 | full  | ⬜ todo | Fragment/F2 evidence-contract extension                             | mq-6/7 · SP·2/5  |
| mq-13 | full  | ⬜ todo | Deploy/verify/demo/rollback loop extension                          | mq-5/10 · SP·5/6 |
| mq-14 | full  | ⬜ todo | QueuePolicyV1 + full comparator ops (freeze/pause/windows/commands) | mq-2/4/9 · SP·4  |
| mq-15 | full  | ⬜ todo | Dashboard merge-train viz + exportable signed artifacts             | mq-2/3/6/7/10/13 |
| mq-16 | full  | ⬜ todo | Merge-Queue-V2 backfill / one-way authority cutover                 | mq-2/5 · SP·8    |

## runtime-verification (26)

| Node  | Phase | Status         | Purpose                                                           | Deps               |
| ----- | ----- | -------------- | ----------------------------------------------------------------- | ------------------ |
| rv-1  | MVP   | 🧱 spine-built | Immutable behavior revisions + spec binding (SP·1)                | —                  |
| rv-2  | MVP   | 🧱 spine-built | Executable-plan compiler + typed assertion DSL                    | rv-1               |
| rv-3  | MVP   | 🧱 spine-built | Verification-fragment registry + F2 authoring (SP·2)              | rv-2 · SP·2        |
| rv-4  | MVP   | ✅ done        | Behavior coverage edges + affected selection (#969)               | rv-1/2             |
| rv-5  | MVP   | 🧱 spine-built | Preview deployment adapter (Fly lifecycle) (SP·6)                 | rv-1 · SP·3        |
| rv-6  | MVP   | 🧱 spine-built | Driver adapters — Playwright + API/CLI/package/mobile             | rv-2/5             |
| rv-7  | MVP   | ⬜ todo        | Fixture lease adapter (isolated tenant/channel/data)              | rv-5/8             |
| rv-8  | MVP   | ⬜ todo        | Side-effect observer adapter (Slack; cursor/watermark)            | rv-7/12            |
| rv-9  | MVP   | 🧱 spine-built | Render-capture + content-addressed artifact store (SP·3)          | rv-6               |
| rv-10 | MVP   | 🧱 spine-built | Per-behavior verdict store (runs/attempts/verdicts)               | rv-6/9             |
| rv-11 | MVP   | 🧱 spine-built | A1 executable-acceptance orchestrator                             | rv-5/6/7/10        |
| rv-12 | MVP   | ⬜ todo        | A3 causal-correlation protocol + cardinality assertions           | rv-8/11            |
| rv-13 | MVP   | ⬜ todo        | A4 DesignContractV2 + rendered visual verification                | rv-9/11 · ds-4     |
| rv-14 | MVP   | 🧱 spine-built | Effective native gate + GateProofBundleV2 (SP·7)                  | rv-10/11/13 · SP·4 |
| rv-15 | MVP   | 🧱 spine-built | MergeAuthority-V2 runtime outcome + proof-reuse V2 (SP·4)         | rv-14              |
| rv-16 | MVP   | ⬜ todo        | Behavior-aware merge-queue bisection                              | rv-11/14/15 · mq   |
| rv-17 | MVP   | ⬜ todo        | Flake classification + quarantine governance                      | rv-10/16           |
| rv-18 | MVP   | ⬜ todo        | Proof-backed demo engine (A2) — no more `/` probe                 | rv-10/19           |
| rv-19 | MVP   | ⬜ todo        | Post-merge production re-proof + rollback hook                    | rv-5/11/15         |
| rv-20 | MVP   | ⏸ deferred     | `ci_test_results` compatibility projection                        | rv-10              |
| rv-21 | MVP   | 🧱 spine-built | Forge interview + DesignContract synthesis (SP·1)                 | rv-1/13            |
| rv-22 | MVP   | ⬜ todo        | HTTP surface + read-compat guard                                  | rv-1/2/10/13/14    |
| rv-23 | MVP   | ⬜ todo        | Dashboard surfaces (Behavior Proof Matrix + 6 more)               | rv-22 · SP·8       |
| rv-24 | MVP   | ⬜ todo        | Exportable proof bundles + `tanren proof verify` CLI              | rv-14/15/9         |
| rv-25 | MVP   | ⬜ todo        | Event-schema registration                                         | SP·8               |
| rv-26 | MVP   | ⬜ todo        | Apex workflow — 16 positive + 10 negative proofs (v97 acceptance) | rv-1..19/24/25     |

## integrations (22) — all MVP

| Node  | Status  | Purpose                                                                          | Deps                |
| ----- | ------- | -------------------------------------------------------------------------------- | ------------------- |
| in-1  | ✅ done | Integration lifecycle data model + RLS migration (#966)                          | SP·1                |
| in-2  | ✅ done | Typed lifecycle contracts (IntegrationRequirementV1 …)                           | SP·1                |
| in-3  | ✅ done | Typed integration event vocabulary + read surface (#978)                         | in-1 · SP·8         |
| in-4  | ⬜ todo | IntegrationStateWriter (control-plane) + data-plane de-priv                      | in-1/3              |
| in-5  | ⏸ defer | Requirement compiler from G/W/T + DesignContract                                 | in-2/1 · SP·1       |
| in-6  | ⬜ todo | Project deriving→active lifecycle + DagWalker gating                             | in-5/1/9/10         |
| in-7  | ⬜ todo | Integration fragment phase + F2 authoring (SP·2) — substrate in `in-7-evsub-w1a` | in-2 · SP·2         |
| in-8  | ⬜ todo | `.tanren/integrations.yml` contract + JSON schema                                | in-7/2              |
| in-9  | ⬜ todo | capability_prepare DAG node + provider work queue                                | in-1/10             |
| in-10 | ⬜ todo | Capability nodes/edges + awaiting_grant grant-wake                               | in-9/1/4            |
| in-11 | ⬜ todo | Durable reconciliation saga + progress retry + state_unknown                     | in-10/1/4 · SP·3    |
| in-12 | ⬜ todo | ApplicationIntegrationProvisioner kit + vertical conformance                     | in-2/7 · SP·2       |
| in-13 | ⬜ todo | Slack product binding — relay + direct (fix wrong-plane bug)                     | in-12/14/19         |
| in-14 | ⬜ todo | BindingMaterializer → project_app_env + scoped Vault                             | in-13/1 · SP·3      |
| in-15 | ⬜ todo | Immutable binding contract + appEnvHash proof + gate tests                       | in-14/9 · SP·3/5    |
| in-16 | ✅ done | Transactional delivery outbox on authorized land                                 | in-1 · SP·4         |
| in-17 | ⬜ todo | Durable resumable post-merge delivery DAG (bind→deploy) (SP·6)                   | in-16/14/19 · bh    |
| in-18 | ⬜ todo | Non-clogging merge-queue park/dequeue disposition                                | in-15/9 · mq        |
| in-19 | ⬜ todo | A3 live trigger/observe + effect probe + negative controls                       | in-17/13 · SP·5     |
| in-20 | ⬜ todo | Full HTTP surface + generated API schemas                                        | in-1..4/10/15/17/19 |
| in-21 | ⬜ todo | Integration Control Center UI + exports + CLI                                    | in-20/8/19          |
| in-22 | ⬜ todo | APEX artifact readers + evidence attestation (v97 acceptance)                    | in-19/17/15/3       |

## back-half / self-healing (35)

| Node      | Phase | Status       | Purpose                                                                                                                                                                                                                                                                                                                                                       | Deps                  |
| --------- | ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| bh-1      | MVP   | ✅ done      | IssueLoop aggregate + immutable source findings (#976)                                                                                                                                                                                                                                                                                                        | SP·1/3                |
| bh-2      | MVP   | ✅ done      | Provenance correction + triage-as-real-task (#988)                                                                                                                                                                                                                                                                                                            | bh-1                  |
| bh-3      | MVP   | ✅ done      | Webhook intake hardening (idempotent, claim-leased) (#986)                                                                                                                                                                                                                                                                                                    | bh-1 · SP·3           |
| bh-4      | MVP   | ✅ done      | SymptomContractV1 immutable store (store-only) (#985)                                                                                                                                                                                                                                                                                                         | bh-1 · SP·1/2/3       |
| bh-5      | MVP   | ✅ done      | SymptomProbeAdapter + evidence substrate (reuses SP·5)                                                                                                                                                                                                                                                                                                        | bh-4 · SP·5/3         |
| bh-6      | MVP   | ⬜ todo      | ResolutionDagWalker (durable orchestration)                                                                                                                                                                                                                                                                                                                   | bh-1/4/8/12/14 · SP·4 |
| bh-7      | MVP   | ✅ done      | IssueSourceAdapter (GitHub + manual)                                                                                                                                                                                                                                                                                                                          | bh-1/3 · SP·4         |
| bh-8      | MVP   | ⬜ todo      | Baseline reproduction stage                                                                                                                                                                                                                                                                                                                                   | bh-4/5/6              |
| bh-9      | MVP   | ✅ done      | Extended DeployAdapter + release_instances (#982)                                                                                                                                                                                                                                                                                                             | bh-1 · SP·4           |
| bh-10     | MVP   | ⬜ todo      | Production symptom verification stage                                                                                                                                                                                                                                                                                                                         | bh-4/5/8/9/6          |
| bh-11     | MVP   | ⬜ todo      | ResolutionAuthority (fail-closed, never lands) (SP·4 sibling)                                                                                                                                                                                                                                                                                                 | bh-10 · SP·4          |
| bh-12     | MVP   | ⬜ todo      | Source-sync outbox + readback                                                                                                                                                                                                                                                                                                                                 | bh-7/11/6             |
| bh-13     | MVP   | ⬜ todo      | P0 repair routing (failure → new successor spec)                                                                                                                                                                                                                                                                                                              | bh-11/1 · SP·4/5      |
| bh-14     | MVP   | ⬜ todo      | Minimal proof bundle + Self-Healing UI                                                                                                                                                                                                                                                                                                                        | bh-1..13 · SP·3       |
| bh-15..35 | full  | 🚧 spec-debt | 21 nodes collapsed into 16 named capabilities (behavior loading, rich probes, preview/canary, counterfactual replay, F2 fragments, more sources, soak grades, batch verify+bisect, health barriers, rollout/rollback, cross-repo loops, failure-aware routing, signed certs, proof-verify CLI, fleet analytics, live burn-in). **Break out before building.** | bh-1..14 · SP·5/6     |

## design-system (9)

| Node | Phase | Status  | Purpose                                                                                        | Deps                 |
| ---- | ----- | ------- | ---------------------------------------------------------------------------------------------- | -------------------- |
| ds-0 | MVP   | ✅ done | Design contracts & schema foundation (DesignContractV2, RLS, proof keys) (#981)                | SP·1..8              |
| ds-1 | MVP   | ✅ done | Executable token core (DTCG resolver, base/plain, DesignVfs, CAS, offline validator)           | ds-0 · SP·3/1        |
| ds-2 | MVP   | ⬜ todo | Web adapter MVP (shadcn/Radix/Tailwind, catalog, exports, Writer injection)                    | ds-0/1 · SP·2        |
| ds-3 | MVP   | ⬜ todo | F2D — author missing design fragments (selector, checker/auditor loop, atomic persist/retract) | ds-0/1/2 · SP·2/3/5  |
| ds-4 | MVP   | ⬜ todo | A4 visual verification + native gate (render harness, screenshots/a11y, negative controls)     | ds-0..3 · SP·5/3/4/1 |
| ds-5 | MVP   | ⬜ todo | Dashboard/API/within-org theme reuse (Studio, evidence lab, bindings, exports)                 | ds-0..4 · SP·1/3     |
| ds-6 | full  | ⬜ todo | Queue/deploy/demo compounding (design-aware proof keys, eager matrix, live demo, A4≡demo)      | ds-4/5 · SP·5/4/3    |
| ds-7 | full  | ⬜ todo | Full framework reach (Bevy, SwiftUI, Compose, Flutter, RN, document/media adapters)            | ds-2/4 · SP·5/2      |
| ds-8 | full  | ⬜ todo | Ecosystem & cross-org (Figma bridge, public projection, grants/forks, external registry)       | ds-5/6 · SP·4/3      |

## governance (34)

| Node      | Phase | Status       | Purpose                                                                                                                                                                                                                                                                                                                                                                                   | Deps                |
| --------- | ----- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| gv-1      | MVP   | ✅ done      | auditPosture write-guard safety repair (close PATCH authz bypass)                                                                                                                                                                                                                                                                                                                         | SP·3/4              |
| gv-2      | MVP   | ✅ done      | Strict simulated-review forge publication (real APPROVE/REQUEST_CHANGES) (#968)                                                                                                                                                                                                                                                                                                           | SP·3/4              |
| gv-3      | MVP   | ✅ done      | Real policy/gate hashes (replace schema literal `1` + empty CI hash)                                                                                                                                                                                                                                                                                                                      | SP·3/4              |
| gv-4      | MVP   | ✅ done      | Transitive stack retarget safety repair (full ancestor member vector)                                                                                                                                                                                                                                                                                                                     | SP·3/4              |
| gv-5      | MVP   | ✅ done      | Truthful budget-held event (`readyHeldBack` no longer always zero)                                                                                                                                                                                                                                                                                                                        | SP·3/4              |
| gv-6      | MVP   | ✅ done      | Notification ledger RLS + route toggle + Slack contract fix                                                                                                                                                                                                                                                                                                                               | SP·3/4              |
| gv-7      | MVP   | ✅ done      | Immutable policy revisions + deterministic compiler (#977)                                                                                                                                                                                                                                                                                                                                | gv-3 · SP·1/3       |
| gv-8      | MVP   | ✅ done      | Governance tiers + four presets (incl. private/regulated)                                                                                                                                                                                                                                                                                                                                 | gv-7                |
| gv-9      | MVP   | ⬜ todo      | Policy bindings + effective-policy snapshots (receipt)                                                                                                                                                                                                                                                                                                                                    | gv-7/8 · SP·3       |
| gv-10     | MVP   | ⬜ todo      | Governance fragment kernel + F2 authoring (shares SP·2)                                                                                                                                                                                                                                                                                                                                   | gv-7 · SP·2/1       |
| gv-11     | MVP   | ⬜ todo      | Private-repo visibility as enforced predicate                                                                                                                                                                                                                                                                                                                                             | gv-7/9              |
| gv-12     | MVP   | ⬜ todo      | Core review rules + dedicated reviewer identity                                                                                                                                                                                                                                                                                                                                           | gv-2/9 · SP·4       |
| gv-13     | MVP   | ⬜ todo      | Policy simulator / validate / explain + contradiction witnesses                                                                                                                                                                                                                                                                                                                           | gv-7/9 · SP·5       |
| gv-14     | MVP   | ⬜ todo      | Governance admin HTTP API + import facade                                                                                                                                                                                                                                                                                                                                                 | gv-7/8/9/13         |
| gv-15     | MVP   | ⬜ todo      | Governance Studio UI                                                                                                                                                                                                                                                                                                                                                                      | gv-7..14 · SP·8     |
| gv-16..34 | full  | 🚧 spec-debt | 19 nodes, collapsed group. Only 4 named: gv-16 (audit-lineage finding→spec), gv-21 (deploy-dependent), gv-29 (PromotionAuthority), gv-32 (signed export bundle + CLI). Rest (budget envelopes, CODEOWNERS, host projection, break-glass, freezes, quorums/SoD, queue-controls-as-policy, notification outbox, DORA-by-revision, rollout/drift) unnumbered. **Break out before building.** | gv-1..15 · SP·4/5/6 |
