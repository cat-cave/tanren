## (1) IDEAL DESIGN + HOW IT FITS THE ENGINE + THE OWNED-STACK ADVANTAGES IT EXPLOITS

Build a first-class **Live Resolution Loop**. Tanren may say an issue is fixed only when:

1. An immutable symptom oracle reproduced the reported failure against the old live product.
2. The normal writer/checker/auditor/design-oracle loop produced a fix.
3. `.tanren/ci.yml` passed over SSH.
4. `MergeAuthority` authorized and landed the exact jj-produced commit.
5. The exact merged artifact was deployed.
6. The same locked oracle passed against that artifact on the live target.
7. Where possible, the old artifact still fails the same oracle as a counterfactual control.
8. A separate fail-closed `ResolutionAuthority` authorized source closure.
9. The source adapter closed the issue and read the resulting state back successfully.

A green gate authorizes a merge. It must never, by itself, authorize issue resolution.

### What exists, and the precise gap

Tanren already has the correct structural foundation:

- Native Action-less delivery, an SSH gate, deploy, and demos are explicit doctrine in [PROJECT_BRIEF.md](/home/trevor/projects/tanren/PROJECT_BRIEF.md:65) and [PROJECT_BRIEF.md](/home/trevor/projects/tanren/PROJECT_BRIEF.md:147).
- `CiConfigV1` requires `pre_merge` coverage and positive evidence, preventing a vacuous green gate in [schema.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/ci/schema.ts:192) and [schema.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/ci/schema.ts:233).
- `MergeAuthority` is already the sole fail-closed land authority, with `authorized | blocked | needs_attention` decisions in [mergeAuthority.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/mergeAuthority.ts:1) and [mergeAuthority.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/mergeAuthority.ts:227).
- jj is the sole local VCS core; conflicts survive rebases and unresolved work cannot be exported in [workspaceVcsCore.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/workspaceVcsCore.ts:1) and [workspaceVcsCore.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/workspaceVcsCore.ts:113).
- The `DagWalker` already provides durable, priority-aware speculative scheduling over the existing executor in [dagWalker.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/dagWalker.ts:1) and [dagWalker.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/dagWalker.ts:236).

But the current back half cannot prove symptom resolution:

- The live land bundle explicitly supplies `demo: "not_required"` because the demo happens after landing in [mergeAuthorityBundleBuild.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityBundleBuild.ts:210).
- `merge.completed` and the spec’s `merged` state become durable before deployment or live verification in [mergeAuthorityLandFinalizer.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityLandFinalizer.ts:34). That is correct for immutable merge history, but it means resolution needs its own lifecycle.
- Deploy evidence is currently provider READY plus URL reachability in [deployAdapter.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/deployAdapter.ts:39). Even 401/403 count as reachable in [directApiDeployAdapter.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/deploy/directApiDeployAdapter.ts:122).
- `deploy.triggered` records a provider/reference provenance string, but explicitly has no content digest in [deployOnMerge.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/deployOnMerge.ts:290).
- Behaviors are real persona-owned Given/When/Then entities in [behaviors.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/entities/behaviors.ts:9), but the post-deploy loader discards those fields and forwards only title and metadata in [demoOnDeployReads.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/demoOnDeployReads.ts:94).
- Web demos test route reachability, not response body, DOM, computed style, workflow outcome, or the reported symptom in [demoEvidence.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/demo/demoEvidence.ts:97).
- `DemoEngine` emits `demo.completed` with a failure count even when assertions failed or no behavior existed in [demoEngine.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/demo/demoEngine.ts:118).
- The post-merge issue watcher checks generic current base-branch checks, not the original symptom or necessarily the exact merged SHA, in [watcher.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/watcher.ts:127).
- The post-merge subscriber has notification wakeups but no startup scan; its current order is generic issue watcher → deploy → demo in [subscriber.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/subscriber.ts:78) and [subscriber.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/subscriber.ts:145).
- The roadmap is appropriately honest that no apex run has yet proven issue → triage → fix → merge → deploy → working product in [ROADMAP.md](/home/trevor/projects/tanren/ROADMAP.md:28).

D2 is partly ahead of the described v96 state, but remains incomplete:

- GitHub issue webhooks are now HMAC-verified, persisted, and acknowledged before detached processing in [issues.ts](/home/trevor/projects/tanren/services/orchestrator/src/routes/githubWebhooks/issues.ts:70).
- Webhook support is GitHub-issues-only; closed/deleted actions are ignored rather than reconciled into an issue lifecycle in [webhookMapping.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/forge/intake/webhookMapping.ts:50).
- `delivery_id` is nullable and lacks a uniqueness constraint; undriven rows are read without a claim/lease in [schemaInbox.ts](/home/trevor/projects/tanren/db/src/schemaInbox.ts:112) and [webhookEvents.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/repositories/webhookEvents.ts:85).
- Configuring push disables source polling rather than retaining reconciliation as a backstop in [poller.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/forge/intake/poller.ts:85).
- Provenance columns exist in [0025_specs_triage_provenance.sql](/home/trevor/projects/tanren/db/migrations/0025_specs_triage_provenance.sql:1), but their uniqueness depends on a non-null parent spec in [0027_specs_triage_provenance_unique.sql](/home/trevor/projects/tanren/db/migrations/0027_specs_triage_provenance_unique.sql:1). A top-level external issue has no honest parent.
- Internal finding-to-child routing supplies all four provenance fields in [plannerRunTriageNewSpecs.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/plannerRunTriageNewSpecs.ts:98), while both automatic and manual inbox acceptance omit `triageProvenance` in [engine.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/forge/inbox/engine.ts:275) and [engine.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/forge/inbox/engine.ts:400).

### The target architecture

```text
signed source finding
        │
        ▼
immutable SymptomContractV1 ── baseline reproduction on current live product
        │                                      │
        │                              not reproducible → needs evidence
        ▼
first-class triage Answerer task → spec origin + source-finding links
        │
        ▼
DagWalker → writer/checker/auditor/design-oracle → native SSH gate
        │
        ▼
preview/integration-node verification → MergeAuthority → jj CAS land
        │
        ▼
exact SHA + artifact digest deploy → generic behavior demo
        │                              + original symptom verification
        ▼
ResolutionAuthority
   ├─ verified → source close outbox → provider readback → proof sealed
   ├─ failed   → reopen/comment → P0 successor repair spec → DagWalker
   └─ unknown  → remain open, retry/reconcile or needs_attention
```

The central entities and rules are:

1. **`IssueLoop` aggregate.** One durable causal history for the source issue, all source revisions, triage tasks, specs, PRs, merge decisions, deployments, verification attempts, repairs, rollbacks, and external state transitions. Inbox candidates become a projection onto this aggregate, not the source of truth.

2. **Immutable `SymptomContractV1`.** A versioned executable contract containing:
   - Source finding IDs, provider revision, fingerprint, source URL, and severity.
   - Persona and full Given/When/Then behavior references.
   - DesignContract version and relevant design dimensions.
   - Target environment, surface, route, region, locale, viewport, feature flags, identity, and test-data fixture.
   - Setup, actions, assertions, invariants, cleanup, and maximum permitted side effects.
   - HTTP/JSON, DOM, visual, accessibility, CLI/package, mobile-channel, telemetry, or hybrid probe mode.
   - Expected failing observation, expected corrected observation, observation window, confidence policy, and flake policy.
   - Required verification fragments and their versions/hashes.
   - Redaction, evidence-retention, and destructive-action approval policy.

   The writer may add a repository regression test, but may not mutate the control-plane oracle that decides resolution. A contract change creates a new version, forces a new baseline, and is itself auditable.

3. **Baseline before remediation.** The exact contract must observe the symptom on the current live artifact. An unreproducible report is not silently dismissed: it becomes `awaiting_reproduction`, `observational`, or `needs_reporter_detail`. This prevents a broken probe from “passing” both before and after.

4. **Proof grades.**
   - `active_causal`: active old-fails/new-passes replay against artifact-bound surfaces.
   - `active_plus_soak`: active causal replay plus a telemetry/regression window.
   - `observational`: telemetry indicates recurrence stopped, but no active counterfactual exists.
   - `attested`: a human or external device/store confirms it.

   Default autonomous closure requires `active_causal` or `active_plus_soak`. Mere silence in Sentry is not proof.

5. **Preview and production use the same contract.** For deployable integration nodes, run it before merge against a preview/canary; after merge, run it again against production. Preview failure feeds the current writer self-healing loop. Production failure creates a successor repair attempt.

6. **`ResolutionAuthority`, separate from `MergeAuthority`.** It is the only component allowed to declare internal resolution or enqueue source closure. Inputs include:
   - Immutable contract hash and source revision.
   - Successful baseline/counterfactual evidence.
   - Gate evidence and `MergeAuthority` audit ID.
   - Merge SHA and exact deployed artifact digest.
   - Fresh production assertions and required soak/invariants.
   - Proof grade and project resolution policy.

   Its outcomes are `authorized`, `blocked`, or `needs_attention`. It never lands code. `MergeAuthority` remains the only merge decision.

7. **Guaranteed source synchronization.** Issue close, reopen, comment, and label operations move from best-effort visibility projection into an `IssueSourceAdapter` contract plus transactional outbox. Internal state remains `verified_source_sync_pending` until provider receipt and readback agree. PR text avoids provider closing keywords until verification; if a human or provider closes early, reconciliation records `externally_closed_unverified` and reopens or flags it according to policy.

8. **Failure produces new work, not rewritten history.** A failed production replay:
   - Leaves the first spec and merge permanently merged.
   - Reopens or keeps open the source issue.
   - Creates a P0 successor repair spec linked to the failed attempt and exact evidence.
   - Changes the hypothesis/agent/model or decomposition when the failure signature repeats.
   - Lets `DagWalker`, jj, the native gate, and `MergeAuthority` process it normally.
   - Detects a genuine evidence/hypothesis fixed point rather than using an arbitrary attempt cap.

9. **Safe rollback.** Traffic rollback to a previously verified artifact is a release action; any source-code revert is a P0 spec and still requires `MergeAuthority`. Irreversible migrations require explicit mitigation or human intervention.

10. **F2-authored verification capabilities.** Create reusable fragments such as `verification-http-json`, `verification-playwright-dom`, `verification-visual`, `verification-a11y`, `verification-cli-package`, and `verification-sentry-window`. Tanren’s fragment system already mandates fragment-only composition and missing-fragment F2 authoring with no fallback in [README.md](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/README.md:3). F2 already validates each authored fragment in isolation and in the full library in [fragmentAuthoringRun.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/fragmentAuthoringRun.ts:1). A missing verification modality therefore becomes a prerequisite capability spec, not an opaque one-off script.

### Owned-stack advantages point tools cannot reproduce

- **Semantic continuity:** one signed oracle survives report → triage → spec → agent prompts → preview → gate → deploy → production.
- **Causal verification:** Tanren can retain old and new live artifacts and prove old-fails/new-passes, rather than infer success from a PR merge or absence of telemetry.
- **Artifact identity:** the same control plane owns source SHA, jj integration state, build, deployment, route, and evidence.
- **Queue-aware verification:** every symptom contract attached to a speculative integration node can run on the batch; a failure can use the native queue’s existing bisect machinery.
- **Issue-aware EAGER repair:** failure can immediately create and speculate on a repair DAG while unrelated work continues.
- **Entity-scoped production barriers:** a verified regression can temporarily hold only queue entries touching affected entities or behaviors, not the whole project.
- **Intent-preserving repair stacks:** jj retains conflicted work and the acceptance intent of both the original issue and subsequent repairs.
- **Learning from live falsification:** the next writer sees the exact failed live assertion, screenshot, trace, artifact identity, and rejected hypothesis.
- **Full economics:** triage, writer, checker, auditor, verifier, and repair attempts all retain disjoint token buckets and honest billing/cost provenance.
- **A cryptographic resolution certificate:** Tanren can export a machine-verifiable proof that the issue was reproduced, fixed, deployed, exercised, and closed.

---

## Continue reading

This bucket is split to respect the 500-line source-file cap. Section (1) above is the ideal design and owned-stack advantages; the operational spec continues in spec order across these sibling files:

1. [(2) Comparator parity matrix, (3) data model, (4) engine integration, (5) HTTP surface](./backhalf-comparator-data-engine-http.md)
2. [(6) UI/dashboard surface, (7) apex-provability, (8) effort + phasing, (9) risks/unknowns](./backhalf-ui-apex-phasing-risks.md)
