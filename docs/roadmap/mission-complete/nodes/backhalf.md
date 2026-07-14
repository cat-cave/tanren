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

## (2) COMPARATOR PARITY MATRIX

This inventory covers the documented remediation and workflow surfaces in the official comparator documentation reviewed on 2026-07-13. “Matches” and “exceeds” describe the proposed ideal, not current shipped state.

The cross-comparator conclusion is an inference from those official docs: each tool documents part of triage, code generation, PR creation, merge automation, deployment, or passive recurrence detection; none documents an artifact-bound report → fix → authoritative merge → production deploy → active replay of the original symptom → reopen/repair loop.

| Comparator capability | How Tanren matches it | How Tanren EXCEEDS it |
|---|---|---|
| Sentry — error intake, grouping, releases, environments, issue lifecycle ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/), [issue states](https://docs.sentry.io/product/issues/states-triage/)) | Sentry adapter normalizes groups/events/releases/environments into source findings and issue loops. | Active reproduction is bound to the affected environment and exact artifact; grouping becomes one input to the oracle, not the closure criterion. |
| Sentry — automated issue scan and actionability assessment ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/)) | Triage Answerer ranks actionability, severity, affected behaviors, likely entities, and routability. | It must also author or select a reproducible `SymptomContractV1`; “actionable” without a testable symptom cannot autonomously close. |
| Sentry — automatic scan thresholds and configurable stopping points ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/)) | Per-source policies choose triage-only, RCA, proposed fix, PR, auto-merge eligibility, or closed-loop repair. | Policy controls proof grade and live-close authority independently from code-generation autonomy. |
| Sentry — RCA from stack traces, traces, logs, profiles, commits, deploys, and code ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/)) | Finding enrichment stores those signals and injects them into triage, planner, checker, and auditor tasks. | The system tests the hypothesis against live before/after artifacts and feeds failed hypotheses back into the next repair. |
| Sentry — interactive investigation and multi-repository context ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/)) | Forge conversation can refine source context, inspect multiple project repositories, and split a fix into a cross-repository DAG. | Cross-repository specs share one issue loop and resolution contract; resolution waits for every required deployed component rather than the first PR. |
| Sentry — asynchronous fix steps, continuation, retries, user context, and inspectable state ([start API](https://docs.sentry.io/api/seer/start-seer-issue-fix/), [state API](https://docs.sentry.io/api/seer/retrieve-seer-issue-fix-state/)) | Durable triage/remediation/verification attempts expose state, progress, inputs, retries, and steering. | Attempts survive worker restarts through claims and startup reconciliation, and state continues through merge, deploy, production replay, and source readback. |
| Sentry — root cause, solution, code changes, PR iteration, open PR, coding-agent handoff ([start API](https://docs.sentry.io/api/seer/start-seer-issue-fix/)) | Writer/checker/auditor/design-oracle loops produce patches, tests, PRs, and follow-up iterations. | Handoff remains inside one typed DAG and one cost/provenance chain; the fix is not trusted until live falsification succeeds. |
| Sentry — anomaly/spike/crash-loop investigation and collaboration | Scheduled and webhook-driven telemetry findings can create loops, notify operators, and invoke specialized triage agents. | Tanren can plant an active probe, deploy a canary fix, compare old/new cohorts, and automatically route another repair if the anomaly persists. |
| Sentry — resolve by commit/release and mark regression when telemetry recurs ([issue states](https://docs.sentry.io/product/issues/states-triage/)) | Source adapter records commit/release association and consumes regression/reopen events. | Resolution waits for active production proof; recurrence is a secondary soak signal. A failed immediate replay reopens before users need to generate another event. |
| Sentry — privacy, access, and source-context controls ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/)) | Org-scoped credentials, redacted evidence, least-privilege probes, retention policy, and raw-access audit events. | Every evidence object and model invocation is org-scoped, content-addressed, policy-redacted, and tied to the resolution decision that consumed it. |
| GitHub Copilot Autofix — CodeQL alert/SARIF intake, data-flow locations, query help ([Autofix concept](https://docs.github.com/en/code-security/concepts/code-scanning/copilot-autofix-for-code-scanning)) | SARIF/CodeQL source adapter produces structured findings with rule, flow, locations, severity, and CWE metadata. | Static evidence becomes one assertion in a broader contract that can also prove exploit behavior or live security invariants after deployment. |
| Copilot Autofix — explanations and suggested fixes ([Autofix concept](https://docs.github.com/en/code-security/concepts/code-scanning/copilot-autofix-for-code-scanning)) | Triage/planner explains cause and proposed correction; writer produces the patch. | Independent checker, auditor, security auditor, native gate, preview exploit probe, and production invariant all challenge the suggestion. |
| Copilot Autofix — draft PR creation and REST-driven fix generation ([resolve alerts](https://docs.github.com/en/enterprise-cloud@latest/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts)) | API-triggered loops can create a draft PR and expose attempt state. | PR creation is merely one event in a durable, restart-safe resolution loop with merge and production evidence. |
| Copilot Autofix — assignment to a cloud coding agent ([resolve alerts](https://docs.github.com/en/enterprise-cloud@latest/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts)) | Provider/model routing can assign a suitable Writer while Answerers remain filesystem-isolated. | Tanren can switch agent/model/hypothesis after a live failure while retaining one issue-loop identity and evidence history. |
| Copilot Autofix — language/query support and repository administration ([Autofix concept](https://docs.github.com/en/code-security/concepts/code-scanning/copilot-autofix-for-code-scanning)) | Adapter capabilities declare supported rules/languages and fail closed when a rule cannot be remediated automatically. | The fragment/F2 system can author missing runtime-specific verification support instead of limiting the loop to a fixed language list. |
| Copilot Autofix — CodeQL rerun closes a fixed alert ([GitHub tutorial](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/finding-and-fixing-your-first-code-vulnerability)) | Native gate reruns CodeQL/SARIF checks on the exact integration SHA. | Static disappearance authorizes merge eligibility, not resolution; production exploit/invariant checks and artifact identity authorize closure. |
| Copilot Autofix — best-effort, potentially partial or incorrect suggestions ([responsible-use documentation](https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/about-autofix-for-codeql-code-scanning)) | Findings remain untrusted until checked, audited, gated, and tested. | A wrong-but-green patch is detected by the old-fails/new-passes live contract and automatically routed into another repair. |
| Copilot Autofix — human review and secure-development controls ([responsible-use documentation](https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/about-autofix-for-codeql-code-scanning)) | Project policy can require review/HITL before `MergeAuthority` authorizes landing. | Review posture and resolution posture are separate: a human-approved merge still cannot falsely close a failed production symptom. |
| Renovate — broad managers, datasources, platforms, package files, lockfiles, and digests ([how it works](https://docs.renovatebot.com/key-concepts/how-renovate-works/), [managers](https://docs.renovatebot.com/modules/manager/)) | Dependency-source adapters and upgrade fragments cover manifests, lockfiles, images, actions, digests, and generated/vendor outputs. | F2 can author an org-specific dependency manager plus its conformance fixture; the deployed product contract validates the update’s actual behavior. |
| Renovate — private registries, host rules, custom managers/datasources ([configuration](https://docs.renovatebot.com/configuration-options/)) | Org secret grants and adapters support private registries and custom source discovery. | Registry credentials never enter prompts; verification runs with separate least-privilege runtime identities and org-scoped audit evidence. |
| Renovate — pin, digest, replacement, rollback, lockfile maintenance, and post-upgrade work ([configuration](https://docs.renovatebot.com/configuration-options/)) | Upgrade specs encode the exact mutation and generated-file/post-upgrade commands in `.tanren/ci.yml`. | Rollback is based on production symptom regression and known-good artifact identity, not just a version comparison. |
| Renovate — `packageRules`, versioning, range strategies, allow/ignore policy ([configuration](https://docs.renovatebot.com/configuration-options/)) | Typed org/project dependency policy compiles findings into permitted upgrade specs. | Policy also includes behavior/entity blast radius, deployment cohort, proof grade, and automatic rollback eligibility. |
| Renovate — grouping, monorepo grouping, and dependency coupling ([configuration](https://docs.renovatebot.com/configuration-options/)) | Forge derives grouped or separate upgrade specs and dependency edges. | The native integration-node queue can empirically discover incompatible groups through preview verification and bisect them. |
| Renovate — schedules, time zones, branch/PR limits, concurrency ([configuration](https://docs.renovatebot.com/configuration-options/)) | DagWalker priorities, budgets, provider capacity, release windows, and project concurrency govern execution. | Scheduling can account for current production health and hold only upgrades touching an unhealthy entity or behavior. |
| Renovate — Dependency Dashboard, approvals, pending/deferred/ignored/deprecated/abandoned items ([Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/)) | Self-Healing Center exposes queued, deferred, ignored, blocked, dead-lettered, and approval-required loops. | It also shows baseline/live evidence, false-green catches, repair ancestry, exact deployed artifact, and source-sync state. |
| Renovate — minimum release age ([minimum release age](https://docs.renovatebot.com/key-concepts/minimum-release-age/)) | Policy can delay an upgrade until a release matures. | Tanren can additionally run staged canaries and advance only when the application’s own behaviors remain verified. |
| Renovate — merge confidence based on age, adoption, and public CI ([merge confidence](https://docs.renovatebot.com/merge-confidence/)) | External confidence contributes to prioritization and auto-merge policy. | Org-local evidence dominates: historical outcomes for this entity, stack, fragment set, tests, production traffic, and exact runtime. |
| Renovate — vulnerability remediation and priority handling | Vulnerability sources create P0 upgrade specs and can bypass ordinary scheduling. | Tanren proves the vulnerable behavior or security invariant on preview/production and can quarantine impacted queue entities until verified. |
| Renovate — rich PRs, release notes, changelogs, labels, reviewers | PR projection includes provenance, release context, risk, tests, reviewer routing, and proof links. | After closure, the PR links to a signed resolution certificate showing what users actually received. |
| Renovate — rebasing/recreation and branch freshness ([automerge](https://docs.renovatebot.com/key-concepts/automerge/)) | jj rebases onto shifting bases, preserves conflicts, restacks descendants, and re-gates. | Conflict resolution has both dependency intent and affected behavior contracts; no work is discarded. |
| Renovate — PR/branch/platform/comment automerge, merge strategies, merge queue, branch-on-pass behavior ([automerge](https://docs.renovatebot.com/key-concepts/automerge/)) | Native queue supports autonomous land, review policies, speculative batch checking, and bisect; only `MergeAuthority` lands. | No external platform automerge can bypass Tanren’s decision, and auto-merge is followed by artifact-bound production verification and repair. |
| Renovate — noise/failure controls and selective PR creation | Fold duplicates by source fingerprint, group compatible work, and surface fixed points/dead letters. | “No PR needed” and “green PR” are distinct from “verified fixed”; suppressed noise never suppresses a live regression. |
| Dependabot — dependency alerts and minimum patched security updates ([security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates)) | Advisory adapters produce P0 findings and compute permitted patched versions. | Tanren chooses among permitted fixes using application-specific live evidence, not version metadata alone. |
| Dependabot — version updates across ecosystems, private registries, vendored dependencies ([options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)) | Upgrade fragments and secret-backed adapters support equivalent update surfaces. | Missing ecosystem support is F2-authored and conformance-tested; deployment verifies the resulting product. |
| Dependabot — allow/ignore rules, direct/indirect scope, update types, semver/ranges ([options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)) | Typed dependency policy matches these selectors and routes them into specs. | Policy adds affected behavior/entity, rollout safety, proof grade, and historical fix efficacy. |
| Dependabot — groups and multi-ecosystem groups ([multi-ecosystem updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/multi-ecosystem-updates)) | Forge emits cross-ecosystem grouped DAG nodes. | Speculative integration runs prove the entire upgrade set together and native bisect isolates the incompatible member. |
| Dependabot — schedules, cooldowns, open-PR limits ([options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)) | DagWalker and project policy provide equivalent cadence, priority, capacity, and budget governance. | Production health dynamically gates risky updates; security findings may bypass cadence but never verification. |
| Dependabot — auto-triage predicates such as severity, package, CVE/CWE, scope, and EPSS ([auto-triage rules](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-auto-triage-rules)) | Source triage rules combine advisory metadata with model analysis. | Rules can require an active exploit/invariant baseline, entity blast radius, DesignContract impact, and production proof. |
| Dependabot — dismiss, snooze, reopen, open-PR actions; org rules, audit, API/webhook visibility ([auto-triage rules](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-auto-triage-rules)) | Issue-source adapters support equivalent lifecycle commands, durable receipts, and org policies. | Every action is tied to a causal loop and read back from the provider; source drift is reconciled rather than assumed. |
| Dependabot — PR vulnerability context, release/changelog information, compatibility score ([Dependabot PRs](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/dependabot-pull-requests)) | PR projection includes advisory, compatibility, change, and test information. | Compatibility is measured on the organization’s actual composed product and live deployment. |
| Dependabot — rebase/recreate/ignore commands and inactivity behavior ([Dependabot PRs](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/dependabot-pull-requests)) | Dashboard commands steer, regenerate, pause, supersede, or dismiss an upgrade loop. | The command history, agent consequences, deployment, and final proof remain in one event chain. |
| Dependabot — metadata-driven auto-merge composed with branch protection/merge queue ([automation tutorial](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automating-dependabot-with-github-actions)) | Native policy consumes update metadata, gates, reviews, and queue state without GitHub Actions. | `MergeAuthority` is the non-bypassable decision; successful merge does not close the alert until the live contract passes. |
| Dependabot — merged update resolves the alert ([security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates)) | Source adapter associates merge and release with the finding. | Closure requires deployed artifact identity plus active security/application verification; failure reopens and creates another upgrade/repair spec. |
| Devin — general autonomous code investigation and implementation | Writer agents inspect code, change files, execute commands, and produce PRs; Answerers independently check completion. | The surrounding engine, not the agent, controls the immutable oracle, merge decision, deployment, closure, and repair recurrence. |
| Devin — Slack, GitHub, Linear, API/CLI and integration surfaces ([integrations](https://docs.devin.ai/integrations/overview)) | Source adapters and HTTP APIs accept equivalent triggers and expose loop state. | Every channel maps to one deduplicated issue loop rather than spawning disconnected sessions. |
| Devin — scheduled/custom-webhook automations, conditions, new or persistent sessions ([automations](https://docs.devin.ai/product-guides/automations)) | Trigger policies can create, resume, or reconcile a loop from webhook, schedule, manual/API, or telemetry events. | Persistent state is a typed Postgres aggregate plus event stream, not merely agent memory. |
| Devin — persistent auto-triage, dedupe/noise filtering, child issues, owner routing, scratchpad ([auto-triage](https://docs.devin.ai/product-guides/auto-triage)) | Triage tasks deduplicate, decompose, assign ownership, and preserve structured reasoning. | Child specs form a real dependency DAG; closure waits for the deployed behavior spanning every required child. |
| Devin — shell, IDE, browser, and codebase investigation ([session tools](https://docs.devin.ai/work-with-devin/devin-session-tools)) | Runner containers expose appropriate tools through Writer adapters. | Production probes use separate constrained identities and adapter contracts; writer browser activity cannot forge resolution evidence. |
| Devin — knowledge, playbooks, skills, secrets, and MCP integrations | Fragment libraries, F2, project context, managed credentials, and adapter contracts provide reusable expertise. | Verification fragments are versioned, hashed, conformance-tested, and included in the proof bundle. |
| Devin — budgets, rate limits, network controls, permissions | Tanren governs provider capacity, spend, network policy, credentials, and human review. | Budget is tracked through the entire loop, including triage, failed live verification, repair, deployment, and source synchronization. |
| Devin — test/lint/typecheck, fix iteration, PR creation, and bot-feedback handling | The Writer loop runs checks; checker/auditor/native gate and review feedback route rework. | The same issue can survive multiple merged PRs until the production symptom is actually gone. |
| Devin — automated review, bug/security findings, chat, suggested changes ([Devin Review](https://docs.devin.ai/work-with-devin/devin-review)) | Review Answerers produce structured findings and suggested repairs. | Findings enter `MergeAuthority` posture and may also become source findings with their own live contracts. |
| Devin — end-to-end test plan, browser execution, video/annotation against local/dev/staging ([testing and recordings](https://docs.devin.ai/work-with-devin/testing-and-recordings)) | Preview verification records trace, screenshots/video, assertions, and critical flow evidence. | The same locked test runs automatically after merge against the exact production artifact; a short PR-time recording cannot substitute for it. |
| Devin — parallel sessions and activity history | DagWalker runs independent/speculative work concurrently and events expose every transition. | Native dependency edges, integration nodes, jj restacking, queue ordering, and production barriers coordinate the sessions causally. |
| Devin — deployment assistance ([deployment capabilities](https://docs.devin.ai/product-guides/deployment-capabilities)) | Deploy adapters provision/bind, trigger, verify, promote, rollback, and resolve the user-facing surface. | Deployment is a typed engine stage with exact artifact identity, canary progression, live assertions, and automatic repair/rollback. |
| Devin — merge/automerge through the repository platform | Review policy and `MergeAuthority` can autonomously land approved work. | The host is only the landing surface; it cannot bypass the native gate, queue, merge authority, resolution authority, or production proof. |
| All comparators — auto-triage plus auto-PR | Tanren matches automated intake, RCA, code changes, tests, PRs, review, and merge automation. | Tanren owns the missing back half: baseline symptom → exact merge → exact deploy → active live replay → reopen/repair or evidence-backed closure. |

## (3) DATA MODEL

The latest migration is currently `0032`; the following should use the next available serial numbers and be serialized because migrations are shared paths.

| Entity | Purpose and key invariants |
|---|---|
| `issue_loops` | `id`, `org_id`, `project_id`, `source_id`, external key, generation, fingerprint, severity, state, source revision, current contract/attempt, resolution policy, optimistic `row_version`. Unique `(org_id, source_id, external_key, generation)`. |
| `source_findings` | Immutable normalized source observations: provider object ID/revision, delivery, status, release/environment, title/body/context, fingerprint, observed timestamp, raw-artifact reference. Never overwrite prior revisions. |
| `issue_loop_edges` | `duplicate_of`, `supersedes`, `regression_of`, `caused_by`, and `split_from` relationships. |
| `symptom_contracts` | Immutable `SymptomContractV1` JSON, schema version, canonical hash, proof policy, target, fragment versions, source revision, author task, lifecycle state, and baseline requirement. |
| `symptom_contract_fragments` | Exact fragment IDs, versions, content hashes, and conformance result used to execute a contract. |
| `spec_origins` | Normalized link from a spec to issue loop, triage task, attempt number, and role: `primary_fix`, `repair`, `rollback`, `probe_capability`, or `followup`. |
| `spec_origin_findings` | Many-to-many link between specs and immutable source findings; removes the array-only provenance ceiling. |
| `remediation_attempts` | Loop iteration, hypothesis, spec/run/PR, agent route, integration node, gate evidence, MergeAuthority audit ID, merge SHA, prior attempt, outcome, and failure signature. |
| `release_instances` | Provider/app/environment, deployment ID, immutable source SHA, OCI/package/store digest, build provenance, live URL/channel, region, previous verified release, state. |
| `verification_runs` | Contract, release, stage (`baseline`, `preview`, `production`, `soak`, `counterfactual`), proof grade, claim/lease, start/end, result, classification (`product_failure`, `infra_failure`, `stale_contract`, `inconclusive`), and observation window. |
| `verification_assertions` | One row per assertion/invariant with expected/observed canonical hashes, outcome, timing, retry/sample data, and evidence references. |
| `evidence_artifacts` | Content-addressed screenshots, traces, HAR, videos, JSON bodies, telemetry query receipts, stdout, JUnit, and attestation data; stores object URI, SHA-256, MIME, sensitivity, encryption key reference, retention, redaction status. |
| `resolution_decisions` | Immutable fail-closed input snapshot/hash, outcome, reasons, authority version, contract/release/verification IDs, and audit ID. |
| `source_sync_outbox` | Idempotent `comment`, `label`, `close`, `reopen`, or `link_release` action; desired source revision, attempt state, retry time, provider receipt, and readback result. |
| `release_health_barriers` | Entity/behavior/environment-scoped queue hold created by a verified regression; never a global project stop unless policy requires it. |
| `webhook_delivery_claims` | Lease/heartbeat/terminal state for durable delivery processing, or equivalent claim columns on `webhook_events`. |

### Provenance correction

Keep the four existing spec columns as compatibility projections, but make the normalized origin graph authoritative:

- Add `origin_issue_loop_id`.
- Permit `parent_spec_id = NULL` for an external top-level issue.
- Populate `source_finding_ids` for every issue-origin spec.
- Populate `origin_triage_task_id` with a real Answerer task ID, never `""` or a fabricated identifier.
- Replace parent-dependent dedupe with `(org_id, issue_loop_id, attempt_number, role, ordinal)`.
- Backfill existing internally routed specs from their current columns.
- Link candidates to `issue_loop_id`; `resolved_spec_id` remains a convenience pointer to the first spec, not the complete remediation history.

To make `origin_triage_task_id` truthful, generalize agent tasks so exactly one execution scope is present:

```text
tasks.run_id XOR tasks.issue_loop_id
cost_records.run_id XOR cost_records.issue_loop_id
```

That lets pre-spec triage be a genuine Answerer task with model, attempt, token, and cost records. Current tasks are hard-bound to a run in [schema.ts](/home/trevor/projects/tanren/db/src/schema.ts:49), so this is a deliberate schema evolution, not a fake provenance workaround. Cost rows retain disjoint token buckets and the mandated `billing_mode` and `cost_basis` values.

### Webhook hardening

Evolve existing `inbox_sources`, `webhook_events`, and candidates rather than creating a parallel intake stack:

- Unique non-null `(org_id, source_id, provider, delivery_id)` where the provider supplies an ID.
- A canonical payload hash/client idempotency key fallback.
- Atomic `FOR UPDATE SKIP LOCKED` claim or lease-CAS before processing.
- Signature algorithm/key-version/timestamp metadata.
- Encrypted raw payload artifact plus a normalized, redacted finding.
- Push delivery for latency **and** periodic provider reconciliation for missed/late events.
- Close/reopen/edit/delete actions update source revisions and loop state instead of being discarded.
- Durable webhook-provisioning saga with provider hook ID, desired/observed config, rotation state, and reconciliation.

### Migrations

A sensible serialized split is:

1. `0033_issue_loops_and_source_findings.sql`
2. `0034_issue_task_scope_and_spec_origins.sql`
3. `0035_symptom_contracts_and_verification.sql`
4. `0036_resolution_authority_and_source_outbox.sql`
5. `0037_resolution_event_types_rls_and_backfill.sql`

Every tenant table gets `org_id NOT NULL`, an org index, and RLS. Existing policy is deny-by-default when the GUC is absent in [0000_collapsed_baseline.sql](/home/trevor/projects/tanren/db/migrations/0000_collapsed_baseline.sql:924). Add composite `(org_id, id)` foreign keys wherever practical so an application bug cannot create a cross-org relationship even with system credentials.

Cross-org sweepers may use the existing fail-loud system pool only to discover work; processing must immediately enter `runWithOrgScope`, whose transaction-local GUC is defined in [orgScope.ts](/home/trevor/projects/tanren/db/src/orgScope.ts:117). Evidence object keys and encryption context also include `org_id`.

All new event types must be added to the Zod registry, regenerated into the DB allowlist—the generated file explicitly names the registry as source of truth in [eventTypes.ts](/home/trevor/projects/tanren/db/src/eventTypes.ts:1)—and appended only through [eventStore.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/eventStore.ts:94).

## (4) ENGINE INTEGRATION

| Stage | Ideal integration |
|---|---|
| 1. Intake | `IssueSourceAdapter` verifies the webhook, stores the delivery, fetches the authoritative source revision, and emits an immutable finding. Poll reconciliation remains enabled as a backstop. |
| 2. Loop allocation | Dedupe by provider identity, source revision, fingerprint, and entity/behavior anchor. Create or append to an `IssueLoop`. |
| 3. Baseline | A `ResolutionDagWalker` schedules the locked `SymptomContractV1` against the current live release. Product failure establishes the baseline; infrastructure failure remains inconclusive. |
| 4. Triage | A first-class Answerer task selects persona/behavior/DesignContract context, likely entities, proof mode, dependency placement, and repair policy. |
| 5. Spec insertion | Create a P0/P1 spec with normalized origin links, compatible provenance columns, contract hash, and acceptance criteria that include repository regression coverage. Notify the existing `DagWalker`. |
| 6. Agent loop | Existing planner → Writer → checker → auditor → design oracle. The live-failure evidence is injected as immutable context. Writers cannot edit the resolution oracle. |
| 7. Native gate | `.tanren/ci.yml` remains the only CI gate. The repository regression test and normal evidence run over SSH; failures route through the existing writer self-heal in [plannerRunCi.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/plannerRunCi.ts:254). |
| 8. Preview verification | If the target supports previews/canaries, deploy the exact integration-node artifact and run the same symptom contract. Feed `demo: verified` into `MergeAuthority`; a required but unavailable preview is explicitly `unverified`, not `not_required`. |
| 9. Queue/merge | The speculative/eager native queue runs every attached symptom contract for the integration batch. Failure invokes existing batch bisect. `MergeAuthority` alone authorizes the exact jj ref and CAS target. |
| 10. Post-merge deploy | Deploy the exact merge SHA; require a provider artifact digest/attestation in addition to the current provenance reference. Record environment, region, URL/channel, and previous verified artifact. |
| 11. Runtime checks | Run deploy readiness, the full generic Given/When/Then demo, the original symptom contract, non-regression invariants, and any required soak window. Reuse the A1/A3 runtime-verification ports and evidence formats rather than creating a second browser/probe stack. |
| 12. Resolution | `ResolutionAuthority` evaluates the immutable evidence. Success queues source closure; failure queues reopen/comment plus successor repair; uncertainty remains open and retries or escalates. |
| 13. Source readback | Outbox worker performs the provider mutation idempotently and reads the issue state/revision back. Only then does the loop reach `verified_closed`. |
| 14. Recurrence | New matching source findings reopen the loop as a new generation/attempt, attach the prior proof, and establish whether this is the same symptom or a new regression. |

### Durable orchestration

Do not add another notification-only watcher. Build a `ResolutionDagWalker` following the existing DagWalker pattern:

- Event notifications are latency hints.
- Startup scans recover outstanding baseline, production verification, and source-sync work.
- Periodic scans cover dropped notifications.
- Postgres claims/leases serialize effects.
- Every external call has an idempotency key and readback.
- Crash points between deployment, evidence append, decision, and source mutation are replay-safe.

The current post-merge watcher can remain as an **advisory source-finding producer** for generic base-branch failures. It must not decide resolution.

### Merge and repair semantics

- `MergeAuthority` remains the sole code-landing authority.
- `ResolutionAuthority` has no code-host land capability.
- A failed production verification does not mutate the merged spec back to open.
- A repair spec depends on the failed merged spec, carries the prior contract/evidence, and enters the normal DAG.
- Queue health barriers are scoped to affected semantic entities, behaviors, dependency packages, or rollout surfaces.
- Batch verification binds contracts to integration nodes; native bisect isolates which speculative change reintroduced the symptom.
- A traffic rollback may restore a previously verified artifact immediately when policy permits; a code revert remains ordinary P0 work through the full merge path.

### Adapter contracts and conformance suites

Add three explicit seams:

- `IssueSourceAdapter`: verify, normalize, fetch revision/status, comment, close, reopen, readback, reconcile.
- `SymptomProbeAdapter`: prepare fixture, execute, assert, collect evidence, clean up, classify product versus infrastructure failure.
- Extended `DeployAdapter`: deploy exact source, return artifact digest, create preview/canary, promote, rollback, resolve live surface, teardown.

Each gets a provider-neutral conformance suite. GitHub/Sentry/Linear/Jira and Fly/Vercel/package/mobile implementations must pass the same lifecycle, idempotency, failure-classification, and redaction behaviors.

## (5) HTTP SURFACE

### Inbound source endpoints

- `POST /webhooks/v1/github/issues/:sourceId`
- `POST /webhooks/v1/sentry/:sourceId`
- `POST /webhooks/v1/linear/:sourceId`
- `POST /webhooks/v1/jira/:sourceId`
- `POST /webhooks/v1/generic/:sourceId`

The current `/github/webhooks/issues/:sourceId` remains as a compatibility alias. Every endpoint verifies provider authenticity before persistence and returns `202` only after the durable delivery exists.

### Source administration

- `POST /v1/orgs/:orgId/issue-sources`
- `GET /v1/orgs/:orgId/issue-sources`
- `GET /v1/orgs/:orgId/issue-sources/:sourceId`
- `POST /v1/orgs/:orgId/issue-sources/:sourceId/provision`
- `POST /v1/orgs/:orgId/issue-sources/:sourceId/rotate`
- `POST /v1/orgs/:orgId/issue-sources/:sourceId/test`
- `POST /v1/orgs/:orgId/issue-sources/:sourceId/reconcile`
- `DELETE /v1/orgs/:orgId/issue-sources/:sourceId`

### Issue-loop and evidence queries

- `GET /v1/orgs/:orgId/projects/:projectId/issue-loops`
- `GET /v1/orgs/:orgId/projects/:projectId/issue-loops/:loopId`
- `GET /v1/.../issue-loops/:loopId/graph`
- `GET /v1/.../issue-loops/:loopId/findings`
- `GET /v1/.../issue-loops/:loopId/attempts`
- `GET /v1/.../issue-loops/:loopId/verifications`
- `GET /v1/.../verifications/:verificationId/assertions`
- `GET /v1/.../evidence/:artifactId`
- `GET /v1/.../issue-loops/:loopId/proof`
- `GET /v1/.../issue-loops/:loopId/proof/archive`

### Contract commands

- `GET /v1/.../issue-loops/:loopId/symptom-contracts`
- `POST /v1/.../issue-loops/:loopId/symptom-contracts`
- `POST /v1/.../symptom-contracts/:contractId/validate`
- `POST /v1/.../symptom-contracts/:contractId/rebaseline`
- `POST /v1/.../symptom-contracts/:contractId/dry-run`

A contract edit always creates a new version and requires `If-Match` against the loop/source revision.

### Operator commands

- `POST /v1/.../issue-loops/:loopId/reproduce`
- `POST /v1/.../issue-loops/:loopId/retry-verification`
- `POST /v1/.../issue-loops/:loopId/route-repair`
- `POST /v1/.../issue-loops/:loopId/steer`
- `POST /v1/.../issue-loops/:loopId/pause`
- `POST /v1/.../issue-loops/:loopId/resume`
- `POST /v1/.../issue-loops/:loopId/approve-destructive-probe`
- `POST /v1/.../issue-loops/:loopId/waive`

A waiver produces `resolution.waived`; it never masquerades as `symptom.verification.passed`.

### Delivery operations

- `GET /v1/orgs/:orgId/webhook-deliveries`
- `GET /v1/orgs/:orgId/webhook-deliveries/:deliveryId`
- `POST /v1/orgs/:orgId/webhook-deliveries/:deliveryId/redrive`
- `GET /v1/orgs/:orgId/source-sync-actions`
- `POST /v1/orgs/:orgId/source-sync-actions/:actionId/redrive`

### Internal worker endpoints

Protected by workload identity/mTLS, not user sessions:

- `POST /internal/resolution-jobs/claim`
- `POST /internal/resolution-jobs/:jobId/heartbeat`
- `POST /internal/resolution-jobs/:jobId/assertions`
- `POST /internal/resolution-jobs/:jobId/complete`
- `POST /internal/resolution-authority/authorize`
- `POST /internal/source-sync/claim`
- `POST /internal/source-sync/:actionId/complete`

There is deliberately no public `mark-verified`, `close-as-fixed`, or merge endpoint. Commands use `Idempotency-Key`; mutable resources use ETags; browser mutations retain CSRF protection; raw evidence requires an elevated scope and emits `redaction.raw_access`.

## (6) UI/DASHBOARD SURFACE

Add a top-level **Self-Healing** surface. The current Inbox shows candidate triage and, at most, one resolved spec link in [InboxBody.tsx](/home/trevor/projects/tanren/services/dashboard/src/components/inbox/InboxBody.tsx:102). The replacement should preserve Inbox as intake while adding the causal back half.

### Operator views

- **Fleet funnel:** reported → reproduced → triaged → coding → gated → queued → merged → deployed → verifying → source-sync pending → verified closed.
- **Loop detail:** a causal graph connecting source revisions, triage task, spec origins, runs, agents, gate, MergeAuthority decision, PR/merge SHA, artifact, deploy, assertions, repair attempts, and provider close/readback.
- **Truth badges:** separate `gate green`, `merged`, `deploy ready`, `demo passed`, `symptom verified`, and `source closed`. Never collapse them into one green state.
- **Before/after evidence:** old/new screenshots, DOM/JSON diff, trace/HAR, telemetry window, counterfactual result, and exact artifact identity.
- **Contract editor:** human-readable persona/Given/When/Then plus executable steps/assertions, target identity, proof grade, and destructive-action policy.
- **Repair lineage:** first cosmetic false-green, failed live assertion, successor repair, changed hypothesis/model, and eventual successful evidence.
- **DAG integration:** source/loop badges on every issue-origin node. The API already forwards the limited current triage provenance in [projectDag.ts](/home/trevor/projects/tanren/services/dashboard/src/api/projectDag.ts:100); render the normalized origin graph instead.
- **Queue health:** entity-scoped production barriers, contracts attached to each integration batch, preview outcomes, and bisect status.
- **Source health:** webhook delivery latency, reconciliation drift, signature failures, dead letters, provider rate limits, and close/reopen outbox state.
- **Controls:** steer, pause, retry, approve a destructive probe, change proof policy, route a repair, or issue an explicit waiver.
- **Metrics:** verified-fix rate, first-pass live success, false-green catches, median time to reproduction/verification, repair depth, recurrence rate, provider-sync delay, live-verification flake rate, and cost per verified resolution.

### Exportable and validateable artifact

Export:

- `tanren-resolution-proof.v1.json`
- Its public JSON Schema.
- A signed canonical envelope containing hashes of all inputs and evidence.
- An optional archive with redacted screenshots, traces, HAR, JUnit, and telemetry receipts.

A `tanren proof verify <file>` command validates schema, signatures, hash links, event ordering, authority versions, merge/deployment identity, assertion completeness, and source readback. The default export contains hashes and redacted evidence only; raw sensitive artifacts require separate authorization.

## (7) APEX-PROVABILITY

The existing hermetic apex issue proof maps an in-memory webhook, creates a synthetic triage result, and directly lands through the fake code host in [apexE2eDriver.drive.ts](/home/trevor/projects/tanren/services/orchestrator/tests/apexE2eDriver.drive.ts:188). Its proof stops at `mergedPrUrl` in [apexE2eDriver.ts](/home/trevor/projects/tanren/services/orchestrator/tests/apexE2eDriver.ts:119). Extend it through the real back half.

### The decisive planted scenario

Plant a live bug that returns HTTP 200 but has an incorrect user-visible semantic or visual result—for example, a mobile checkout CTA is still clipped and unclickable at a specified viewport. The current reachability smoke and generic demo should remain green.

Then drive:

1. Deliver a correctly signed real webhook twice with the same delivery ID.
2. Persist exactly one finding and one issue loop.
3. Run the exact browser/DOM/visual contract against the old live artifact; it fails as reported.
4. Triage creates a fully tagged spec with a real triage task and source finding.
5. The first Writer makes a cosmetic but ineffective fix.
6. Native gate passes, `MergeAuthority` lands it, and the exact commit deploys.
7. The original live contract still fails.
8. `ResolutionAuthority` blocks closure.
9. If the provider auto-closed, Tanren reopens it and posts the failed-live evidence.
10. A P0 successor repair spec enters `DagWalker`; the original spec remains merged.
11. A different hypothesis/route fixes the real cause.
12. Gate, queue, `MergeAuthority`, and deploy run again.
13. The new artifact passes while the retained old artifact still fails.
14. Required invariants/soak pass.
15. `ResolutionAuthority` authorizes closure.
16. Source adapter closes the issue and reads the closed state back.
17. Crash and restart a worker between verification and source sync; startup reconciliation completes exactly once.

### Required events

Existing gate/merge/deploy/demo events already live in the typed registry in [registry.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/events/registry.ts:303). Add:

```text
source.finding.recorded
issue_loop.opened
issue_loop.source_revision_observed
symptom.contract.authored
symptom.baseline.started
symptom.baseline.observed
triage.started
triage.completed
spec.origin.linked
remediation.attempt.started
preview.verification.started
preview.verification.passed|failed|inconclusive
deployment.artifact.bound
symptom.verification.started
symptom.assertion.recorded
symptom.verification.passed|failed|inconclusive
symptom.soak.completed
resolution.authorized|blocked|needs_attention
issue_loop.reopened
remediation.repair_routed
source_issue.sync.enqueued|succeeded|failed|drifted
issue_loop.verified
resolution.proof.sealed
```

Every event is appended through `PgEventStore`; no direct insert path is permitted.

### Proof bundle chain

The sealed proof must hash-link:

```text
webhook delivery + signature metadata
→ source finding + provider revision
→ issue loop
→ triage task + model/token/cost records
→ immutable symptom contract + baseline evidence
→ spec origin + writer/checker/auditor/design-oracle evidence
→ .tanren/ci.yml hash + gate/JUnit artifacts
→ MergeAuthority audit ID + exact merge SHA
→ deployment ID + source SHA + artifact digest + live surface
→ production assertions/screenshots/traces
→ ResolutionAuthority decision
→ provider close receipt + authoritative readback
```

### Apex assertions

The test must prove:

- Duplicate webhook delivery creates no duplicate finding, loop, or spec.
- Exactly two remediation attempts and two merged PRs occurred.
- No source-close success exists between the first merge and failed production verification.
- The first green gate was correctly identified as a false green for the reported symptom.
- Exactly one successor repair was routed for the first failed evidence signature.
- The original merged spec was never reopened or rewritten.
- The final deployed artifact—not merely a preview—passed the original contract.
- The old artifact still failed, or the proof grade explicitly records why a counterfactual was unavailable.
- Exactly one provider close succeeded and readback confirmed it.
- Worker restart, source API failure, and notification loss do not strand the loop.
- Cross-org reads of the loop, verification, evidence, or outbox rows return zero/deny.
- Probe infrastructure failure cannot close the issue or blame the patch.
- A speculative batch failure maps to the correct integration node and can be bisected.

Validation layers should include adapter conformance suites, state-machine/property tests, RLS integration tests, crash/fault injection, the expanded hermetic apex driver, and a live Fly/source-provider burn-in.

## (8) EFFORT + PHASING

“MVP” must mean a complete closed loop. Webhook ingestion plus auto-PR without production replay is not an MVP for this capability.

| Phase | Scope | Rough size |
|---|---|---:|
| P0 — truth and provenance foundation | Normalize issue loops/findings, fix external provenance, make triage a real task, harden webhook uniqueness/claims/reconciliation, source lifecycle revisions, basic UI origin badges. | 6–10 specs; 8–14k production/test/doc LOC; 6–10 engineer-weeks |
| P1 — closed-loop MVP | GitHub/manual sources, Fly deployment binding, HTTP/JSON and Playwright DOM contracts, baseline reproduction, production verification, `ResolutionAuthority`, close/reopen outbox/readback, P0 repair routing, minimal proof bundle/UI. | 14–20 specs; 22–35k LOC; 20–30 engineer-weeks |
| P2 — rich runtime proof | Full Given/When/Then loading, visual/a11y/trace evidence, A1/A3 runtime-verification reuse, preview/canary checks, counterfactual retention, verification fragments and F2 authoring. | 14–22 specs; 20–35k LOC; 20–30 engineer-weeks |
| P3 — comparator breadth | Sentry, Linear, Jira, Slack/generic, SARIF/CodeQL, dependency/advisory sources, Renovate/Dependabot-equivalent policy, observational/hybrid soak. | 18–28 specs; 25–45k LOC; 22–34 engineer-weeks |
| P4 — owned-stack apex | Batch symptom verification and bisect, entity health barriers, progressive rollout/rollback, cross-repo issue loops, failure-aware model routing, organization fix-efficacy learning, signed certificates. | 18–30 specs; 30–50k LOC; 28–42 engineer-weeks |
| P5 — production hardening | Chaos/restart tests, source drift reconciliation, privacy/retention tooling, proof CLI, fleet analytics, live provider conformance, long-running apex burn-in. | 10–16 specs; 10–18k LOC; 12–20 engineer-weeks |

Total ideal scope is approximately **80–125 specs, 115–195k production/test/documentation LOC, and 108–166 engineer-weeks**. A four-to-five-engineer team could reach the genuine MVP in roughly 10–14 calendar weeks. The full system is plausibly six to nine months for six to eight engineers, including live burn-in and serialized shared-file work.

Dependencies:

- A1/A3 runtime probe, identity, screenshot/trace, and evidence contracts.
- Exact deploy artifact digest/attestation support; current direct deploy only has a provider/reference string.
- Preview/canary/promote/rollback extensions to deploy adapters.
- DesignContract, personas, and complete Given/When/Then loading.
- F2 verification-fragment contracts and org fragment persistence.
- Object storage, signing keys, evidence encryption, and retention jobs.
- Source credentials and sandbox test organizations for GitHub/Sentry/Linear/Jira.
- Shared event registry/codegen, migrations, dashboard nav/screens, and API contracts.

Implementation should use isolated roadmap worktrees with declared path ownership. DB migrations, event constraints, dashboard navigation, `screens.ts`, and other shared wiring must be serialized. Each spec should run the narrow affected check while editing, followed by `just fast-check`, `just ci`, and `just smoke`; infrastructure phases also require the compose and connectivity smoke. Any new dependency or provider/image pin needs upstream version verification before change.

## (9) RISKS/UNKNOWNS

| Risk or unknown | Required mitigation |
|---|---|
| A faulty oracle produces false confidence | Mandatory old-live baseline, immutable contract hash, independent probe implementation, counterfactual old-artifact replay, proof grades, and explicit contract-version history. |
| The report is vague or unreproducible | Keep the issue open in `awaiting_reproduction`; request evidence, author an observational contract, or route to an investigation spec. Never infer fixed. |
| Intermittent symptoms | Statistical sample/window policy, seeded inputs, regional cohorts, active plus passive evidence, and confidence thresholds. Silence alone is not proof. |
| Production probes cause side effects | Dedicated test tenant/principal, idempotent fixtures, cleanup assertions, route/method allowlists, spend/destructive bounds, and explicit approval for dangerous flows. |
| Exact artifact identity is unavailable | Extend providers/builders to return OCI/package/store digests and attestations. Downgrade proof grade rather than fabricate identity. |
| Cache, CDN, rollout, or multi-region skew | Bind evidence to region, route, release cohort, response headers, and settle policy; verify more than one edge when required. |
| Authentication hides the real product | Use managed synthetic identities and least-privilege session minting. A 401/403 may prove reachability but never the symptom. |
| Prompt injection from issue bodies/logs | Treat source text as untrusted structured data, isolate it from standing instructions, constrain network/tool access, redact secrets, and require adapter-normalized fields. |
| PII in screenshots, traces, or raw payloads | Pre-storage redaction where possible, envelope encryption, short retention, region policy, elevated raw access, and auditable deletion. |
| Human/provider closes or edits an issue during execution | Revision/ETag checks, desired-versus-observed state, provider readback, superseding source revisions, and conflict-visible reconciliation. |
| External source APIs are unavailable or rate-limited | Durable outbox, provider idempotency keys, progress-aware retry, reconciliation, and `verified_source_sync_pending` rather than a false closed state. |
| Hot autonomous repair loops burn budget | Evidence-signature fixed-point detection, required new hypothesis/decomposition, budget governance, model escalation, and `needs_attention` when no new information appears. No arbitrary “three attempts” cap. |
| Rollback is unsafe after schema/data migration | Separate traffic rollback from code/data rollback, require forward-compatible migrations, encode rollback safety in the contract, and escalate irreversible cases. |
| A batch contains several plausible causes | Bind contracts to integration nodes, run batch previews, use semantic entity claims, and invoke native bisect before blaming a spec. |
| Source adapters disagree on “resolved” semantics | Provider-specific adapter implementation behind a common desired/observed contract and a shared conformance suite. |
| Mobile/store/manual surfaces cannot be actively probed | Use device-farm or channel adapters where available; otherwise label evidence `attested`, never `active_causal`. |
| Push webhooks are lost | Push plus periodic provider reconciliation; never make webhook configuration disable the backstop. |
| System-scope code accidentally crosses tenants | System scope only discovers IDs; all processing enters org scope. Add composite-org foreign keys, RLS conformance, and cross-org apex assertions. |
| Signing key compromise or proof retention cost | Rotatable versioned signing keys, transparency/audit log, evidence tiering, lifecycle deletion, and verification that remains valid after media expiry via hashes. |
| Comparator/provider behavior changes | Version adapter capabilities, run scheduled conformance against provider sandboxes, and verify every dependency/image/API pin against upstream before updates. |
| UI overstates certainty | Distinct visual states for gate, merge, readiness, demo, live symptom, proof grade, and external source readback. A waiver must never render as verified. |
| A1/A3 contracts are not yet stable enough | Freeze their probe/evidence interfaces before P1, or isolate them behind `SymptomProbeAdapter`; avoid parallel bespoke browser stacks. |
| Live environment retention for counterfactuals is expensive | Retain prior verified artifacts or create reproducible ephemeral deployments; if unavailable, record the weaker proof grade honestly. |
| Scope is operationally large | Keep the architecture contract-first and adapter-driven, ship the genuine GitHub/Fly closed-loop MVP, then expand sources and modalities without weakening the authority boundary. |

The ambitious cost is justified because this is the point where Tanren stops being an auto-PR generator and becomes an autonomous engineering system that can prove—rather than merely claim—that it repaired the live product.
