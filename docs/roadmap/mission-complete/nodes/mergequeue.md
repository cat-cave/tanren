## (1) IDEAL DESIGN + how it fits the engine + the owned-stack advantages it exploits

The ideal system is not a faster FIFO queue. It is a **proof-carrying integration graph**: every speculative composition is a first-class `IntegrationNode`; every gate, behavior, audit, policy, and conflict result is attributed to exact members; and `MergeAuthority` authorizes the largest proven-safe, dependency-closed subset. A failing member immediately leaves the active embark for repair or re-specification, while unrelated work continues.

### Diagnosis: the v96 failure is a split-authority, head-of-line liveness bug

The current implementation has two disconnected decision planes:

1. `PgBatchChecker` assembles a prospective jj tree and runs only the native `pre_merge` gate; it does not evaluate land-time findings, reviews, or policy [batchChecker.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchChecker.ts:1).
2. A checker `pass` emits `merge.batch.passed`, then immediately switches to sequential real lands [batchCoordinator.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchCoordinator.ts:213).
3. Bisection is reachable only for checker-returned `fail` or `conflict` [batchCoordinator.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchCoordinator.ts:251). `BatchCheckVerdict` has no policy/authority/member-ineligible outcome at all [batchMergeCoordinator.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/batchMergeCoordinator.ts:263).
4. Audit findings are first re-read later, independently for each member’s land [mergeAuthorityBundleBuild.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityBundleBuild.ts:147).
5. A P1 posture violation becomes the policy block at [mergeAuthorityImpl.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityImpl.ts:186). The authority node built for that attempt is single-member, not the proven batch node [mergeAuthorityGate.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityGate.ts:166).
6. The structured authority reason contains only `input` plus free text [mergeAuthority.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/mergeAuthority.ts:173), is flattened to strings [mergeAuthorityGate.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityGate.ts:234), and every `blocked` decision is incorrectly declared transient [mergeLandPaths.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/reviewMerge/mergeLandPaths.ts:259).
7. `mergeBatch` stops on the first held member, so it never attempts later safe siblings [batchCoordinator.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchCoordinator.ts:414).

Therefore, **the bisection did not malfunction; it was never invoked**. By the time MergeAuthority saw the P1, the only bisection boundary had already closed.

There is one forensic precision to retain. In current HEAD, a returned P1 follows the per-entry recoverable ceiling [batchCoordinatorSettle.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchCoordinatorSettle.ts:196), repeatedly emitting `merge.queue.infra_blocked` while retaining the entry [recoverableDriveHold.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/recoverableDriveHold.ts:99). Batch-wide writer escalation is reached when a drive/check is thrown or classified as infrastructure: the current land-throw arm passes the entire batch to `infraHold` [batchCoordinator.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchCoordinator.ts:436), and sustained non-recovery then routes every member to writer rework [batchInfraEscalate.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchInfraEscalate.ts:45).

Thus the reported v96 sequence proves its deployed path reclassified or threw the refusal before reaching the ceiling; correlating that trace with the deployed SHA remains necessary. Both current and deployed paths have the same root defect: no member-attributed authority verdict, stop-on-first-blocker, and no return to subset isolation.

The flaky path has a second correctness gap:

- Ordinary gates load active quarantine, export the exact-test filter, and pass quarantine names [plannerRunGate.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/plannerRunGate.ts:266).
- Batch gates do neither and do not ingest JUnit evidence [batchNodeGate.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchNodeGate.ts:113).
- Batch proof reuse aliases `quarantineVersion` to the unrelated policy version [batchChecker.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchChecker.ts:207), even though quarantine is a distinct proof-key component [integrationProofReuse.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/dag/integrationProofReuse.ts:115).
- A per-test quarantine also contributes its suite to `checkNames` [ciQuarantine.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/ciQuarantine.ts:65). If the repository does not honor the exact-test environment filter, this can waive the owning step rather than only the flaky test.

So batch-only flakes can poison bisection, while quarantine changes can leave stale passing proofs reusable.

### Target architecture: the Proof-Carrying Integration Graph

```text
Forge behaviors + DesignContract + spec DAG
                   │
                   ▼
       DagWalker/EAGER candidate prediction
                   │
                   ▼
        jj IntegrationNode materialization
                   │
                   ▼
 native gate + BDD + audit + policy proof atoms
                   │
                   ▼
        MergeAuthority node evaluation
        ┌──────────┼───────────┬─────────────┐
        │          │           │             │
 authorized   member fail  interaction fail  flake/infra
        │          │           │             │
        │       isolate     subset search   quarantine/release
        │          └──────┬────┘             │
        ▼                 ▼                  │
 exact safe-subset CAS   fixer → other-agent re-spec
        │
 deploy → verify → behavior demo → rollback/repair if needed
```

The defining invariants are:

- **Safety:** only an exact tree, base SHA, proof root, policy revision, DesignContract revision, behavior manifest, runner image, environment hash, and quarantine epoch authorized by `MergeAuthority` can land.
- **Liveness:** a retrying member holds no project-wide or partition-wide merge lease. It blocks only its transitive dependents and its proven minimal interaction set.
- **No unproven blame:** transient infrastructure and flakes never become member-failure constraints.
- **Maximal progress:** if any dependency-closed subset is authorized, that subset eventually lands.
- **No bypass:** the scheduler proposes subsets; only `MergeAuthority` decides. Even emergency operation is a signed policy revision evaluated by the authority, never a direct merge endpoint.
- **Only non-convergence escape hatch:** a fixed-point member is removed from active integration and routed, with its complete evidence packet, to a different Answerer/Writer route for re-specification or spec splitting. Policy and tests are not weakened.

### Core components

1. **`IntegrationGraphScheduler`: DagWalker for integration work.**  
   Keep the existing idiom that a scheduler wraps an existing executor [dagWalker.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/dagWalker.ts:1). It loads fresh Postgres state, calculates ready dependency-closed candidates, and schedules nodes by priority, age, deadline, scope capacity, and proof value. Like the current walker’s per-spec tolerance, one poisoned member cannot abort the scheduling tick [walker.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/dag/walker.ts:175).

2. **Semantic partitions, not merely path partitions.**  
   Compute lanes from roadmap-owned paths, changed files, service/package ownership, migrations, APIs, behaviors, DesignContract dimensions, shared resources, and spec dependencies. A DB migration, shared contract, nav file, or `all_scopes` declaration becomes a barrier. Disjoint lanes run concurrently, but every winner is re-authorized against the latest base before CAS.

3. **EAGER speculative beam search.**  
   The existing DagWalker already starts dependents before ancestors merge under governed thresholds [speculation.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/dag/speculation.ts:51). Extend this to construct the top-K likely integration frontiers as soon as writer heads exist—not merely when every PR is ready. A review, priority jump, or new head rebases those nodes in place and invalidates only dependent proof atoms.

4. **`IntegrationNodeMaterializer` behind `WorkspaceVcsCore`.**  
   Add arbitrary-subset materialization, operation identity, in-place base shift, and clean land-group export to the jj-only core. jj already makes a conflicting rebase a recorded, non-discarding success and refuses to export unresolved state [workspaceVcsCore.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/workspaceVcsCore.ts:54). Every adapter gets fake/live conformance tests; there is no Git fallback.

5. **Granular Merkle proof graph.**  
   Evolve whole-node `integration_proofs` into proof units for tier, step, test, behavior, audit rule, design-oracle dimension, security finding, and artifact. Each unit hashes its actual input slice plus toolchain lock, `.tanren/ci.yml`, runner image, app environment, policy version, DesignContract version, behavior manifest, and quarantine epoch. Existing exact six-component reuse is a sound foundation [integrationNodes.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/integrationNodes.ts:103), but the unit graph allows neighboring subsets to reuse unaffected work.

   A passing test on a larger subset is not automatically reusable on a smaller subset. Reuse occurs only when that test unit’s declared input-dependency hash is identical.

6. **`MergeAuthorityV2` evaluates the exact multi-member node.**  
   It returns typed results:
   - `authorized_subset`
   - `member_failure`
   - `interaction_failure`
   - `flake_observation`
   - `transient_infrastructure`
   - `needs_product_decision`
   - `unknown_fail_closed`

   Every reason carries `reasonCode`, `signalKind`, `signalVersion`, `scope`, `memberIds`, `behaviorIds`, `findingIds`, `retryability`, `wakeKey`, and `disposition`. The authority evaluates fresh member-local findings before expensive batch work, then evaluates integrated-tree signals. A P1 on member C therefore removes C before or during evaluation and never becomes “infrastructure.”

7. **Generalized safe-subset solver.**  
   The present prefix binary search assumes one monotone culprit [batchMergeCoordinator.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/batchMergeCoordinator.ts:147). Replace it with:
   - direct attribution for member-local findings;
   - parallel individual preflight;
   - k-way split followed by `ddmin`/QuickXPlain-style interaction isolation;
   - multiple minimal failure-set discovery;
   - a maximum-weight, dependency-closed safe-subset calculation;
   - exact re-evaluation of the proposed winner by `MergeAuthority`.

   Conceptually, for candidates \(S\), choose the highest-weight \(U \subseteq S\) such that \(U\) is downward-closed over the spec DAG and `MergeAuthority(U)` is authorized. The system reasons over the combinatorial subset lattice without blindly executing all \(2^n\) combinations: proof reuse, member attribution, scopes, and learned failure constraints prune it.

8. **Flakes are a signal class, never a culprit.**  
   Preserve the existing same-tree pass/fail and intra-run recovery basis [ciFlakyTests.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/insights/ciFlakyTests.ts:70), then strengthen it:
   - repeat the exact immutable node/environment;
   - maintain confidence, model version, expiry, owner, and repair spec;
   - parse complete JUnit evidence and exclude only exact quarantined test IDs;
   - never waive an entire step for a per-test quarantine;
   - continue running quarantined tests in a shadow lane for recovery evidence;
   - automatically probe and dequarantine after sustained deterministic success;
   - increment a real quarantine epoch that invalidates proofs;
   - do not add flaky outcomes to the subset solver’s failure constraints.

   If a stack lacks a complete report or safe exact selector, Tanren runs the full gate and fails closed; it does not pretend quarantine is safe.

9. **Autonomous repair and re-specification.**  
   A deterministic content failure routes only the implicated member or minimal interaction clique to the Writer with the exact counterexample, behavior IDs, proof delta, and conflicting intents. Repeated signatures that prove a fixed point route to a different agent/model as a `RespecPacketV1`; the agent may revise acceptance criteria clarity, split the spec, or revise DAG dependencies, but cannot waive policy.

10. **Exact safe-subset landing.**  
    Prefer one `CodeHost.landAuthorizedIntegration` CAS of the exact jj tree authorized by MergeAuthority, followed by atomic reconciliation of every member PR/run/spec. If a host cannot represent that cleanly, authorize every exact prefix and defer deploy/demo until the land group completes. The current post-host `merge_state_unknown` reconciliation discipline remains necessary [mergeAuthority.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/mergeAuthority.ts:216).

11. **Deploy, verify, demo, rollback.**  
    The existing subscriber already sequences deploy and demo after merge [subscriber.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/subscriber.ts:145), and the demo engine records per-behavior evidence [demoEngine.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/demo/demoEngine.ts:105). Extend `DeployAdapter` with preview, canary, promote, rollback, and teardown—the contract explicitly identifies these as deferred today [deployAdapter.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/deployAdapter.ts:20). A live regression rolls deployment back to the last verified artifact, creates a repair/revert spec, and uses preview replay plus the same subset solver to identify the causal members. Main is never force-pushed; a source revert is another authority-gated land.

### Fragment/F2 fit

`.tanren/ci.yml` remains the sole executable gate contract, as required by the brief [PROJECT_BRIEF.md](/home/trevor/projects/tanren/PROJECT_BRIEF.md:145) and implemented by `CiConfigV1` [schema.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/ci/schema.ts:192). Queue policy cannot define shell commands or delegate to GitHub Actions.

Extend runtime/addon `FragmentContract` with declarative test-evidence, affected-test, and behavior-manifest capabilities. The base fragment already emits `.tanren/ci.yml` and BDD scaffolding, and composition fills its evidence contract [compose.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/compose.ts:9). When the selected stack cannot provide a required adapter, `selectFragmentConfig` must report the corresponding missing fragment, and the existing F2 flow authors and validates one fragment per missing ID [fragmentAuthoringRun.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/fragmentAuthoringRun.ts:1). If F2 cannot converge, it fails loudly; full-gate execution remains the safe fallback.

## (2) COMPARATOR PARITY MATRIX

I used the current official Mergify surfaces across [queue configuration](https://docs.mergify.com/configuration/file-format/), [modes](https://docs.mergify.com/merge-queue/queue-modes/), [rules](https://docs.mergify.com/merge-queue/rules/), [batches](https://docs.mergify.com/merge-queue/batches/), [scopes](https://docs.mergify.com/merge-queue/scopes/), [priority](https://docs.mergify.com/merge-queue/priority/), [lifecycle](https://docs.mergify.com/merge-queue/lifecycle/), [monitoring](https://docs.mergify.com/merge-queue/monitoring/), [CI Insights](https://docs.mergify.com/ci-insights/), [Test Insights](https://docs.mergify.com/test-insights/), [merge protections](https://docs.mergify.com/merge-protections/), and the [Merge Queue API](https://docs.mergify.com/api/merge-queue/). For GitHub, the baseline is [Managing a merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), the [`merge_group` event](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#merge_group), and the [GraphQL pull-request API](https://docs.github.com/en/graphql/reference/pulls).

Current terminology matters: Mergify `partition_rules`, `speculative_checks`, `autoqueue`, `requeue`, `allow_inplace_checks`, and `disallow_checks_interruption_from_queues` are deprecated, removed, or replaced. The table matches both the seed’s intended behavior and the current equivalent.

| Comparator capability                               | How Tanren matches it                                                                                                                               | How Tanren exceeds it                                                                                                                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Availability and enablement                         | Org/project policy enables a queue per target branch through adapters for supported code hosts.                                                     | Queue semantics are host-neutral and work in OSS or managed Tanren; GitHub branch-pattern and Enterprise-plan restrictions do not define the engine.                                       |
| Ordered queues, FIFO, named queue rules             | `QueuePolicyV1` supplies named routes; deterministic order is priority, enqueue sequence, then spec ID.                                             | Ordering is constrained by the real spec DAG and fairness/aging, while liveness is independent of queue-head health.                                                                       |
| Admission and auto-merge                            | Admission rules automatically queue approved/eligible runs; manual enqueue remains available.                                                       | Tanren knows writer, checker, auditor, behavior, design, budget, and review state directly rather than reconstructing them from labels/statuses.                                           |
| `queue_conditions` and `merge_conditions`           | Versioned admission and land conditions support nested boolean rules over branches, labels, paths, authors, reviews, schedules, scopes, and checks. | Land rules are compiled into typed MergeAuthority signals including authored BDD, DesignContract, audit posture, cost, conflict, and provenance.                                           |
| Branch/ruleset injection                            | Imported host protection intent can be enforced at admission, final authority, or both.                                                             | Native policy is authoritative and complete; host rules are compatibility/display inputs, so unsupported host rule types cannot silently disappear.                                        |
| FIFO, priority aliases, numeric priority, fast lane | Low/medium/high and numeric priorities, plus policy-derived urgent lanes.                                                                           | Aging, deadlines, incident priority, dependency criticality, behavior risk, and proof-reuse value can be combined without violating explicit policy.                                       |
| Priority boost / jump the queue                     | Authorized boost and jump commands reorder candidates.                                                                                              | jj base-shifts nodes in place and only dependent proof units invalidate; GitHub warns its jump rebuilds every in-progress group.                                                           |
| Check interruption policy                           | Each priority rule declares whether lower-priority speculative nodes are interruptible.                                                             | Running proof units that remain useful finish and enter the cache; cancellation is unit-aware, not whole-build destruction.                                                                |
| Serial speculative checks                           | Build cumulative integration nodes concurrently up to a governed capacity.                                                                          | Nodes can begin during Writer/Checker/Auditor execution, before queue readiness, using DagWalker lifecycle thresholds.                                                                     |
| Configurable speculative count                      | Global, per-project, per-partition, per-scope, and per-provider capacities.                                                                         | Capacity is dynamically budgeted from runner availability, rate limits, historical proof reuse, queue SLA, and dollar/token budgets.                                                       |
| Serial, parallel, and isolated modes                | `serial`, `scoped`, and `isolated` scheduling modes.                                                                                                | “Isolated” never weakens safety: independent candidates still receive a final combined proof or a sound semantic-disjointness proof before land.                                           |
| Partition queues / modern Mergify scopes            | File patterns, manual scopes, Nx/Bazel/Turborepo adapters, scope capacities, and all-scope barriers.                                                | Forge-owned paths, spec dependencies, behaviors, DB entities, APIs, migrations, and DesignContract dimensions provide semantic partitions, not path guesses.                               |
| Trusted checks for unaffected scopes                | Reuse passing proof units when intervening changes do not affect their declared inputs.                                                             | Reuse is cryptographically keyed per test/behavior/artifact and composed into a signed gate root; uncertainty forces recomputation.                                                        |
| Fixed and dynamic batches                           | Fixed or `{min,max}` size, maximum wait, launch-on-full, and load-adaptive sizing.                                                                  | Size is optimized against interaction risk, proof-cache coverage, deployment blast radius, queue age, and expected isolation cost.                                                         |
| Scope/path affinity batching                        | Preserve priority, keep stacks together, then group by semantic affinity.                                                                           | Affinity uses the spec/DAG/behavior graph and historical interaction failures, not only paths and directories.                                                                             |
| Batch one CI run for N PRs                          | One native gate over one jj-composed node.                                                                                                          | Expensive steps are decomposed into reusable proof units; nearby subset probes rerun only units whose inputs actually changed.                                                             |
| GitHub min/max merge group and wait                 | Minimum/maximum landing group and wait-time policy.                                                                                                 | Tanren batches both proof execution and landing; GitHub explicitly applies merge limits only after separate merge-group builds.                                                            |
| Required checks on merge groups                     | Native `pre_merge` tiers run on the exact group tree and publish `tanren/gate` for forge visibility.                                                | The forge check is an output, not the authority. No external workflow can report green for a tree Tanren did not execute.                                                                  |
| Two-step CI                                         | Cheap admission tiers and expensive `pre_merge` tiers map directly to `CiConfigV1.when`.                                                            | EAGER proof starts expensive work as soon as inputs stabilize and shares it across later integration nodes.                                                                                |
| Cascading queues/stacks                             | Stacked specs land dependency-first and failures hold only descendants; staged policies can require admission → integration → canary → production.  | The stages are one proof DAG with preserved evidence, rather than separate queues losing causal context.                                                                                   |
| Auto-update / merge or rebase                       | Candidate nodes update against current main according to policy.                                                                                    | jj records conflicts without discarding work, propagates resolutions down descendants, and avoids merge-commit churn.                                                                      |
| External base merge reset                           | External main movement invalidates affected nodes and reschedules.                                                                                  | Exact proof dependencies determine what survives; it does not blindly reset the entire train.                                                                                              |
| Pause                                               | Manual/API/conditional pause retains membership and order.                                                                                          | Separate controls can stop new proof, drain in-flight work, or stop only landing; proof may continue during an incident when safe.                                                         |
| Freeze                                              | Manual and conditional freeze prevents landing while preserving speculative work.                                                                   | Freeze can target org/project/branch/partition/behavior/deployment risk, with signed exceptions still judged by MergeAuthority.                                                            |
| Scheduled/time-window merges                        | Time zones, recurring windows, blackout periods, `merge-after`, and hotfix exceptions.                                                              | Scheduling can incorporate deploy health and demo readiness, and speculative proof continues before the window opens.                                                                      |
| Check timeout                                       | Adaptive p95-based SLA and explicit operator deadlines.                                                                                             | Time alone never blames a member. Progress signatures distinguish a slow, advancing job from fixed-point infrastructure; the node releases its lease either way.                           |
| Check retry                                         | Configurable retry and alternate-runner retry policies.                                                                                             | Same-tree outcomes feed the flake classifier; retries can change runner/provider while retaining exact environment provenance.                                                             |
| Disband/requeue after failure                       | Failed groups disband; eligible survivors retain order and are reformed.                                                                            | Survivors keep proof units and may land immediately; only implicated members or cliques are retried.                                                                                       |
| Batch split/bisection                               | Recursive parallel splitting with a governed search budget and visible tree.                                                                        | Isolation triggers on any authority signal and finds multiple/non-monotone interaction sets plus the maximal safe DAG-closed subset.                                                       |
| Failure-resolution attempt limit                    | Policy governs compute/search budget.                                                                                                               | Hitting a budget does not eject or block siblings; the unresolved member is isolated and routed to another agent for re-specification.                                                     |
| Failed-batch ancestry/selective rerun               | Every probe records parent evaluations and failing proof units.                                                                                     | Tanren owns execution, so reuse is automatic and sound; no user workflow must download an artifact and hope test independence holds.                                                       |
| In-place checks / `allow_inplace_checks`            | Automatically use the original head only when batch size and two-stage semantics make it exact.                                                     | The same authority/proof model applies in-place, on a batch, or on an eager node; there are no divergent correctness paths.                                                                |
| `skip_intermediate_results` / GitHub `HEADGREEN`    | A later exact passing composition may supersede an earlier flaky observation under policy.                                                          | Tanren does not use “later green” as a flake heuristic. It proves nondeterminism on the same immutable inputs and quarantines the exact test.                                              |
| CI job auto-retry and log matching                  | Retry rules cover step identity, outcome, annotations, logs, and known-flaky state.                                                                 | Native structured step/test evidence removes most log regexes; agent triage receives the typed result and workspace provenance.                                                            |
| Flaky job/test detection                            | Same-tree pass/fail and retry-recovery history, rates, confidence, and duration distributions.                                                      | Detection occurs inside every branch, batch, bisection, preview, and post-merge run—not only CI systems integrated with a point tool.                                                      |
| Test prevention, mitigation, quarantine             | New/modified-test stress runs, manual/automatic quarantine, dequarantine, event history.                                                            | Exact-test logical verdicts, shadow execution, expiry, owner repair spec, monotonic quarantine epochs, and automatic recovery probing prevent bisection poisoning.                         |
| Merge/squash/rebase/fast-forward/merge-batch        | All history shapes supported through jj transformation plus the `CodeHost` adapter.                                                                 | MergeAuthority binds the chosen history shape to the exact tested tree; batch land can preserve a single deployment trigger without temporary-host-branch churn.                           |
| Commit-message formats/templates                    | Versioned title/body/trailer formatting, including co-author/approver/authority provenance.                                                         | The land manifest carries machine-verifiable spec, behavior, proof, DesignContract, cost, and agent lineage independent of human commit text.                                              |
| Bot accounts, queue-branch editing                  | Adapter-configured credentials; branch edits invalidate exact proofs; optional controlled editability.                                              | Credentials are org-managed, never host-discovered, and every mutation is attributable. Ephemeral queue branches can remain runner-local.                                                  |
| Labels, status comments, cleanup                    | Queue/dequeue labels, concise/all/outcome comments, and ephemeral-ref cleanup.                                                                      | Comments link to live proof/subset/respec artifacts and are projections of internal truth, never orchestration state.                                                                      |
| `Depends-On`, stacks, cascading dequeue             | Intra- and cross-project dependencies are first-class DAG edges; stacks land bottom-up.                                                             | Cycles fail validation instead of being ignored; same-org cross-repo trains can coordinate deploy compatibility and hold only true dependents.                                             |
| Comment commands                                    | `@tanren queue`, `dequeue`, `refresh`, `boost`, `requeue`, and `respec`, with status controls and permission checks.                                | Commands append audited intent and wake the engine; none can invoke land directly.                                                                                                         |
| Merge protections                                   | Reviews, CODEOWNERS intent, conversations, signatures, security, deployments, schedules, and custom policies.                                       | One MergeAuthority interprets all signals, including combined-tree code scanning and authored behaviors; GitHub’s code-scanning merge protection does not itself re-evaluate merge groups. |
| Admin bypass / break glass                          | Signed emergency policy revision with actor, reason, scope, and expiry.                                                                             | Authority remains the sole decision and the native gate cannot be bypassed accidentally; every exception is replayable and visible.                                                        |
| Dashboard/train visualization                       | Ordered entries, live groups, states, ETA, scopes, priorities, and blockers.                                                                        | Adds speculative beams, dependency lanes, proof reuse, subset-search tree, causal failure sets, behavior matrix, agent remediation, deployment, and demo lineage.                          |
| Queue API and dequeue-impact preview                | Live state, positions, groups, nested probes, estimates, grouping reasons, pause/freeze, and projected dequeue cascade.                             | Simulation replays the actual scheduler/authority against immutable historical snapshots before mutation.                                                                                  |
| Metrics and event logs                              | Queue length/time, idle time, CI duration, batch size, retries, bisections, exit reasons, and command/freeze/quarantine events.                     | Adds safe-subset yield, proof-reuse savings, behavior failure rate, false-blame rate, respec convergence, avoided head-of-line delay, deploy rollback, and cost per landed behavior.       |
| Config validation, simulation, sharing              | Schema validation, dry-run simulation, reusable org policy, and import/export.                                                                      | `QueuePolicyV1` is signed, immutable, diffable, historically replayable, and validated against actual CiConfig/fragment/adapter capabilities.                                              |
| GitHub `merge_group` protocol                       | Internally model the same exact base-plus-members identity and publish host checks where required.                                                  | No Actions trigger or `gh-readonly-queue` branch is needed; Tanren already owns the runner, gate, tree, and evidence.                                                                      |
| GitHub failure removal/rebuild                      | Remove a failed entry and rebuild downstream compositions.                                                                                          | jj base-shifts survivors without discarding them, reuses proof units, and isolates arbitrary interaction sets rather than only linear prefixes.                                            |
| GitHub solo merge/deploy isolation                  | Per-entry `solo`/exclusive-deploy policy and all-scope barrier.                                                                                     | Exclusivity derives from deployment/resource risk and can still pre-prove surrounding work without blocking its execution.                                                                 |
| Deploy grouping                                     | One deploy per authorized land group when policy requests it.                                                                                       | Preview/canary, live verification, per-behavior demo, automatic deployment rollback, and repair/respec close the entire delivery loop.                                                     |

## (3) DATA MODEL

The present schema has a minimal `merge_queue`, JSON node members, whole-node proofs, and a quarantine table lacking direct `org_id` [0000_collapsed_baseline.sql](/home/trevor/projects/tanren/db/migrations/0000_collapsed_baseline.sql:234). The ideal schema normalizes identity and makes every decision replayable.

| Entity                                                      | Critical columns                                                                                                                                                                                                               | Purpose                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `merge_queue_policies`                                      | `policy_id`, `org_id`, `project_id`, `target_branch`, `version`, `schema_version`, `body`, `compiled_hash`, `state`, `supersedes_id`                                                                                           | Immutable `QueuePolicyV1` revisions and compiled rule artifact.                                                          |
| `merge_queue_partitions`                                    | `partition_id`, `org_id`, `project_id`, `target_branch`, `scope_key`, `mode`, `capacity`, `state`, `generation`, `pause_reason`                                                                                                | Independent scheduling/lease boundary; project main is still CAS-serialized briefly.                                     |
| Existing `merge_queue`                                      | add `partition_id`, `enqueue_seq`, `priority`, `priority_rule`, `state`, `head_sha`, `scope_fingerprint`, `dependency_hash`, `next_eligible_at`, `progress_signature`, `respec_generation`, `current_node_id`, `superseded_by` | Member lifecycle: queued, proving, certified, landing, isolated, fixing, respecing, dependency-held, landed, superseded. |
| `merge_queue_entry_dependencies`                            | `org_id`, `entry_id`, `depends_on_spec_id/project_id`, `kind`, `snapshot_version`                                                                                                                                              | Snapshot of intra/cross-project prerequisites and deployment dependencies.                                               |
| Existing `integration_nodes`                                | add `evaluation_generation`, `proof_root`, `design_contract_version`, `behavior_manifest_hash`, `quarantine_epoch`, `toolchain_hash`                                                                                           | Immutable materialized integration identity.                                                                             |
| `integration_node_members`                                  | `org_id`, `project_id`, `node_id`, `ordinal`, `queue_id`, `spec_id`, `run_id`, `branch`, `head_sha`, `included`                                                                                                                | Normalized member identity; retain existing JSON only during compatibility migration.                                    |
| `integration_evaluations`                                   | `evaluation_id`, `org_id`, `project_id`, `node_id`, `parent_evaluation_id`, `purpose`, `state`, `failure_class`, `started_at`, `completed_at`, `lease_owner`                                                                   | One preflight, batch, subset probe, authority, land, or preview evaluation.                                              |
| `integration_signal_results`                                | `signal_id`, `evaluation_id`, `kind`, `subject_id`, `verdict`, `reason_code`, `signal_version`, `retryability`, `evidence_hash`                                                                                                | Typed native gate, behavior, audit, design, review, conflict, policy, budget, or deployment result.                      |
| `integration_proof_units`                                   | `proof_unit_id`, `org_id`, `project_id`, `kind`, `subject_id`, `input_hash`, `verdict`, `artifact_hash`, `source_node_id`, `quarantine_epoch`, `expires_at`                                                                    | Content-addressed reusable proof atom.                                                                                   |
| `integration_proof_edges` / `integration_evaluation_proofs` | parent/child unit IDs; evaluation/unit bindings                                                                                                                                                                                | Merkle dependency graph and proof-root composition.                                                                      |
| `failure_sets` / `failure_set_members`                      | `failure_set_id`, `evaluation_id`, `signal_id`, `classification`, `minimal`, `member_id`, `confidence`                                                                                                                         | Learned minimal deterministic interaction constraints; flakes/infra are forbidden here.                                  |
| `merge_authority_decisions`                                 | `decision_id`, `node_id`, `proof_root`, `policy_version`, `base_sha`, `authorized_sha`, `decision`, `authorized_member_set_hash`, `expires_at`                                                                                 | The sole durable authorization.                                                                                          |
| `merge_authority_member_decisions`                          | `decision_id`, `queue_id`, `disposition`, `reason_code`, `signal_id`, `wake_key`, `repair_route`                                                                                                                               | Per-member allow/fix/respec/dependency-hold attribution.                                                                 |
| `land_groups` / `land_group_members`                        | `land_group_id`, `decision_id`, `expected_main_sha`, `authorized_sha`, `state`, `main_sha`, `reconcile_token`; member PR/run/spec outcome                                                                                      | External CAS plus atomic internal reconciliation for the safe subset.                                                    |
| `quarantine_epochs`                                         | `org_id`, `project_id`, `epoch`, `set_hash`, `created_at`                                                                                                                                                                      | Real monotonic proof invalidation.                                                                                       |
| Existing `quarantined_tests`                                | add `org_id`, `kind`, `status`, `selector`, `confidence`, `model_version`, `epoch`, `owner_spec_id`, `expires_at`, `probe_due_at`, `last_observed_at`                                                                          | Exact test/check lifecycle with automatic recovery.                                                                      |
| `respec_routes`                                             | `route_id`, `org_id`, `project_id`, `source_spec_id`, `failure_set_id`, `generation`, `prior_agent_route`, `next_agent_route`, `packet_hash`, `replacement_spec_ids`, `state`                                                  | Proves a fixed-point member was routed to a different agent and records split/replacement lineage.                       |
| `merge_queue_commands` / `merge_queue_windows`              | idempotency key, actor, command, payload, result; schedule/time zone/scope/exceptions                                                                                                                                          | Audited operations, freeze, pause, and landing windows.                                                                  |

Suggested migration series following the current `0032`:

1. `0033_merge_queue_policies_partitions.sql`
2. `0034_integration_evaluations_proof_units.sql`
3. `0035_merge_authority_land_groups.sql`
4. `0036_quarantine_epochs_exact_selectors.sql`
5. `0037_respec_routes_queue_commands.sql`
6. `0038_merge_queue_v2_backfill_cutover.sql`

The cutover is dual-write/backfill/read-v2/remove-compatibility—not a flag that permits two authorities.

Every tenant table gets `org_id NOT NULL`, direct deny-by-default RLS, and composite foreign keys carrying `org_id` and `project_id`. Current policy deliberately exposes zero rows when the org GUC is unset [0000_collapsed_baseline.sql](/home/trevor/projects/tanren/db/migrations/0000_collapsed_baseline.sql:924), and tenant work must remain inside short `runWithOrgScope` transactions [orgScope.ts](/home/trevor/projects/tanren/db/src/orgScope.ts:108). Cross-project trains are permitted only within one org; cross-org dependencies are external attestations, never RLS-crossing joins.

All state transitions append typed events through `EventStore` [eventStore.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/eventStore.ts:60). The new tables are operational state and replayable projections; they do not create a second untyped event path.

## (4) ENGINE INTEGRATION

| Stage                       | Integration                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forge interview             | Persist stable persona/behavior IDs, Given/When/Then behavior definitions, DesignContract version, spec DAG, owned paths, and behavior-to-spec obligations. The schema already has stable behaviors and spec links [schema.ts](/home/trevor/projects/tanren/db/src/schema.ts:389), while DesignContracts are versioned and org-scoped [schemaDesign.ts](/home/trevor/projects/tanren/db/src/schemaDesign.ts:1). |
| Fragment composition        | Runtime/addon fragments declare test evidence, exact selectors, affected-unit mapping, and behavior manifests. Missing support invokes F2 authoring and full composition/runtime validation.                                                                                                                                                                                                                    |
| DagWalker                   | In addition to scheduling runs, publish likely candidate frontiers when ancestors cross speculation thresholds. Never execute merge logic inside the walker.                                                                                                                                                                                                                                                    |
| Writer/Checker/Auditor loop | Every new head invalidates only dependent nodes/proof units. Member-local P0/P1 findings prevent admission to larger nodes but do not halt other members.                                                                                                                                                                                                                                                       |
| Queue admission             | Compile `QueuePolicyV1`, assign priority/partition, snapshot dependencies and signals, and enqueue idempotently.                                                                                                                                                                                                                                                                                                |
| EAGER stage                 | Build likely jj nodes and run affected native gate/BDD units before review readiness. Work remains speculative; no land authority exists yet.                                                                                                                                                                                                                                                                   |
| Batch formation             | Select a weighted, dependency-closed set using priority, age, semantic scope, stack cohesion, proof coverage, interaction history, and batch/deploy limits.                                                                                                                                                                                                                                                     |
| Native gate                 | Run `.tanren/ci.yml` `pre_merge` over SSH on the exact node. Harvest complete step/JUnit/artifact evidence. No Actions, external required-check poll, or alternate gate.                                                                                                                                                                                                                                        |
| Flake control               | Classify same-node nondeterminism before writing failure constraints. Apply exact quarantine, mint a new epoch, and re-evaluate nonquarantined failures.                                                                                                                                                                                                                                                        |
| MergeAuthority              | Read fresh gate, behavior, design-oracle, audit, review, policy, budget, conflict, and mergeability signals for the exact node. Return per-member dispositions and authorize only an exact safe subset.                                                                                                                                                                                                         |
| Subset search               | Directly remove attributed member failures; run proof-reusing generalized search only for unattributed interactions. Release every node lease between probes.                                                                                                                                                                                                                                                   |
| Fix/respec                  | Deterministic failures route to Writer. Fixed-point signatures route the isolated member to another agent for re-spec/split. Its descendants remain held; unrelated partitions keep advancing.                                                                                                                                                                                                                  |
| Merge queue land            | Materialize the authorized subset, revalidate freshness, perform one CAS, and transactionally reconcile every member. No loop of independently authorized single-member lands after a different batch proof.                                                                                                                                                                                                    |
| Percolation                 | jj shifts surviving/eager descendants to the new base and retains unaffected proof units.                                                                                                                                                                                                                                                                                                                       |
| Post-merge hook             | Existing LISTEN/NOTIFY post-merge subscriber triggers deploy, verify, and per-behavior demo. Failure rolls deployment back, opens an attributed repair/revert spec, and optionally replays candidate subsets in preview.                                                                                                                                                                                        |
| Metrics/insights            | Events feed live queue state and historical metrics; CI insights automatically generate flake/root-cause specs without becoming a separate delivery engine.                                                                                                                                                                                                                                                     |

The project-wide `mergingInFlight` boolean should disappear. Claims and retries are keyed by integration node/partition; only the final main CAS is serialized. Postgres remains the queue substrate, consistent with the brief’s `SKIP LOCKED` plus `LISTEN/NOTIFY` model [PROJECT_BRIEF.md](/home/trevor/projects/tanren/PROJECT_BRIEF.md:804).

## (5) HTTP SURFACE

All routes use org membership plus project authorization, execute under RLS, support request IDs, and use `Idempotency-Key` for mutations.

Read surfaces:

- `GET /orgs/:orgId/projects/:projectId/merge-queue`
  - Live policy, partitions, ordered entries, active nodes, pause/freeze state, capacities, ETA, and current land frontier.
- `GET /orgs/:orgId/projects/:projectId/merge-queue/entries/:queueId`
  - Entry history, dependencies, priority, proof coverage, remediation, and respec lineage.
- `GET /orgs/:orgId/projects/:projectId/merge-queue/groups/:groupId`
  - Members, tree/base identity, parent/child evaluations, signal results, and safe-subset decision.
- `GET /orgs/:orgId/projects/:projectId/merge-queue/evaluations/:evaluationId`
  - Probe result, failure sets, reused/recomputed units, runner provenance, and cost.
- `GET /orgs/:orgId/projects/:projectId/merge-queue/proofs/:proofRoot`
  - Signed proof bundle; `format=json|in-toto|sarif|junit`.
- `GET /orgs/:orgId/projects/:projectId/merge-queue/metrics?windowDays=30`
  - Existing queue statistics plus liveness, proof, behavior, flake, respec, deploy, and cost metrics.
- `GET /orgs/:orgId/projects/:projectId/merge-queue/events`
  - Server-sent event stream.
- `GET /orgs/:orgId/projects/:projectId/quarantines`
  - Active/probing/expired quarantine, confidence, owner, history, and affected proof epoch.
- `GET /orgs/:orgId/projects/:projectId/merge-queue/policy`
  - Current compiled policy and ETag.

Mutation and simulation surfaces:

- `POST /.../merge-queue/entries`
  - Queue an existing Tanren run/PR.
- `POST /.../merge-queue/entries/:queueId/commands`
  - `queue`, `requeue`, `dequeue`, `refresh`, `boost`, `clear_boost`, `request_respec`.
- `POST /.../merge-queue/controls`
  - `pause`, `resume`, `freeze`, `unfreeze`, `drain`, scoped to queue/partition/branch.
- `GET|POST|DELETE /.../merge-queue/windows`
  - Scheduled landing windows and blackout exceptions.
- `PUT /.../merge-queue/policy`
  - Requires `If-Match`; creates an immutable next version.
- `POST /.../merge-queue/policy/validate`
  - Schema, fragment capability, CiConfig, dependency-cycle, and adapter validation.
- `POST /.../merge-queue/simulations`
  - Replay proposed policy/priority/dequeue/freeze changes against a snapshot or historical event range.
- `POST /.../quarantines/:id/commands`
  - `probe`, `clear`, `extend`, `assign_repair_spec`; never “ignore all suite failures.”
- `POST /.../merge-queue/entries/:queueId/dequeue-impact`
  - Dry-run dependency, proof, and speculative-work impact.
- Code-host webhook command translation:
  - authenticated `@tanren queue|dequeue|refresh|boost|respec` becomes the same idempotent command record.

There is deliberately **no `/land`, `/merge-now`, or `/bypass-authority` endpoint**.

## (6) UI/DASHBOARD SURFACE

The existing screen is aggregate-only and explicitly “reported, not targeted” [MergeQueueBody.tsx](/home/trevor/projects/tanren/services/dashboard/src/components/mergeQueue/MergeQueueBody.tsx:1). The ideal dashboard becomes both live operational surface and proof explorer.

The operator sees:

- **Live integration train:** target branch, semantic partitions, dependency edges, active groups, EAGER nodes, queue order, priority, ETA, capacity, freeze/pause, and land frontier.
- **Member states:** queued, proving, certified, isolated, fixing, re-specifying, dependency-held, landing, landed.
- **Safe-subset view:** original group, deterministic failures, flake observations, each probe, minimal failure sets, maximal safe subset, and why each excluded member cannot ride.
- **Proof-reuse view:** proof-unit DAG, cache hits/misses, invalidation cause, tests/behaviors skipped soundly, runner minutes/tokens/dollars saved.
- **Behavior matrix:** each Forge behavior versus each member/node, pre-merge test proof, preview evidence, live demo evidence, and DesignContract fidelity.
- **Flake center:** same-tree observations, confidence, exact selector, quarantine epoch, repair owner, expiry, shadow results, and automatic dequarantine progress.
- **Remediation lineage:** failure packet, Writer attempts, progress signatures, fixed-point detection, next agent route, revised/split specs, and dependents.
- **Operations:** boost, refresh, dequeue-impact preview, pause, drain, freeze, schedule, quarantine probe, and policy diff/simulation.
- **Metrics:** p50/p95 queue time, safe-subset yield, avoidable head-of-line time, proof reuse, affected/full gate ratio, bisection cost, flakes prevented from poisoning search, repair/respec convergence, deploy rollback, landed behaviors per dollar.
- **Post-merge:** land group → Fly deployment → verification → per-behavior demo → rollback/repair status.

Exportable/validatable artifacts:

- `QueuePolicyV1.yaml`
- `IntegrationManifestV1.json`
- `ProofBundleV1`/in-toto attestation
- `AuthorityDecisionV1.json`
- `FailureSetV1.json`
- `LandManifestV1.json`
- `RespecPacketV1.json`
- JUnit, SARIF, behavior evidence, and policy simulation report

Every artifact carries schema version, org/project, immutable hashes, policy/design/quarantine revisions, and event IDs.

## (7) Runtime-behavior provability

> The general pipeline emits and asserts the following for **every behavior-gated run**;
> an apex-class fixture merely exercises them all at once. See
> [`apex.md`](../../operator-guide/apex.md) for the binding doctrine.

One example fixture exercise is the exact six-member v96 regression:

1. A six-member group forms and its native gate passes.
2. Member C has an unfixable P1 audit finding.
3. MergeAuthority identifies C as a member-local deterministic policy failure.
4. C and only C leave the active embark; C’s dependents become dependency-held.
5. The other five form a dependency-closed safe subset.
6. MergeAuthority authorizes their exact node/proof root.
7. The five land in the same coordination cycle.
8. Only C routes to another agent for re-specification.
9. Deployment verifies and demos run for the landed members.
10. A later independent group progresses while C is still re-specifying.

Required event chain:

| Event                                                   | Live proof                                                            |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `merge.group.formed`                                    | Group ID, six ordered members, base SHA, partition, policy version.   |
| `integration.node.materialized`                         | Exact jj tree/member key/head SHA.                                    |
| `integration.proof.unit.reused` / `.recorded`           | Native gate/BDD units and their input hashes.                         |
| `integration.evaluation.completed`                      | Gate passed, member-local authority signal failed for C.              |
| `merge.member.isolated`                                 | C, reason `audit_policy`, finding IDs, no infra classification.       |
| `merge.subset.search.started` / `.probed` / `.resolved` | Search lineage and maximal dependency-closed safe set.                |
| `merge.authority.subset_authorized`                     | Exact member-set hash, proof root, base SHA, authorized SHA.          |
| `merge.land_group.completed`                            | CAS before/after SHA and the five reconciled PR/run/spec members.     |
| `merge.member.respec_routed`                            | C’s packet hash, previous and different next agent route, generation. |
| `deploy.triggered` / `deploy.verified`                  | Land-group SHA is live.                                               |
| `demo.evidence.recorded` / `demo.completed`             | Per-behavior evidence on the verified surface.                        |

Negative assertions are equally important:

- No `merge.queue.infra_blocked` or `merge.batch.infra_blocked` for C’s P1.
- No Writer/re-spec route for the five safe members.
- No repeated group with the same six-member set.
- No proof or authorization whose tree differs from the landed SHA.
- No quarantined test causes a `failure_set` row.
- No queue/partition lease remains held by C while another authorized subset exists.

A second fixture exercise injects a test that toggles on the identical node:

1. `ci.flaky.detected`
2. `ci.flake.confirmed`
3. `ci.quarantine.applied` with exact test ID
4. new `quarantine_epoch`
5. prior proof invalidated
6. nonquarantined failures re-evaluated
7. subset search proceeds without blaming a member for that flake
8. shadow runs eventually emit `ci.quarantine.cleared`

The current `merge.batch.passed` payload lacks an evaluation ID, proof root, policy version, quarantine epoch, or authority result, so it cannot prove this chain by itself. The new events must correlate `groupId → nodeId → evaluationId → proofRoot → decisionId → landGroupId`.

## (8) EFFORT + PHASING

The brief prohibits calendar estimates in roadmap work [PROJECT_BRIEF.md](/home/trevor/projects/tanren/PROJECT_BRIEF.md:1312), so size is expressed as PR-sized specs, migrations, and approximate implementation surface.

| Phase                              | Deliverable                                                                                                                                                                               | Rough size                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 0. Regression lock and type repair | Exact v96 test; typed authority reasons; distinguish deterministic policy, transient infra, and human input; forbid whole-batch escalation from one member.                               | 4–6 specs, 1 migration, roughly 4–7k code/test LOC.         |
| 1. Never-blocking production MVP   | Multi-member authority evaluation, member isolation, dependency-closed safe subset, partition-scoped leases, exact subset authorization, atomic land-group reconciliation, live basic UI. | Additional 10–14 specs, 2–3 migrations, roughly 12–20k LOC. |
| 2. Robust generalized isolation    | Multiple/nonmonotone failure sets, parallel `ddmin`, maximal-safe solver, proof ancestry, dynamic batches, failure-search simulator.                                                      | Additional 7–10 specs, 1–2 migrations, roughly 10–16k LOC.  |
| 3. Proof graph and flake immunity  | Per-unit proof reuse, exact JUnit logical verdict, quarantine epochs, shadow probes, test prevention, F2 stack adapters.                                                                  | Additional 8–12 specs, 1–2 migrations, roughly 14–22k LOC.  |
| 4. Full comparator operations      | All queue modes, semantic scopes/capacities/barriers, priorities, pause/freeze/windows, comments/CLI/API, nested train UI, metrics, policy simulation/import/export.                      | Additional 8–12 specs, 1–2 migrations, roughly 14–22k LOC.  |
| 5. Owned-stack runtime behavior    | EAGER frontier prediction, agent repair/respec/split, cross-project trains, preview/canary, rollback, post-deploy causal replay, signed attestations.                                     | Additional 10–16 specs, 2–3 migrations, roughly 18–30k LOC. |

A credible production MVP is therefore roughly **14–20 PR-sized roadmap specs**. The unlimited ideal is roughly **45–65 specs**, **8–12 migrations**, and **60–95k LOC including conformance, regression, integration, UI, and apex tests**. It is a major subsystem, not a batch-coordinator patch.

Dependencies on sibling capability buckets:

- Forge stable behavior IDs, DesignContract revisions, spec ownership, and DAG mutation.
- Writer/Fixer routing plus a distinct Answerer-driven `RespecRouter`.
- jj arbitrary-subset materialization, clean group export, base-shift, and operation-log conformance.
- Native runner affected-test execution, complete JUnit/artifact evidence, cancellation, and alternate-runner retry.
- MergeAuthority V2 and `CodeHost.landAuthorizedIntegration` conformance.
- Event schemas/control-plane atomic writes and RLS migrations.
- CI Insights flake model, exact quarantine, and root-cause spec generation.
- DeployAdapter preview/promote/rollback and demo-engine behavior attribution.
- Dashboard/CLI policy and command surfaces.
- Budget/cost accounting for speculative nodes and proof savings.

Worktree isolation should follow the brief: every roadmap spec declares owned paths and provided/consumed contracts [PROJECT_BRIEF.md](/home/trevor/projects/tanren/PROJECT_BRIEF.md:1314). Serialize migrations, `mergeAuthority.ts`, event registry/schema, route mounts, and shared dashboard navigation. Most solver, proof, flake, API, adapter, and UI work can proceed behind frozen contracts in parallel worktrees.

Implementation validation is narrow affected checks during each spec, then `just fast-check`, `just ci`, and `just smoke`, followed by a real multi-member fixture exercise with deploy/demo evidence.

## (9) RISKS/UNKNOWNS

- **“Never blockable” needs a precise boundary.** No individual candidate may block independent authorized work. A total Postgres/code-host outage or a state in which no subset can be proven safe must still fail closed; availability cannot justify an unsafe land.
- **v96 deployed-revision forensics.** Current HEAD proves the policy-to-generic-loop bug but not the exact edge that sent v96 into batch-wide infra escalation. Preserve the live event payload and deployed commit before replacing that code, then add the regression against both return and throw/reclassification paths.
- **Subset search complexity.** General interaction isolation is NP-hard in the worst case. Bound concurrent probes, cache constraints, prioritize high-information partitions, and allow heuristic candidate generation—but only an exact MergeAuthority evaluation may authorize the result.
- **Nonmonotone tests.** A test passing on a superset need not pass on a subset. Proof reuse must be based on identical declared inputs, never a blanket monotonicity assumption.
- **Attribution uncertainty.** Member-local audits are easy; cross-member performance, schema, security, or behavior failures may not be. Uncertain attribution must trigger subset probing, not guesswork.
- **Affected-test unsoundness.** A missing or incomplete dependency map forces the full logical gate. Periodic full-gate audits and negative controls are necessary to detect a bad selector.
- **Flake false positives.** Require identical tree/environment, complete structured evidence, confidence thresholds, expiry, shadow execution, and automatic recovery. Per-test quarantine must never waive an entire suite.
- **Host representation of batch land.** GitHub may not present every original PR exactly as desired after a direct batch CAS. `CodeHost` conformance must specify PR closure/merged status, commit identity, review preservation, and deployment-trigger semantics for every merge method.
- **External-transaction atomicity.** Git host CAS and Postgres finalize cannot be one transaction. The existing `merge_state_unknown` posture must become a first-class land-group reconciler with idempotent member settlement.
- **Cross-repository atomicity is impossible.** Use an org-scoped saga, compatibility previews, staged promotion, and rollback/roll-forward. Never claim atomic multi-repo source land.
- **Agent re-spec loops.** “Different agent” alone does not ensure progress. Preserve fixed-point signatures, enforce route diversity, allow spec splitting, and track generations/cost. The member remains isolated rather than consuming queue capacity.
- **Policy changes during proof.** Any policy, DesignContract, behavior, environment, runner, gate, or quarantine revision invalidates the affected authorization and proof units before CAS.
- **Post-merge rollback semantics.** Roll back the deployed artifact immediately; do not rewrite main. A source revert or repair remains another MergeAuthority-gated change.
- **Compute and storage cost.** EAGER frontiers and subset probes can multiply short-lived runner demand and evidence volume. Per-unit reuse should reduce steady-state CI sharply, but capacity and dollar budgets remain mandatory.
- **Tenant security.** Proof bundles, logs, diffs, and artifacts may contain sensitive material. Store hashes and governed artifact references, apply direct org RLS, redact event payloads, and expire raw evidence separately from durable attestations.
- **Operational comprehensibility.** A combinatorial proof graph can overwhelm operators. The UI must lead with “what lands now / what is isolated / why,” with the full proof tree available on demand.
- **Migration risk.** Dual authority or dual queue behavior during cutover would be worse than downtime. Backfill operational state, validate equivalence in shadow mode, then perform one-way authority cutover.

This was a read-only architecture assessment: no files were changed and no checks were run.
