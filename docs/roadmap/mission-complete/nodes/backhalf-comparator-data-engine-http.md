> Continuation of the backhalf bucket. Section (1) ideal design lives in [`backhalf.md`](./backhalf.md).
> This file holds §2 comparator parity, §3 data model, §4 engine integration, and §5 HTTP surface.

## (2) COMPARATOR PARITY MATRIX

This inventory covers the documented remediation and workflow surfaces in the official comparator documentation reviewed on 2026-07-13. “Matches” and “exceeds” describe the proposed ideal, not current shipped state.

The cross-comparator conclusion is an inference from those official docs: each tool documents part of triage, code generation, PR creation, merge automation, deployment, or passive recurrence detection; none documents an artifact-bound report → fix → authoritative merge → production deploy → active replay of the original symptom → reopen/repair loop.

| Comparator capability                                                                                                                                                                                                                         | How Tanren matches it                                                                                                                | How Tanren EXCEEDS it                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sentry — error intake, grouping, releases, environments, issue lifecycle ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/), [issue states](https://docs.sentry.io/product/issues/states-triage/))                                    | Sentry adapter normalizes groups/events/releases/environments into source findings and issue loops.                                  | Active reproduction is bound to the affected environment and exact artifact; grouping becomes one input to the oracle, not the closure criterion.                   |
| Sentry — automated issue scan and actionability assessment ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/))                                                                                                                        | Triage Answerer ranks actionability, severity, affected behaviors, likely entities, and routability.                                 | It must also author or select a reproducible `SymptomContractV1`; “actionable” without a testable symptom cannot autonomously close.                                |
| Sentry — automatic scan thresholds and configurable stopping points ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/))                                                                                                               | Per-source policies choose triage-only, RCA, proposed fix, PR, auto-merge eligibility, or closed-loop repair.                        | Policy controls proof grade and live-close authority independently from code-generation autonomy.                                                                   |
| Sentry — RCA from stack traces, traces, logs, profiles, commits, deploys, and code ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/))                                                                                                | Finding enrichment stores those signals and injects them into triage, planner, checker, and auditor tasks.                           | The system tests the hypothesis against live before/after artifacts and feeds failed hypotheses back into the next repair.                                          |
| Sentry — interactive investigation and multi-repository context ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/))                                                                                                                   | Forge conversation can refine source context, inspect multiple project repositories, and split a fix into a cross-repository DAG.    | Cross-repository specs share one issue loop and resolution contract; resolution waits for every required deployed component rather than the first PR.               |
| Sentry — asynchronous fix steps, continuation, retries, user context, and inspectable state ([start API](https://docs.sentry.io/api/seer/start-seer-issue-fix/), [state API](https://docs.sentry.io/api/seer/retrieve-seer-issue-fix-state/)) | Durable triage/remediation/verification attempts expose state, progress, inputs, retries, and steering.                              | Attempts survive worker restarts through claims and startup reconciliation, and state continues through merge, deploy, production replay, and source readback.      |
| Sentry — root cause, solution, code changes, PR iteration, open PR, coding-agent handoff ([start API](https://docs.sentry.io/api/seer/start-seer-issue-fix/))                                                                                 | Writer/checker/auditor/design-oracle loops produce patches, tests, PRs, and follow-up iterations.                                    | Handoff remains inside one typed DAG and one cost/provenance chain; the fix is not trusted until live falsification succeeds.                                       |
| Sentry — anomaly/spike/crash-loop investigation and collaboration                                                                                                                                                                             | Scheduled and webhook-driven telemetry findings can create loops, notify operators, and invoke specialized triage agents.            | Tanren can plant an active probe, deploy a canary fix, compare old/new cohorts, and automatically route another repair if the anomaly persists.                     |
| Sentry — resolve by commit/release and mark regression when telemetry recurs ([issue states](https://docs.sentry.io/product/issues/states-triage/))                                                                                           | Source adapter records commit/release association and consumes regression/reopen events.                                             | Resolution waits for active production proof; recurrence is a secondary soak signal. A failed immediate replay reopens before users need to generate another event. |
| Sentry — privacy, access, and source-context controls ([Seer](https://docs.sentry.io/product/ai-in-sentry/seer/))                                                                                                                             | Org-scoped credentials, redacted evidence, least-privilege probes, retention policy, and raw-access audit events.                    | Every evidence object and model invocation is org-scoped, content-addressed, policy-redacted, and tied to the resolution decision that consumed it.                 |
| GitHub Copilot Autofix — CodeQL alert/SARIF intake, data-flow locations, query help ([Autofix concept](https://docs.github.com/en/code-security/concepts/code-scanning/copilot-autofix-for-code-scanning))                                    | SARIF/CodeQL source adapter produces structured findings with rule, flow, locations, severity, and CWE metadata.                     | Static evidence becomes one assertion in a broader contract that can also prove exploit behavior or live security invariants after deployment.                      |
| Copilot Autofix — explanations and suggested fixes ([Autofix concept](https://docs.github.com/en/code-security/concepts/code-scanning/copilot-autofix-for-code-scanning))                                                                     | Triage/planner explains cause and proposed correction; writer produces the patch.                                                    | Independent checker, auditor, security auditor, native gate, preview exploit probe, and production invariant all challenge the suggestion.                          |
| Copilot Autofix — draft PR creation and REST-driven fix generation ([resolve alerts](https://docs.github.com/en/enterprise-cloud@latest/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts))             | API-triggered loops can create a draft PR and expose attempt state.                                                                  | PR creation is merely one event in a durable, restart-safe resolution loop with merge and production evidence.                                                      |
| Copilot Autofix — assignment to a cloud coding agent ([resolve alerts](https://docs.github.com/en/enterprise-cloud@latest/code-security/how-tos/manage-security-alerts/manage-code-scanning-alerts/resolve-alerts))                           | Provider/model routing can assign a suitable Writer while Answerers remain filesystem-isolated.                                      | Tanren can switch agent/model/hypothesis after a live failure while retaining one issue-loop identity and evidence history.                                         |
| Copilot Autofix — language/query support and repository administration ([Autofix concept](https://docs.github.com/en/code-security/concepts/code-scanning/copilot-autofix-for-code-scanning))                                                 | Adapter capabilities declare supported rules/languages and fail closed when a rule cannot be remediated automatically.               | The fragment/F2 system can author missing runtime-specific verification support instead of limiting the loop to a fixed language list.                              |
| Copilot Autofix — CodeQL rerun closes a fixed alert ([GitHub tutorial](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/finding-and-fixing-your-first-code-vulnerability))                                         | Native gate reruns CodeQL/SARIF checks on the exact integration SHA.                                                                 | Static disappearance authorizes merge eligibility, not resolution; production exploit/invariant checks and artifact identity authorize closure.                     |
| Copilot Autofix — best-effort, potentially partial or incorrect suggestions ([responsible-use documentation](https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/about-autofix-for-codeql-code-scanning))    | Findings remain untrusted until checked, audited, gated, and tested.                                                                 | A wrong-but-green patch is detected by the old-fails/new-passes live contract and automatically routed into another repair.                                         |
| Copilot Autofix — human review and secure-development controls ([responsible-use documentation](https://docs.github.com/en/code-security/code-scanning/managing-code-scanning-alerts/about-autofix-for-codeql-code-scanning))                 | Project policy can require review/HITL before `MergeAuthority` authorizes landing.                                                   | Review posture and resolution posture are separate: a human-approved merge still cannot falsely close a failed production symptom.                                  |
| Renovate — broad managers, datasources, platforms, package files, lockfiles, and digests ([how it works](https://docs.renovatebot.com/key-concepts/how-renovate-works/), [managers](https://docs.renovatebot.com/modules/manager/))           | Dependency-source adapters and upgrade fragments cover manifests, lockfiles, images, actions, digests, and generated/vendor outputs. | F2 can author an org-specific dependency manager plus its conformance fixture; the deployed product contract validates the update’s actual behavior.                |
| Renovate — private registries, host rules, custom managers/datasources ([configuration](https://docs.renovatebot.com/configuration-options/))                                                                                                 | Org secret grants and adapters support private registries and custom source discovery.                                               | Registry credentials never enter prompts; verification runs with separate least-privilege runtime identities and org-scoped audit evidence.                         |
| Renovate — pin, digest, replacement, rollback, lockfile maintenance, and post-upgrade work ([configuration](https://docs.renovatebot.com/configuration-options/))                                                                             | Upgrade specs encode the exact mutation and generated-file/post-upgrade commands in `.tanren/ci.yml`.                                | Rollback is based on production symptom regression and known-good artifact identity, not just a version comparison.                                                 |
| Renovate — `packageRules`, versioning, range strategies, allow/ignore policy ([configuration](https://docs.renovatebot.com/configuration-options/))                                                                                           | Typed org/project dependency policy compiles findings into permitted upgrade specs.                                                  | Policy also includes behavior/entity blast radius, deployment cohort, proof grade, and automatic rollback eligibility.                                              |
| Renovate — grouping, monorepo grouping, and dependency coupling ([configuration](https://docs.renovatebot.com/configuration-options/))                                                                                                        | Forge derives grouped or separate upgrade specs and dependency edges.                                                                | The native integration-node queue can empirically discover incompatible groups through preview verification and bisect them.                                        |
| Renovate — schedules, time zones, branch/PR limits, concurrency ([configuration](https://docs.renovatebot.com/configuration-options/))                                                                                                        | DagWalker priorities, budgets, provider capacity, release windows, and project concurrency govern execution.                         | Scheduling can account for current production health and hold only upgrades touching an unhealthy entity or behavior.                                               |
| Renovate — Dependency Dashboard, approvals, pending/deferred/ignored/deprecated/abandoned items ([Dependency Dashboard](https://docs.renovatebot.com/key-concepts/dashboard/))                                                                | Self-Healing Center exposes queued, deferred, ignored, blocked, dead-lettered, and approval-required loops.                          | It also shows baseline/live evidence, false-green catches, repair ancestry, exact deployed artifact, and source-sync state.                                         |
| Renovate — minimum release age ([minimum release age](https://docs.renovatebot.com/key-concepts/minimum-release-age/))                                                                                                                        | Policy can delay an upgrade until a release matures.                                                                                 | Tanren can additionally run staged canaries and advance only when the application’s own behaviors remain verified.                                                  |
| Renovate — merge confidence based on age, adoption, and public CI ([merge confidence](https://docs.renovatebot.com/merge-confidence/))                                                                                                        | External confidence contributes to prioritization and auto-merge policy.                                                             | Org-local evidence dominates: historical outcomes for this entity, stack, fragment set, tests, production traffic, and exact runtime.                               |
| Renovate — vulnerability remediation and priority handling                                                                                                                                                                                    | Vulnerability sources create P0 upgrade specs and can bypass ordinary scheduling.                                                    | Tanren proves the vulnerable behavior or security invariant on preview/production and can quarantine impacted queue entities until verified.                        |
| Renovate — rich PRs, release notes, changelogs, labels, reviewers                                                                                                                                                                             | PR projection includes provenance, release context, risk, tests, reviewer routing, and proof links.                                  | After closure, the PR links to a signed resolution certificate showing what users actually received.                                                                |
| Renovate — rebasing/recreation and branch freshness ([automerge](https://docs.renovatebot.com/key-concepts/automerge/))                                                                                                                       | jj rebases onto shifting bases, preserves conflicts, restacks descendants, and re-gates.                                             | Conflict resolution has both dependency intent and affected behavior contracts; no work is discarded.                                                               |
| Renovate — PR/branch/platform/comment automerge, merge strategies, merge queue, branch-on-pass behavior ([automerge](https://docs.renovatebot.com/key-concepts/automerge/))                                                                   | Native queue supports autonomous land, review policies, speculative batch checking, and bisect; only `MergeAuthority` lands.         | No external platform automerge can bypass Tanren’s decision, and auto-merge is followed by artifact-bound production verification and repair.                       |
| Renovate — noise/failure controls and selective PR creation                                                                                                                                                                                   | Fold duplicates by source fingerprint, group compatible work, and surface fixed points/dead letters.                                 | “No PR needed” and “green PR” are distinct from “verified fixed”; suppressed noise never suppresses a live regression.                                              |
| Dependabot — dependency alerts and minimum patched security updates ([security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates))                                                 | Advisory adapters produce P0 findings and compute permitted patched versions.                                                        | Tanren chooses among permitted fixes using application-specific live evidence, not version metadata alone.                                                          |
| Dependabot — version updates across ecosystems, private registries, vendored dependencies ([options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference))                        | Upgrade fragments and secret-backed adapters support equivalent update surfaces.                                                     | Missing ecosystem support is F2-authored and conformance-tested; deployment verifies the resulting product.                                                         |
| Dependabot — allow/ignore rules, direct/indirect scope, update types, semver/ranges ([options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference))                              | Typed dependency policy matches these selectors and routes them into specs.                                                          | Policy adds affected behavior/entity, rollout safety, proof grade, and historical fix efficacy.                                                                     |
| Dependabot — groups and multi-ecosystem groups ([multi-ecosystem updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/multi-ecosystem-updates))                                                                   | Forge emits cross-ecosystem grouped DAG nodes.                                                                                       | Speculative integration runs prove the entire upgrade set together and native bisect isolates the incompatible member.                                              |
| Dependabot — schedules, cooldowns, open-PR limits ([options reference](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference))                                                                | DagWalker and project policy provide equivalent cadence, priority, capacity, and budget governance.                                  | Production health dynamically gates risky updates; security findings may bypass cadence but never verification.                                                     |
| Dependabot — auto-triage predicates such as severity, package, CVE/CWE, scope, and EPSS ([auto-triage rules](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-auto-triage-rules))                           | Source triage rules combine advisory metadata with model analysis.                                                                   | Rules can require an active exploit/invariant baseline, entity blast radius, DesignContract impact, and production proof.                                           |
| Dependabot — dismiss, snooze, reopen, open-PR actions; org rules, audit, API/webhook visibility ([auto-triage rules](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-auto-triage-rules))                   | Issue-source adapters support equivalent lifecycle commands, durable receipts, and org policies.                                     | Every action is tied to a causal loop and read back from the provider; source drift is reconciled rather than assumed.                                              |
| Dependabot — PR vulnerability context, release/changelog information, compatibility score ([Dependabot PRs](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/dependabot-pull-requests))        | PR projection includes advisory, compatibility, change, and test information.                                                        | Compatibility is measured on the organization’s actual composed product and live deployment.                                                                        |
| Dependabot — rebase/recreate/ignore commands and inactivity behavior ([Dependabot PRs](https://docs.github.com/en/enterprise-cloud@latest/code-security/concepts/supply-chain-security/dependabot-pull-requests))                             | Dashboard commands steer, regenerate, pause, supersede, or dismiss an upgrade loop.                                                  | The command history, agent consequences, deployment, and final proof remain in one event chain.                                                                     |
| Dependabot — metadata-driven auto-merge composed with branch protection/merge queue ([automation tutorial](https://docs.github.com/en/code-security/tutorials/secure-your-dependencies/automating-dependabot-with-github-actions))            | Native policy consumes update metadata, gates, reviews, and queue state without GitHub Actions.                                      | `MergeAuthority` is the non-bypassable decision; successful merge does not close the alert until the live contract passes.                                          |
| Dependabot — merged update resolves the alert ([security updates](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependabot-security-updates))                                                                       | Source adapter associates merge and release with the finding.                                                                        | Closure requires deployed artifact identity plus active security/application verification; failure reopens and creates another upgrade/repair spec.                 |
| Devin — general autonomous code investigation and implementation                                                                                                                                                                              | Writer agents inspect code, change files, execute commands, and produce PRs; Answerers independently check completion.               | The surrounding engine, not the agent, controls the immutable oracle, merge decision, deployment, closure, and repair recurrence.                                   |
| Devin — Slack, GitHub, Linear, API/CLI and integration surfaces ([integrations](https://docs.devin.ai/integrations/overview))                                                                                                                 | Source adapters and HTTP APIs accept equivalent triggers and expose loop state.                                                      | Every channel maps to one deduplicated issue loop rather than spawning disconnected sessions.                                                                       |
| Devin — scheduled/custom-webhook automations, conditions, new or persistent sessions ([automations](https://docs.devin.ai/product-guides/automations))                                                                                        | Trigger policies can create, resume, or reconcile a loop from webhook, schedule, manual/API, or telemetry events.                    | Persistent state is a typed Postgres aggregate plus event stream, not merely agent memory.                                                                          |
| Devin — persistent auto-triage, dedupe/noise filtering, child issues, owner routing, scratchpad ([auto-triage](https://docs.devin.ai/product-guides/auto-triage))                                                                             | Triage tasks deduplicate, decompose, assign ownership, and preserve structured reasoning.                                            | Child specs form a real dependency DAG; closure waits for the deployed behavior spanning every required child.                                                      |
| Devin — shell, IDE, browser, and codebase investigation ([session tools](https://docs.devin.ai/work-with-devin/devin-session-tools))                                                                                                          | Runner containers expose appropriate tools through Writer adapters.                                                                  | Production probes use separate constrained identities and adapter contracts; writer browser activity cannot forge resolution evidence.                              |
| Devin — knowledge, playbooks, skills, secrets, and MCP integrations                                                                                                                                                                           | Fragment libraries, F2, project context, managed credentials, and adapter contracts provide reusable expertise.                      | Verification fragments are versioned, hashed, conformance-tested, and included in the proof bundle.                                                                 |
| Devin — budgets, rate limits, network controls, permissions                                                                                                                                                                                   | Tanren governs provider capacity, spend, network policy, credentials, and human review.                                              | Budget is tracked through the entire loop, including triage, failed live verification, repair, deployment, and source synchronization.                              |
| Devin — test/lint/typecheck, fix iteration, PR creation, and bot-feedback handling                                                                                                                                                            | The Writer loop runs checks; checker/auditor/native gate and review feedback route rework.                                           | The same issue can survive multiple merged PRs until the production symptom is actually gone.                                                                       |
| Devin — automated review, bug/security findings, chat, suggested changes ([Devin Review](https://docs.devin.ai/work-with-devin/devin-review))                                                                                                 | Review Answerers produce structured findings and suggested repairs.                                                                  | Findings enter `MergeAuthority` posture and may also become source findings with their own live contracts.                                                          |
| Devin — end-to-end test plan, browser execution, video/annotation against local/dev/staging ([testing and recordings](https://docs.devin.ai/work-with-devin/testing-and-recordings))                                                          | Preview verification records trace, screenshots/video, assertions, and critical flow evidence.                                       | The same locked test runs automatically after merge against the exact production artifact; a short PR-time recording cannot substitute for it.                      |
| Devin — parallel sessions and activity history                                                                                                                                                                                                | DagWalker runs independent/speculative work concurrently and events expose every transition.                                         | Native dependency edges, integration nodes, jj restacking, queue ordering, and production barriers coordinate the sessions causally.                                |
| Devin — deployment assistance ([deployment capabilities](https://docs.devin.ai/product-guides/deployment-capabilities))                                                                                                                       | Deploy adapters provision/bind, trigger, verify, promote, rollback, and resolve the user-facing surface.                             | Deployment is a typed engine stage with exact artifact identity, canary progression, live assertions, and automatic repair/rollback.                                |
| Devin — merge/automerge through the repository platform                                                                                                                                                                                       | Review policy and `MergeAuthority` can autonomously land approved work.                                                              | The host is only the landing surface; it cannot bypass the native gate, queue, merge authority, resolution authority, or production proof.                          |
| All comparators — auto-triage plus auto-PR                                                                                                                                                                                                    | Tanren matches automated intake, RCA, code changes, tests, PRs, review, and merge automation.                                        | Tanren owns the missing back half: baseline symptom → exact merge → exact deploy → active live replay → reopen/repair or evidence-backed closure.                   |

## (3) DATA MODEL

The latest migration is currently `0032`; the following should use the next available serial numbers and be serialized because migrations are shared paths.

| Entity                       | Purpose and key invariants                                                                                                                                                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `issue_loops`                | `id`, `org_id`, `project_id`, `source_id`, external key, generation, fingerprint, severity, state, source revision, current contract/attempt, resolution policy, optimistic `row_version`. Unique `(org_id, source_id, external_key, generation)`.    |
| `source_findings`            | Immutable normalized source observations: provider object ID/revision, delivery, status, release/environment, title/body/context, fingerprint, observed timestamp, raw-artifact reference. Never overwrite prior revisions.                           |
| `issue_loop_edges`           | `duplicate_of`, `supersedes`, `regression_of`, `caused_by`, and `split_from` relationships.                                                                                                                                                           |
| `symptom_contracts`          | Immutable `SymptomContractV1` JSON, schema version, canonical hash, proof policy, target, fragment versions, source revision, author task, lifecycle state, and baseline requirement.                                                                 |
| `symptom_contract_fragments` | Exact fragment IDs, versions, content hashes, and conformance result used to execute a contract.                                                                                                                                                      |
| `spec_origins`               | Normalized link from a spec to issue loop, triage task, attempt number, and role: `primary_fix`, `repair`, `rollback`, `probe_capability`, or `followup`.                                                                                             |
| `spec_origin_findings`       | Many-to-many link between specs and immutable source findings; removes the array-only provenance ceiling.                                                                                                                                             |
| `remediation_attempts`       | Loop iteration, hypothesis, spec/run/PR, agent route, integration node, gate evidence, MergeAuthority audit ID, merge SHA, prior attempt, outcome, and failure signature.                                                                             |
| `release_instances`          | Provider/app/environment, deployment ID, immutable source SHA, OCI/package/store digest, build provenance, live URL/channel, region, previous verified release, state.                                                                                |
| `verification_runs`          | Contract, release, stage (`baseline`, `preview`, `production`, `soak`, `counterfactual`), proof grade, claim/lease, start/end, result, classification (`product_failure`, `infra_failure`, `stale_contract`, `inconclusive`), and observation window. |
| `verification_assertions`    | One row per assertion/invariant with expected/observed canonical hashes, outcome, timing, retry/sample data, and evidence references.                                                                                                                 |
| `evidence_artifacts`         | Content-addressed screenshots, traces, HAR, videos, JSON bodies, telemetry query receipts, stdout, JUnit, and attestation data; stores object URI, SHA-256, MIME, sensitivity, encryption key reference, retention, redaction status.                 |
| `resolution_decisions`       | Immutable fail-closed input snapshot/hash, outcome, reasons, authority version, contract/release/verification IDs, and audit ID.                                                                                                                      |
| `source_sync_outbox`         | Idempotent `comment`, `label`, `close`, `reopen`, or `link_release` action; desired source revision, attempt state, retry time, provider receipt, and readback result.                                                                                |
| `release_health_barriers`    | Entity/behavior/environment-scoped queue hold created by a verified regression; never a global project stop unless policy requires it.                                                                                                                |
| `webhook_delivery_claims`    | Lease/heartbeat/terminal state for durable delivery processing, or equivalent claim columns on `webhook_events`.                                                                                                                                      |

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

| Stage                   | Ideal integration                                                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Intake               | `IssueSourceAdapter` verifies the webhook, stores the delivery, fetches the authoritative source revision, and emits an immutable finding. Poll reconciliation remains enabled as a backstop.                                                                                      |
| 2. Loop allocation      | Dedupe by provider identity, source revision, fingerprint, and entity/behavior anchor. Create or append to an `IssueLoop`.                                                                                                                                                         |
| 3. Baseline             | A `ResolutionDagWalker` schedules the locked `SymptomContractV1` against the current live release. Product failure establishes the baseline; infrastructure failure remains inconclusive.                                                                                          |
| 4. Triage               | A first-class Answerer task selects persona/behavior/DesignContract context, likely entities, proof mode, dependency placement, and repair policy.                                                                                                                                 |
| 5. Spec insertion       | Create a P0/P1 spec with normalized origin links, compatible provenance columns, contract hash, and acceptance criteria that include repository regression coverage. Notify the existing `DagWalker`.                                                                              |
| 6. Agent loop           | Existing planner → Writer → checker → auditor → design oracle. The live-failure evidence is injected as immutable context. Writers cannot edit the resolution oracle.                                                                                                              |
| 7. Native gate          | `.tanren/ci.yml` remains the only CI gate. The repository regression test and normal evidence run over SSH; failures route through the existing writer self-heal in [plannerRunCi.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/plannerRunCi.ts:254). |
| 8. Preview verification | If the target supports previews/canaries, deploy the exact integration-node artifact and run the same symptom contract. Feed `demo: verified` into `MergeAuthority`; a required but unavailable preview is explicitly `unverified`, not `not_required`.                            |
| 9. Queue/merge          | The speculative/eager native queue runs every attached symptom contract for the integration batch. Failure invokes existing batch bisect. `MergeAuthority` alone authorizes the exact jj ref and CAS target.                                                                       |
| 10. Post-merge deploy   | Deploy the exact merge SHA; require a provider artifact digest/attestation in addition to the current provenance reference. Record environment, region, URL/channel, and previous verified artifact.                                                                               |
| 11. Runtime checks      | Run deploy readiness, the full generic Given/When/Then demo, the original symptom contract, non-regression invariants, and any required soak window. Reuse the A1/A3 runtime-verification ports and evidence formats rather than creating a second browser/probe stack.            |
| 12. Resolution          | `ResolutionAuthority` evaluates the immutable evidence. Success queues source closure; failure queues reopen/comment plus successor repair; uncertainty remains open and retries or escalates.                                                                                     |
| 13. Source readback     | Outbox worker performs the provider mutation idempotently and reads the issue state/revision back. Only then does the loop reach `verified_closed`.                                                                                                                                |
| 14. Recurrence          | New matching source findings reopen the loop as a new generation/attempt, attach the prior proof, and establish whether this is the same symptom or a new regression.                                                                                                              |

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

---

→ Continue to §6 through §9 in [`backhalf-ui-apex-phasing-risks.md`](./backhalf-ui-apex-phasing-risks.md).
