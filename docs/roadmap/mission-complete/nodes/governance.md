## (1) IDEAL DESIGN + how it fits the engine + the owned-stack advantages it exploits

Build a versioned Governance Control Plane that compiles every applicable rule into one immutable `EffectiveGovernanceBundle`, binds that bundle’s hash to every review, integration, gate, merge, deployment, demo, budget, and notification proof, and derives coverage from live evidence.

This should not be another collection of mutable fields in `ProjectConfigV2`. Today, governance is split across independent settings such as `governancePosture`, `reviewPolicy`, `auditPosture`, speculation depth, and budget ([projectConfig.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/config/projectConfig.ts:181)). Worse, the “policy version” used by review and deployment is the config schema literal `1` ([context.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/reviewMerge/context.ts:151)), and live MergeAuthority input currently carries an empty gate-config hash ([mergeAuthorityBundleBuild.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityBundleBuild.ts:122)). Those make policy-sensitive proof reuse and TOCTOU protection illusory.

Tanren already has the right substrate:

- Native, Action-less delivery with `.tanren/ci.yml` as the sole CI contract ([PROJECT_BRIEF.md](/home/trevor/projects/tanren/PROJECT_BRIEF.md:65), [schema.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/ci/schema.ts:192)).
- A fail-closed MergeAuthority intended to be the sole merge decision ([mergeAuthority.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/mergeAuthority.ts:1)).
- jj-native speculative/eager work and intent-aware conflict handling ([PROJECT_BRIEF.md](/home/trevor/projects/tanren/PROJECT_BRIEF.md:160)).
- Typed, org-scoped events through the single append seam ([eventStore.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/eventStore.ts:94)).
- Deterministic fragment composition where a missing fragment triggers F2 authoring and fails loudly ([fragments README](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/README.md:120)).
- Org-scoped transactional Postgres access using `SET LOCAL app.current_org_id` ([orgScope.ts](/home/trevor/projects/tanren/db/src/orgScope.ts:117)).

### Current F1–F5 diagnosis

| Area | CODE gap | Pure fixture/config/coverage gap | Ideal resolution |
|---|---|---|---|
| **F1 governance tiers** | No named tier, inheritance, immutable revision, effective-policy hash, rule coverage, CODEOWNER enforcement, protected deployment environment, freeze, or review quorum. A member can mutate `auditPosture` through generic project PATCH because it is omitted from the reserved governance fields ([projectConfigWriteGuards.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/projectConfigWriteGuards.ts:26), [projects route](/home/trevor/projects/tanren/services/orchestrator/src/routes/projects/index.ts:136)). Simulated review posts a `COMMENT` and drives the authoritative verdict internally; its forge publication is explicitly best-effort ([reviewPolling.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/reviewMerge/reviewPolling.ts:343), [reviewPolling.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/reviewMerge/reviewPolling.ts:450)). Repo visibility is not persisted on `projects` ([schemaCore.ts](/home/trevor/projects/tanren/db/src/schemaCore.ts:30)). | Private-repo creation transport and simulated-review execution exist. v96 simply did not prove private visibility, effective policy, a durable forge review ID/state, or the dashboard path. | Immutable tier revisions; private visibility as an enforced predicate; separate reviewer App identity posting actual `APPROVE`/`REQUEST_CHANGES`; strict publication acknowledgement; path/category quorums; `P3` zero-defect posture where required. |
| **F2 audit finding → NEW spec** | Rejected proposals can be stranded as `droppedSpecs`; route intent and spec creation are not atomic; routed specs get `dependsOn: []`; scheduled audits lack an immutable run/finding ledger; post-merge emits `auditor.findings_routed` without creating specs ([loopFindings.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/loopFindings.ts:128), [plannerRunTriageNewSpecs.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/plannerRunTriageNewSpecs.ts:89), [mergeLandPaths.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/reviewMerge/mergeLandPaths.ts:404)). | Real inline and scheduled routing paths exist, including provenance and deduplication ([scheduler.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/forge/audits/scheduler.ts:129), [schemaCore.ts](/home/trevor/projects/tanren/db/src/schemaCore.ts:95)). If v96’s 68 triages all selected task/fix-in-place and had no dropped spec, the zero-spec result is a bad coverage fixture. | Every finding gets exactly one durable disposition. A `new_spec` disposition atomically creates or reuses a quality-valid spec, real dependencies, lineage, enqueue intent, and proof event. |
| **F3 deep stacked chains** | Retargeting loads only the current spec’s direct `depends_on`, then applies that incomplete merged set to the full `ancestor_stack`. In a deep chain, already-merged transitive ancestors remain stale ([speculativeStackRetarget.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/reviewMerge/speculativeStackRetarget.ts:58), [speculativeStackRetarget.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/reviewMerge/speculativeStackRetarget.ts:108)). `integration_nodes` is still documented as observe-only ([schemaCore.ts](/home/trevor/projects/tanren/db/src/schemaCore.ts:383)). | `speculativeIntegrationDepth` is already configurable and defaults to two ([projectConfig.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/config/projectConfig.ts:244)); DagWalker computes transitive readiness. v96’s depth-two result is therefore partly a shallow live fixture. | Promote integration nodes to control-plane truth; resolve every retarget from the persisted transitive member vector; test chains of 6–10 plus diamonds/fan-in; bind every base shift to a new proof key. |
| **F4 budget pause** | `readyHeldBack` is always reported as zero ([walker.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/dag/walker.ts:251)); no pause episode, resume event, reservation, CAS policy revision, infra-cost ledger, or pre-call concurrency-safe admission exists. In-flight enforcement occurs only between whole iterations. Budget mutation is member-accessible rather than admin-only ([projects route](/home/trevor/projects/tanren/services/orchestrator/src/routes/projects/index.ts:172)). | The production config → budget gate → DagWalker → `dag.budget.paused` event path and UI exist. The apex driver only calls a pure pause predicate, so v96 never exercised the real path. | Typed budget envelopes, worst-case reservations before every spend-causing operation, settlement, persistent pause/resume episodes, accurate held spec IDs, soft/hard/forecast actions, agent plus infrastructure spend. |
| **F5 notification breadth** | Autonomous provisioning and UI add only ntfy. Slack provisioning stores a bot token while its sender expects an incoming webhook URL. There is no durable outbox/cursor, retry, lease, provider receipt, ack, escalation, or adapter conformance suite. `notification.*` events are defined but not emitted; the legacy delivery ledger remains outside RLS. | Nine channel kinds and nine production adapter classes already exist ([schemas.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/notifications/schemas.ts:18), [build.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/notifications/build.ts:74)). Thus “only ntfy fired” is also a target/credential/live-fixture gap. | Durable intents and attempts, channel-specific configuration/probes, receipt-aware semantics, acknowledgment/quorum/escalation policies, all-nine live apex coverage, and direct RLS on every delivery artifact. |

### The policy model

Policies should be composed as declarative, versioned fragments—not arbitrary generated TypeScript:

```yaml
apiVersion: tanren.dev/governance/v2
tier: regulated-autonomous
scope:
  repositoryVisibility: private
  refs: [main, "release/**"]

review:
  freshness: exact_head_sha
  dismissOnBaseShift: true
  requireForgePublication: true
  rules:
    - category: design
      principals: [{ kind: agent_profile, name: design-oracle }]
      approvals: 1
    - category: implementation
      principals: [{ kind: agent_profile, name: simulated-reviewer }]
      approvals: 2
      distinctFrom: [writer, last_pusher]

audit:
  blockReviewAt: P3
  residualDisposition: new_spec
  autonomousRemediation: true
  requireTerminalDisposition: true

integration:
  mode: speculative_eager
  maxUnmergedAncestorDepth: 8
  requireBaseShiftRegate: true

budget:
  hard:
    projectUsdMonthly: 500
    perSpecUsd: 50
  unknownCostAction: pause
  inFlightAction: finish_current_call

notifications:
  quorum: 2
  require:
    - pagerduty
    - slack
    - webhook
  acknowledgementWithin: 10m

deployment:
  production:
    approvals:
      - principal: release-agent
      - principal: on-call-team
    wait: 10m
    freezeCalendar: production

coverage:
  mode: enforcing
  maxEvidenceAge: 30d
  scenarios:
    - private_simulated_real_review
    - audit_finding_materializes_spec
    - stack_depth_6_with_base_shift
    - budget_pause_and_resume
    - required_notification_quorum
```

`blockReviewAt: P3` is the existing zero-defect semantic: every P0–P3 finding blocks ([auditPostureConfig.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/config/auditPostureConfig.ts:21)).

Compilation order should be:

`core invariants → org baseline → named tier → project/repository binding → ref/environment → path/entity/behavior risk → temporary freeze/bypass`

Rules aggregate most-restrictively unless a rule schema explicitly declares an overridable dimension and the actor has that authority. The compiler returns:

- Effective rule AST and deterministic `policyHash`.
- Source map explaining which revision supplied each rule.
- Required principals and separation-of-duty categories.
- Required gate, environment, budget, notification, and coverage evidence.
- Contradiction witnesses, not vague “invalid policy” errors.
- Host-protection projections and drift expectations.
- MergeAuthority and PromotionAuthority input schemas.

### Fragment/F2 integration

Extract a reusable fragment-composition kernel from the current template fragment implementation, while leaving template-specific phases in place. Governance fragments would live under a new `engine/governance/fragments` surface and follow the current guarantees: stable ID/version, dependencies, deterministic ordering, snapshot diff, and loud failure on a missing primitive. The current composer already treats fragments as the sole materialization path ([compose.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/compose.ts:154)).

When Forge derives a requirement not covered by the library:

1. Emit a missing `GovernanceFragmentSpec` from the personas, given/when/then behaviors, DesignContract entities, and risk classification.
2. Run the F2 per-fragment authoring DAG.
3. Require the author to produce the declarative rule, JSON schema, positive/negative conformance vectors, simulator snapshots, UI form schema, and compatibility declaration.
4. Gate and merge it normally.
5. Recompile the original project policy.
6. Do not activate an enforcing policy until conformance and shadow evaluation pass.

An F2 author may create combinations of existing safe primitives. A genuinely new enforcement primitive must become a Tanren implementation spec; generated policy data must never gain arbitrary code execution.

### Owned-stack advantages

Tanren can go far beyond repository rule products because it owns all causally adjacent systems:

- **Intent-aware ownership:** derive owners from DesignContract entities and behaviors, not only paths. A database migration can require the data-model reviewer even when generated code obscures the file match.
- **Owned reviewers:** schedule several independent reviewer agents, post real forge verdicts, send changes back to the writer/fixer, and prove the subsequent revision addressed each comment.
- **Owned audits:** convert a systemic finding into a new dependency-correct spec and follow it through merge, deploy, and demo rather than stopping at a red badge.
- **Stack-aware governance:** evaluate policy against the complete jj integration member vector and invalidate descendants automatically when an ancestor changes.
- **Economic governance:** reserve cost before creating work, choose cheaper valid proof strategies, and pause the DAG rather than merely alerting after spend.
- **Live coverage:** distinguish configured, conformance-tested, shadow-observed, live-observed, fresh, and negative-control-proven coverage.
- **Closed-loop DORA:** segment lead time, change-failure rate, deployment frequency, and recovery by immutable policy revision. The system may propose a policy change from evidence, but never silently weaken a rule.
- **End-to-end environment proof:** require staging behavior evidence before merge and production deploy/demo evidence after merge.
- **Portable authority:** forge rulesets are defense-in-depth projections. A forge may deny landing, but it can never authorize it; MergeAuthority remains the sole positive merge decision.

## (2) COMPARATOR PARITY MATRIX — a table: comparator capability -> how Tanren matches it -> how Tanren EXCEEDS it

The match column describes the target implementation. Feature families are grouped only when they share the same enforcement semantics.

| Comparator capability | How Tanren matches it | How Tanren EXCEEDS it |
|---|---|---|
| **GitHub ruleset scope and targeting:** named branch/tag/push rulesets; repository, organization, and enterprise layering; repo patterns/properties/visibility and ref `fnmatch` targeting; multiple applicable rulesets. [GitHub rulesets](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets) | Named org/project/repo/ref/environment bindings, selector expressions, inheritance, most-restrictive composition, and a `ProtectionProjectionAdapter` that configures corresponding host rules. | Select on DesignContract entity, behavior, change risk, stack membership, audit provenance, budget state, deploy target, and live coverage—not just repository metadata and paths. |
| **GitHub enforcement lifecycle:** active, evaluate, disabled; Rule Insights; layered rules; readable effective protections. | `draft`, `shadow`, `canary`, `enforcing`, `retired`; effective-policy inspector and shadow decision ledger. | Activation can require fresh negative-control and live-loop evidence. Stale coverage can fail closed or trigger a governed exception. |
| **GitHub history and portability:** rule history/restore, JSON export/import, REST/GraphQL management, rule-suite insights. | Immutable revisions, compare, rollback-by-new-activation, signed JSON/YAML export, REST, CLI validation, and decision queries. | Indefinite causal history binds policy revision to exact SHA, integration members, agent identities, deployment, demo, spend, and notification receipts. |
| **GitHub bypass:** roles, teams, Apps, always/PR-only bypass, delegated push-bypass requests and review. | Scoped, expiring bypass grants; principals and teams; request/approve/deny workflow; reason and incident linkage. | Dual-control break-glass, exact rule/evidence scope, automatic expiry, post-bypass audit spec, demo verification, and DORA impact attribution. |
| **GitHub ref/commit controls:** restrict branch/tag creation, updates and deletion; block force push; linear history; signed commits; commit-message, author-email and other metadata restrictions. [Available rules](https://docs.github.com/en/enterprise-cloud@latest/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) | Native rule primitives plus host projection; MergeAuthority rejects unauthorized ancestry or metadata even if the host projection drifts. | jj lineage and WorkspaceVcsCore prove intent-preserving ancestry, while the system can autonomously repair a noncompliant commit series and regate it. |
| **GitHub push rules:** restricted paths, extensions, path length, file size, private/internal fork-network coverage. | Pre-push host projection plus pre-merge native diff/content enforcement. | Rules can constrain architectural boundaries, generated artifacts, secret exposure, migration ownership, or behavior coverage—not merely filename properties. |
| **GitHub PR/review rules:** approval counts, stale dismissal, latest-push approval by another actor, code-owner approval, conversation resolution, allowed merge methods, blocking changes requested. | Review-rule categories, counts, freshness, thread resolution, merge-method policy, last-pusher/self-review constraints, and exact-head binding. | Independent reviewer agents are scheduled and challenged; unresolved comments become writer tasks; approval proves acceptance-criterion coverage rather than a button click. |
| **GitHub file-sensitive reviewer teams:** path patterns, multiple teams, per-team counts. | CODEOWNERS-compatible imports plus path/category rules and team/principal counts. | Forge derives semantic owners from entities and behaviors; category separation can require design, security, data, accessibility, and operations reviewers simultaneously. |
| **GitHub CODEOWNERS:** automatic requests, base-branch file, precedence/last match, users/teams/emails, validation and code-owner-protected CODEOWNERS file. [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) | Full parser/importer, diagnostics, base-revision semantics, source-file protection, projections, and required-owner rules. | Exportable CODEOWNERS is only a compatibility projection; the authoritative graph supports entity ownership, conjunctive categories, distinct identities, and ownership of generated/renamed code. |
| **GitHub required evidence:** status checks with strict/loose base freshness and source-App binding; code scanning, quality, coverage, deployment, and centrally required workflows. | `.tanren/ci.yml` remains the sole gate; equivalent evidence primitives, exact source identity, affected-tier fingerprints, coverage thresholds, security evidence, and staging deployment proofs feed MergeAuthority. | No external workflow engine is trusted. Positive evidence, runner image, environment hash, quarantine state, policy hash, and integration member key all participate in proof reuse. |
| **GitHub merge queue:** required queue, merge method, concurrency, group sizing, wait time, individual/group checks, and timeouts. | Tanren’s native speculative/eager queue implements equivalent controls and exposes API/UI configuration. | It is DAG- and intent-aware, builds descendants early, bisects failing batches, preserves jj conflicts, reuses exact integration proofs, and autonomously repairs the culprit. |
| **GitHub branch-protection operations:** apply to administrators, restrict push/create actors, lock branch, fork synchronization, selective force-push/delete, required conversation/check protections. [Branch protection](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) | Protection projection plus drift reconciliation and native refusal to land if required protections cannot be observed. | Host protections are minimum defense-in-depth; Tanren’s positive authorization cannot be bypassed by a host administrator changing a checkbox. |
| **GitHub environments:** required reviewers, no-self-review, wait timers, branch/tag policies, custom protection Apps, approve/reject/comment, environment secrets and variables. [Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) | First-class deployment environments, approval categories, wait windows, ref selectors, custom protection adapters, scoped Vault attachments, and PromotionAuthority. | Secrets are released only to the exact deployment operation; preview/staging behavior evidence can gate merge, while production deploy, verify, demo, rollback, and notifications form one receipt chain. |
| **GitHub environment bypass:** admin-bypass controls and reasons; deployment history separate from merge history. | Scoped break-glass with reason, expiry, actor, environment, artifact digest, and policy revision. | Emergency promotion automatically opens a follow-up audit/remediation spec and proves post-hoc demo/recovery. |
| **GitLab approval rules:** named project/MR/instance rules; users/groups; counts including optional zero; protected-branch targeting; forks; locked/overridable settings. [Approval rules](https://docs.gitlab.com/user/project/merge_requests/approvals/rules/) | Named rules at org/tier/project/change scopes, counts, optional advisory rules, branch selectors, inheritance locks, and target-project evaluation. | Rules can be produced from Forge risk and applied to every affected integration node, not merely one merge request. |
| **GitLab approval identity/settings:** author/committer restrictions, password/SAML reauthentication, approval reset on pushes or affected-file changes, re-request, API state, prevention of per-MR overrides. [Approval settings](https://docs.gitlab.com/user/project/merge_requests/approvals/settings/) | Separation-of-duty predicates, reauthentication adapters, exact-head and affected-entity invalidation, re-request workflow, admin locks, API. | Agent credentials are workload identities with model/prompt/toolchain attestations; a base shift invalidates only evidence whose dependency set changed. |
| **GitLab multi-rule semantics:** one person can count for several ordinary rules; conversations and pipeline state also block; ordinary unavailable rules may fail open. | Configurable `distinctAcrossCategories`; unresolved conversations and native gate state are mandatory evidence; missing eligible principals fail closed. | The compiler produces a witness showing precisely which principal/evidence could satisfy each blocked category and can provision an eligible reviewer agent. |
| **GitLab CODEOWNERS:** sections, independent required counts, optional sections, defaults, exclusions, users/groups/emails/roles, selective invalidation. [GitLab CODEOWNERS](https://docs.gitlab.com/user/project/codeowners/reference/) | Import all section semantics and render them into native ownership rules. | Sections may bind to DesignContract domains and behaviors; changes to a shared schema can invalidate all semantically affected sections even without a direct path match. |
| **GitLab security approval policies:** scan findings, vulnerability severity/state/attributes, license findings, unsigned commits, any-MR rules, policy-project scope and labels. [Approval policies](https://docs.gitlab.com/user/application_security/policies/merge_request_approval_policies/) | Typed finding selectors, scanner provenance, thresholds, license/signature rules, org policy projects/fragments, labels, and branch exceptions. | Findings can create repair specs, select an agent qualified for the domain, merge the fix, deploy it, and demonstrate remediation automatically. |
| **GitLab policy enforcement:** enforce/warn modes, scoped bypass with audit reason, bot approvals, category separation, fail-closed missing scans, protected-branch controls. | Enforcing/advisory modes, scoped bypass, principal classes, separation, fail-closed evidence absence, and ref protection. | A missing scanner or reviewer can trigger a capability-provisioning spec rather than leaving a permanently blocked MR or silently allowing it. |
| **GitLab protected environments:** deploy access by role/user/group, deployment-only Reporter access, project/group layering that cannot be weakened. [Protected environments](https://docs.gitlab.com/ci/environments/protected_environments/) | Deployment roles, groups and service identities; org and project layering; separate deploy authority from repository write authority. | Fine-grained secret leases and runner identities ensure an approver never receives production credentials merely because they can approve. |
| **GitLab deployment approvals:** multiple approval rules/counts, blocked deployment state, self-approval policy, reasons/history/API; approval does not automatically start the job. [Deployment approvals](https://docs.gitlab.com/ci/environments/deployment_approvals/) | Conjunctive approval categories, counts, self rules, reasons, history, API, and explicit promotion state machine. | Policy chooses whether approval resumes automatically; PromotionAuthority then deploys, verifies, demos, and rolls back from the same signed artifact. |
| **GitLab deployment freeze:** cron/timezone windows and `CI_DEPLOY_FREEZE`. [Deployment safety](https://docs.gitlab.com/ci/environments/deployment_safety/) | Native timezone-aware recurring/one-shot freeze calendars, environment/ref selectors, exception rules, and API/UI control. | Enforcement is in the engine, not dependent on repository CI remembering to inspect a variable. Freeze activity is correlated with queue, incident, deploy, and DORA data. |
| **Mergify condition DSL:** repository/base/head, actor/permission, labels/text/time, files/lines, commit/signature/conflict/behind state, review/team/comment state, CI outcomes/apps, deployments, dependency and queue metadata. [Conditions](https://docs.mergify.com/configuration/conditions/) | A typed, versioned selector AST covering every family, statically validated and simulated against historical changes. | Add DesignContract behavior/entity risk, agent attestations, ancestor-stack state, budget reservations, audit lineage, demo evidence, and notification quorum. |
| **Mergify composite merge protection:** named conditions, nested operators, required composite status, deployment conditions, synthesized protection state. [Merge protections](https://docs.mergify.com/merge-protections/) | Native compiled decisions, composite reason tree, and forge check projection. | The composite check is informational; native MergeAuthority is authoritative even when the forge has no matching branch rule. |
| **Mergify built-ins:** `Depends-On`, cross-repository dependencies, `Merge-After`, configuration-change protection, cycle handling. [Built-in protections](https://docs.mergify.com/merge-protections/builtin/) | Dependency selectors, cross-project release edges, time gates, protected policy/config paths, and cycle validation. | Dependencies are real spec-DAG and integration-node edges; cycles are rejected with a witness rather than ignored, and ancestor changes percolate into descendant workspaces. |
| **Mergify simulator/explain/automation:** simulator, live re-evaluation, comments/checks, auto-merge, configuration extension, dashboard/CLI. | Historical/current simulation, “why blocked?” receipts, live reducer, automatic queue entry, reusable fragments, UI/CLI/API. | Simulation can replay the entire owned loop—including reviewer agents, base shifts, cost, deploy, demo, and notifications—and compare predicted with observed outcomes. |
| **Mergify scheduled/manual freeze:** timezone, start/end, indefinite emergency freeze, conditions/exclusions, reasons, dashboard/CLI/REST. [Scheduled freeze](https://docs.mergify.com/merge-protections/freeze/) | Full equivalent freeze model and surfaces. | Freeze may automatically activate from an incident or failed production demo, while hotfix exceptions receive stronger review/demo obligations and expire automatically. |
| **Mergify queue pause:** preserve entries/order while stopping scheduling/checks/merges; dashboard/CLI/API/reason; distinct from merge freeze. [Queue pause](https://docs.mergify.com/merge-queue/pause/) | Separate `queue_pause` and `landing_freeze` states with identical semantics and durable episodes. | Pause can target an org, project, integration component, affected gate tier, provider, runner image, or budget envelope, while unaffected DAG components continue safely. |

## (3) DATA MODEL (tables/migrations, entities, org-scoping)

Use the next available migrations after `0032`, split by domain and kept below the 500-line limit. Migration work must be serialized because these are shared schema files.

| Migration | Tables/entities |
|---|---|
| `0033_governance_policies.sql` | `governance_tiers`, `governance_policy_revisions`, `governance_policy_fragments`, `governance_revision_fragments`, `governance_policy_bindings`, `effective_policy_snapshots` |
| `0034_governance_decisions.sql` | `governance_evaluations`, `governance_decisions`, `governance_decision_inputs`, `bypass_requests`, `bypass_grants`, `governance_freezes`, `policy_projection_states` |
| `0035_governance_reviews.sql` | `review_sessions`, `review_assignments`, `review_verdicts`, `review_publications`, `review_threads`, `approval_rule_satisfactions` |
| `0036_audit_lineage.sql` | `audit_runs`, `audit_findings`, `finding_clusters`, `finding_dispositions`, `finding_spec_edges`, `finding_quality_failures`, `audit_job_leases` |
| `0037_budget_control.sql` | `budget_policy_revisions`, `budget_envelopes`, `budget_reservations`, `budget_ledger_entries`, `infra_costs`, `budget_pause_episodes`, `budget_overrides` |
| `0038_notification_delivery.sql` | Evolve `notification_targets` and `notification_routes`; add `notification_policy_revisions`, `notification_intents`, `notification_attempts`, `notification_receipts`, `notification_acknowledgements`, `notification_dead_letters` |
| `0039_deployment_governance.sql` | `deployment_environments`, `environment_rule_bindings`, `promotion_requests`, `promotion_approvals`, `promotion_attempts`, `secret_lease_attestations` |
| `0040_governance_coverage.sql` | `coverage_requirements`, `coverage_observations`, `coverage_artifacts`, `apex_runs`, `apex_scenarios`, `negative_control_results` |

Important entity semantics:

- `governance_policy_revisions` is append-only: `revision_number`, `schema_version`, source document, compiled AST, parent revision, `policy_hash`, creator, timestamps. Schema version and policy revision are separate concepts.
- Activation is a binding change; an existing revision is never mutated.
- `policy_bindings` carries selectors, precedence, effective interval, enforcement mode, and optional superseding binding.
- `effective_policy_snapshots` records the exact compiled result used for a run/change; later org policy changes cannot rewrite history.
- `governance_decisions` binds verdict and reason tree to `policy_hash`, exact head SHA, base SHA, integration `member_key`, gate-config hash, runner image, environment hash, and evidence digest.
- `review_verdicts` and `review_publications` are separate. A policy can require both an internal reviewer verdict and a confirmed forge publication ID/state for the same head.
- `finding_dispositions` allows exactly one terminal state: `fixed_in_parent`, `new_spec`, `duplicate`, `risk_accepted`, `false_positive`, or `human_required`. `new_spec` requires a `finding_spec_edges` row.
- `finding_spec_edges` stores dependency semantics—not just provenance—including parent/current spec, created/reused remediation spec, affected entities, and chosen DAG predecessors.
- `budget_reservations` atomically reserves estimated worst-case spend; settlement creates ledger entries and releases unused commitment.
- `budget_pause_episodes` records start/end, policy revision, spend, commitment, unknown exposure, and the actual held spec IDs.
- Notification intents are transactionally derived from source events. PostgreSQL notification remains only a wake-up mechanism; leasing workers catch up from durable rows.
- `deployment_environments` must be new. The existing `environments` schema models runner-image availability, not protected deployment environments ([schemaEnvironments.ts](/home/trevor/projects/tanren/db/src/schemaEnvironments.ts:1)).
- Promote `integration_nodes` from observe-only to authoritative state and normalize `integration_node_members` and `base_shift_operations`. Existing proof records already anticipate member, gate, policy, runner, and environment keyed reuse ([schemaCore.ts](/home/trevor/projects/tanren/db/src/schemaCore.ts:459)).

Every tenant row must carry `org_id NOT NULL`, including child/evidence tables. Use composite same-org foreign keys such as `(org_id, review_session_id)` so a valid parent ID from another tenant cannot be attached. Apply forced RLS with direct `org_id = current_setting(...)`; indirect existence policies should be exceptional.

The current legacy notification delivery ledger intentionally sits outside RLS while targets and routes are protected ([0000_collapsed_baseline.sql](/home/trevor/projects/tanren/db/migrations/0000_collapsed_baseline.sql:925)). That must be corrected during migration.

Migration/backfill:

1. Persist `projects.repo_visibility`.
2. Create one initial org policy revision per distinct current posture combination.
3. Bind every project to its backfilled revision.
4. Preserve the old governance endpoint as a compatibility facade that creates a new revision.
5. Replace `projectConfig.version` as proof identity with the actual revision and `policy_hash`.
6. Compute the real `.tanren/ci.yml` hash instead of `""`.
7. Refuse proof reuse for legacy rows whose identity cannot be resolved.

## (4) ENGINE INTEGRATION (which DAG stage / gate / merge-queue / post-merge hook)

| Engine point | Ideal integration |
|---|---|
| **Forge interview/derive** | Derive a recommended tier, risk categories, semantic owners, environment posture, coverage contract, and notification obligations from personas, behaviors, DesignContract, repository visibility, and deployment intent. Show it to the operator as a policy proposal. Missing policy fragments enter the F2 authoring DAG before project derivation completes. |
| **Project activation** | Compile and validate the effective policy; run contradiction checks, adapter conformance requirements, historical simulation, and protection projection. `enforcing` activation uses CAS/ETag and requires an immutable revision. |
| **DagWalker admission** | Resolve the effective policy once per walk. Apply archive/freeze/queue-pause, budget reservation, speculation depth, environment availability, and coverage-staleness constraints. Open one pause episode rather than emitting the same notification every 60 seconds. |
| **Planner/writer/checker/design-oracle loop** | Attach policy snapshot and semantic ownership to every task. Reserve cost before every agent or runner operation. A reviewer-category violation becomes a task/spec, never an unstructured prompt note. |
| **Auditor/triage** | Persist findings before classification. In one org-scoped transaction, select the terminal disposition, quality-check a proposal, create/reuse the remediation spec and dependency edges, append lineage events, and wake DagWalker. Failed quality validation persists `needs_remediation_spec_repair`; it cannot disappear into `droppedSpecs`. |
| **Draft PR/review** | Create a `review_session` bound to exact head/base/member vector. Schedule human/team/agent assignments. A dedicated forge reviewer identity posts actual `APPROVE` or `REQUEST_CHANGES`; tiers requiring publication remain blocked until the host returns an ID and matching state. Changes requested route structured threads to the writer/fixer loop. |
| **Native gate** | `.tanren/ci.yml` remains the only CI runtime. Gate resolution incorporates the exact CI config hash, policy hash, runner image, environment, quarantine state, and affected tiers. No GitHub Actions workflow becomes authoritative. |
| **Speculative/eager integration** | Promote `integration_nodes` to the common model for eager dependents, stacked PRs, batches, and bisect prefixes. Workspace operations remain behind jj `WorkspaceVcsCore`, whose contract already treats conflicts as first-class and forbids discarding intent ([workspaceVcsCore.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/workspaceVcsCore.ts:1)). |
| **Ancestor base shift** | Resolve merged state over the complete persisted ancestor member vector, not direct `depends_on`. Every ancestor merge creates a new integration node, restacks through WorkspaceVcsCore, retargets the forge PR, invalidates affected approvals/proofs, and regates before continuing. |
| **Native queue** | Evaluate landing freezes, queue pauses, review quorum, audit dispositions, coverage freshness, environment proofs, and budget receipt. Batch speculative checking and bisect remain native. Queue configuration is policy input, not an alternate merge authority. |
| **MergeAuthority** | Expand its input with `effectivePolicyReceipt`, review-quorum receipt, freeze/bypass state, budget reservation receipt, integration proof, and required pre-merge environment proof. Only `authorized` calls `land`; no HTTP or host webhook can merge independently. |
| **Pre-merge environments** | For policies equivalent to GitHub’s “deployment before merge,” deploy the exact integration artifact to preview/staging, verify it, and run behavior demos. MergeAuthority consumes that proof. |
| **Post-merge hook** | `merge.completed` creates a production `promotion_request`. A separate fail-closed PromotionAuthority evaluates protected-environment policy, secret lease, freeze and approvals, then invokes the existing deploy-on-merge machinery and demo engine ([deployOnMerge.ts](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/deployOnMerge.ts:1), [PROJECT_BRIEF.md](/home/trevor/projects/tanren/PROJECT_BRIEF.md:158)). This preserves MergeAuthority as the sole merge decision without pretending merge and production promotion are the same decision. |
| **Notifications** | Event append and notification-intent insertion share a transaction. Dispatch workers lease intents, retry idempotently, poll provider receipts, escalate, record acknowledgements, and dead-letter. `LISTEN/NOTIFY` only reduces latency. |
| **DORA/read models** | Attribute every outcome to immutable policy and tier revisions. Produce evidence-backed proposals such as “P2 route-to-DAG reduced lead time with no change-failure increase”; activation remains governed. |

## (5) HTTP SURFACE (endpoints)

All writes require `Idempotency-Key`; revision mutations require `If-Match`; responses return `ETag`, actor, revision, and policy hash. Governance mutations require `org_admin` or delegated `governance_admin`, budget writes require `finance_admin`, notification writes require `notification_admin`, and production approvals require the bound environment principal.

### Policies and tiers

- `GET /v1/orgs/:orgId/governance/tiers`
- `POST /v1/orgs/:orgId/governance/tiers`
- `GET /v1/orgs/:orgId/governance/policies`
- `POST /v1/orgs/:orgId/governance/policies`
- `GET /v1/orgs/:orgId/governance/policies/:policyId/revisions/:revision`
- `POST .../revisions` — create immutable draft
- `POST .../validate`
- `POST .../simulate` — historical or supplied change fixture
- `POST .../activate`
- `POST .../retire`
- `POST .../rollback` — activates a new revision pointing at prior content
- `GET .../diff?from=&to=`
- `GET .../export?format=json|yaml`
- `POST /v1/orgs/:orgId/governance/imports:validate`
- `GET /v1/orgs/:orgId/projects/:projectId/governance/effective`
- `GET /v1/orgs/:orgId/projects/:projectId/governance/explain?headSha=`
- `PUT /v1/orgs/:orgId/projects/:projectId/governance/binding`

### Coverage and decisions

- `GET /v1/orgs/:orgId/projects/:projectId/governance/coverage`
- `PUT .../coverage-requirements`
- `POST .../coverage/apex-runs`
- `GET .../coverage/apex-runs/:runId`
- `GET /v1/orgs/:orgId/governance/decisions`
- `GET /v1/orgs/:orgId/governance/decisions/:decisionId`
- `GET .../:decisionId/receipt`
- `POST /v1/orgs/:orgId/governance/bypass-requests`
- `POST .../:id/approve`
- `POST .../:id/deny`
- `POST .../:id/revoke`

### Reviews

- `GET /v1/orgs/:orgId/projects/:projectId/review-sessions`
- `GET .../review-sessions/:id`
- `POST .../:id/reassign`
- `POST .../:id/rerun-agent-review`
- `POST .../:id/verdicts`
- `POST .../:id/publications:reconcile`
- `GET .../:id/threads`
- `POST .../threads/:threadId/resolve`

### Audit lineage and remediation

- `GET /v1/orgs/:orgId/audit-runs`
- `POST /v1/orgs/:orgId/audit-jobs/:jobId/run`
- `GET /v1/orgs/:orgId/audit-findings`
- `GET .../audit-findings/:findingId`
- `POST .../:findingId/dispositions`
- `POST .../:findingId/route-to-spec`
- `POST .../finding-clusters/:clusterId/route-to-spec`
- `GET .../:findingId/lineage`
- `POST .../:findingId/retry-materialization`

### Integration and queue control

- `GET /v1/orgs/:orgId/projects/:projectId/integration-nodes`
- `GET .../integration-nodes/:nodeId`
- `GET .../stacks/:specId`
- `POST .../stacks/:specId/exercise` — privileged apex/conformance run
- `GET .../base-shifts`
- `POST .../merge-queue/pause`
- `POST .../merge-queue/resume`
- `POST .../landing-freezes`
- `PATCH .../landing-freezes/:id`
- `DELETE .../landing-freezes/:id`

None of these endpoints merges. Landing remains an internal MergeAuthority operation.

### Budgets

- `GET /v1/orgs/:orgId/projects/:projectId/budget`
- `POST .../budget/revisions`
- `POST .../budget/simulate`
- `GET .../budget/reservations`
- `GET .../budget/pause-episodes`
- `POST .../budget/pause-episodes/:id/resume`
- `POST .../budget/overrides`
- `DELETE .../budget/overrides/:id`
- `GET .../budget/forecast`

### Notifications

- `GET /v1/orgs/:orgId/notifications/capabilities`
- `POST .../targets:validate`
- `POST .../targets:probe`
- `POST .../targets`
- `PATCH .../targets/:id`
- `DELETE .../targets/:id`
- `PUT .../routes/:id` — real upsert/toggle
- `DELETE .../routes/:id`
- `POST .../policies`
- `POST .../test-deliveries`
- `GET .../intents`
- `GET .../attempts`
- `GET .../receipts`
- `POST .../receipts/:id/acknowledge`
- `POST .../dead-letters/:id/retry`

### Environments and promotions

- `GET/POST /v1/orgs/:orgId/projects/:projectId/deployment-environments`
- `GET/PATCH .../deployment-environments/:environment`
- `POST .../:environment/protection-rules`
- `POST .../:environment/freezes`
- `GET .../promotions`
- `POST .../promotions/:id/approve`
- `POST .../promotions/:id/reject`
- `POST .../promotions/:id/retry`
- `POST .../promotions/:id/rollback`
- `GET .../promotions/:id/attestation`

## (6) UI/DASHBOARD SURFACE (what the operator sees + any exportable/validateable artifact)

### Governance Studio

A project/org settings surface with:

- Named tier selector and side-by-side tier comparison.
- Effective-policy tree showing inherited source for every rule.
- Draft editor generated from fragment schemas.
- Revision diff, shadow simulation, contradiction witnesses, activation/rollback.
- Host-projection drift status.
- Private visibility and reviewer identity verification.
- “Why is this blocked?” decision inspector with exact missing evidence.
- Break-glass request/approval and expiry timeline.

The current dashboard has only a limited onboarding governance picker and links toward a settings surface that is not implemented ([GovernanceStep.tsx](/home/trevor/projects/tanren/services/dashboard/src/components/onboarding/existing/GovernanceStep.tsx:53)).

### Governance Coverage

A requirements ledger, not a marketing checklist:

- Rows: F1 private simulated review, F2 finding→spec, F3 deep stack/base shift, F4 pause/resume, F5 channel quorum, plus every policy rule.
- Columns: configured, conformance-tested, shadow-observed, live-observed, negative-control proven, evidence age, current status.
- Drill-down to events, artifacts, forge review, PR, integration node, cost ledger, provider receipt, deploy and demo.
- Stale/failing obligations can block activation or open a remediation spec.

### Review Cockpit

- Reviewer assignments by category and identity.
- Agent model/prompt/toolchain attestation.
- Exact SHA freshness and base-shift invalidation.
- Internal verdict beside forge review ID/state/link.
- Threads mapped to acceptance criteria and writer repair tasks.
- Quorum/separation-of-duty visualization.

### Finding Conveyor

- Audit-run → finding → cluster → disposition → spec → DAG → PR → deploy/demo graph.
- Explicit “stranded” queue for quality-rejected or failed materializations.
- Operator can reroute, merge clusters, accept risk with expiry, or inspect why no spec was produced.
- The current audit UI displays jobs/counts but not this lineage; current inbox can display `auto_routed` as resolved even without a `resolvedSpecId`.

### Stack Explorer

- DAG plus ordered `ancestor_stack`.
- Current base/head/member vector for every integration node.
- Speculative depth, threshold, proof-reuse state, queue batch, base-shift timeline.
- Diff before/after restack and conflict-intent evidence.
- A one-click privileged depth-N apex exercise.

### Budget Control Center

Extend the current budget page with:

- Actual, committed, forecast, and unpriced exposure.
- Agent versus runner/deploy/storage/notification infrastructure cost.
- Project/spec/task/day/window envelopes.
- Held spec IDs, pause episode history, current action policy.
- Reservation and settlement drill-down.
- Admin-only resume/override with reason and expiry.

### Notification Operations

- Channel-specific setup wizard for all nine adapters.
- Credential readiness and live probe, not merely “adapter wired.”
- Matrix by tier/project/environment/risk/event.
- Quiet calendar, P0 bypass, quorum and escalation graph.
- Attempt/receipt/ack/dead-letter timeline.
- Correlated test event across selected channels.
- Fix the current UI’s hard-coded ntfy add-target path despite advertising all nine kinds.

### Deployment Governance

- Environment rail: preview → staging → production.
- Required approvals, wait window, freeze state, secret lease, promotion status.
- Exact artifact digest and source merge decision.
- Verify/demo progress and rollback control.

### Exportable artifacts

- Signed `GovernanceBundle.json|yaml`.
- `GovernanceDecisionReceipt.json`.
- CODEOWNERS/GitHub/GitLab projection preview.
- Policy simulation report.
- SARIF audit export plus finding-spec lineage.
- Review transcript with forge IDs.
- Integration stack manifest.
- Budget episode statement.
- Notification delivery manifest.
- Deployment and demo attestation.

Every artifact has canonical JSON, schema version, org/project, policy hash, evidence hashes, creation time, and Vault-backed signature. The CLI should support `tanren governance validate <artifact>` offline.

## (7) APEX-PROVABILITY (which events/artifacts prove it fired live)

All events must flow through `PgEventStore`; no subsystem gets a second audit stream. Each apex run carries `apexRunId`, correlation ID, org/project, policy revision/hash, and environment identity.

Coverage is satisfied only by reducer-verified events plus validated external artifacts. A test assertion, seeded row, or manually toggled badge is insufficient.

| Scenario | Required live event chain | Required artifact/negative assertion |
|---|---|---|
| **F1 private + simulated review** | `governance.policy.activated` → `repository.visibility.observed(private)` → `review.simulated.started` → `review.simulated.verdict(changes_requested)` → `review.forge_published` → writer repair → second simulated verdict → `review.forge_published(approved)` → `merge.authority.decided(authorized)` → `merge.completed` | Forge API readback showing private repo and real review IDs/states on exact SHAs; review transcript; policy receipt with `blockReviewAt`; negative control proves merge is blocked when publication or quorum is removed. |
| **F2 audit finding → new spec** | `audit.run.started` → `audit.finding.detected` → `audit.finding.dispositioned(new_spec)` → `audit.finding.materialized` → `dag.spec.enqueued` → normal writer/gate/review/merge/deploy/demo chain | Finding-spec edge, created-or-reused disposition, dependency rationale, provenance hash; negative control rejects a malformed proposed spec but leaves a durable repair state rather than losing it. |
| **F3 deep chain/base shift** | Six or more `dag.spec.speculative` events → `integration.node.materialized` per depth → ancestor `merge.completed` → `integration.base_shift.started` → `workspace.restacked` → `forge.pr.retargeted` → `integration.proof.invalidated` → new `gate.passed` → descendant merges in DAG order | Signed stack manifest containing ordered member vectors before/after every shift; exact PR base readback; no stale merged ancestor remains. A deliberate conflict proves intent is preserved or work is held—not discarded. |
| **F4 budget pause/resume** | Real priced `cost.resolved`/`infra.cost.recorded` → `budget.reservation.denied` → one `dag.budget.paused` episode → governed budget revision/override → `dag.budget.resumed` → `budget.reservation.created` → held `dag.spec.enqueued` | Event contains actual held spec IDs/count, spend, commitment and unknown exposure. Assert no `run.queued` occurred during pause, then prove the same spec enqueues after resume. |
| **F5 breadth** | One source governance event → `notification.intent.created` → per-channel `notification.attempted` → `notification.provider_accepted` → `notification.delivered` or `notification.acknowledged` → `notification.quorum.satisfied` | Redacted payload hash, provider message/receipt ID, timestamps, target, policy revision, final quorum. For providers without delivery callbacks, artifact must honestly say `provider_accepted`, not `delivered`. Negative controls exercise retry, mute fallback, bad credential, dead-letter, and escalation. |
| **Protected environment** | `promotion.requested` → approval-category events → `promotion.authority.decided` → `deploy.triggered` → `deploy.verified` → per-behavior `demo.evidence.recorded` → `promotion.completed` | Artifact digest, approval identities, secret-lease attestation, Fly deployment ID, live behavior evidence. A freeze negative control must block promotion while allowing permitted prechecks. |
| **Policy drift/TOCTOU** | Gate/review under revision A → revision B activation → attempted land → `integration.proof.invalidated(policy_changed)` → regate/review as required → MergeAuthority decision under B | Decision receipt must never mix evidence from incompatible policy hashes. |
| **Bypass** | `governance.bypass.requested` → dual approvals → `governance.bypass.granted` → decision use → `governance.bypass.expired` → follow-up audit/spec | Exact rules bypassed, reason, incident, expiry, actors, and resulting DORA/deployment outcome. |

The existing best F2 chain—`auditor.verdict` → `triage.completed` → spec provenance → `dag.spec.enqueued`—is neither atomic nor event-complete. The new `audit.finding.materialized` event must contain finding IDs, disposition, quality result, created/reused spec ID, dependency edges, idempotency outcome, and enqueue ID.

For v96 specifically:

- Zero F2 specs is a fixture failure only if all 68 triages selected task/fix-in-place with no dropped proposals. Any `route: spec` without a provenance-backed spec is a code/runtime failure.
- Depth two proves only the default cap, not deep-chain correctness.
- The budget proof was a pure-function exercise and did not prove `dag.budget.paused`.
- Only ntfy proves one configured target; it says nothing about the eight other adapters’ credential, route, delivery, or receipt semantics.

## (8) EFFORT + PHASING (MVP vs full, rough size, deps on sibling buckets)

This is a substantial control-plane program, not a settings-page feature.

| Phase | Scope | Rough effort |
|---|---|---:|
| **0. Safety repairs** | Close `auditPosture` authorization bypass; strict simulated-review publication; real policy/gate hashes; transitive stack retarget; truthful budget event; notification ledger RLS; fix route toggle and Slack contract. | 8–12 engineer-weeks |
| **1. MVP governance control plane** | Immutable revisions/compiler, four tier presets, bindings, effective-policy receipt, private visibility, core review rules, policy simulator, admin API, basic Governance Studio. | 18–26 engineer-weeks |
| **2. F2/F3/F4 first-class control** | Atomic audit lineage/materialization, integration nodes authoritative, depth-6 apex, reservations/infra costs/pause episodes, budget UI. | 22–32 engineer-weeks |
| **3. Comparator parity** | CODEOWNERS and ownership categories, host protection projection, protected environments, bypass, freezes, review quorums, security selectors, queue controls. | 28–40 engineer-weeks |
| **4. Notification and promotion depth** | Durable outbox, retries/receipts/ack/escalation, nine channel wizards/conformance/live tests, PromotionAuthority, environment UI. | 24–36 engineer-weeks |
| **5. Coverage/DORA/apex hardening** | Coverage ledger, signed artifacts, negative controls, revision-segmented DORA, production rollout/migration/drift reconciliation. | 20–30 engineer-weeks |

Total ideal implementation: approximately **120–175 engineer-weeks**, likely **8–12 calendar months** with a stable team of five to seven engineers plus product/design and SRE support. Expect roughly 25–40k production lines, 20–30 new/evolved tables, a large event-schema expansion, and extensive conformance/property/integration tests.

### MVP boundary

MVP should not claim comparator parity. It should ship:

- Immutable tier/policy revisions and correct proof hashes.
- Private repository visibility.
- Dedicated simulated reviewer identity with strict forge publication.
- Atomic finding→spec routing.
- Correct depth-six chain/base-shift execution.
- Persistent budget pause/resume with reservations.
- Durable notification delivery for ntfy, Slack, and generic webhook.
- Governance Studio, coverage ledger, and live F1–F5 apex scenarios.

The remaining six channels may remain visible only as `adapter_present / live_unproven`, never as “covered.”

### Required sibling dependencies

- Identity/RBAC and delegated admin roles.
- Vault secret leasing and separate writer/reviewer identities.
- CodeHost protection/review projection contracts plus GitHub/GitLab conformance suites.
- Promotion/deploy adapter hardening and Fly rollback/attestation.
- `WorkspaceVcsCore` and integration-node cutover.
- Event-schema/read-model expansion and retention.
- Forge/DesignContract semantic ownership outputs.
- DORA revision attribution.
- Dashboard design-system work.
- Notification provider test accounts and inbound callback infrastructure.

Database migrations, shared event registries, project config, dashboard navigation, and central engine entry points must be serialized per the repository’s worktree rules.

This was a read-only design review: no files were changed and no checks were run.

## (9) RISKS/UNKNOWNS

- **Policy complexity:** layering, exceptions and category counts can become undecidable to operators. Use a small typed AST, deterministic compiler, contradiction witnesses, property tests, model checking for critical rules, and an effective-policy explainer.
- **Forge identity constraints:** GitHub forbids self-approval. A distinct reviewer App/install identity is mandatory; if the host cannot provide it, the tier’s forge-publication coverage must remain unmet.
- **LLM reviewer nondeterminism:** two runs may disagree. Pin model/prompt/toolchain revisions, require structured criterion-level evidence, support reviewer ensembles and deterministic non-LLM checks, and never treat prose alone as approval.
- **Host projection drift:** branch/ruleset APIs vary by plan and forge. Reconcile continuously, expose unsupported capabilities, and fail closed when a tier requires a protection the host cannot supply.
- **Policy TOCTOU:** a revision can change between gate and land. Exact policy hash must participate in every proof key and MergeAuthority must reread the active binding immediately before authorization.
- **Queue deadlock:** review, freeze, budget, environment and ancestor rules can mutually block. The compiler/simulator needs liveness checks and the UI must display a minimal unsatisfied set.
- **Speculative explosion:** deep/diamond stacks can produce excessive integrations and regates. Use content-key reuse, affected-tier invalidation, configurable depth/batch caps, and explicit cost reservations—never silent truncation.
- **Audit remediation storms:** one root cause may create dozens of specs. Cluster findings, enforce idempotency, generate one root-cause spec with affected edges, and impose governed fanout budgets.
- **Budget uncertainty:** subscription/self-hosted rows may have NULL real cost. Preserve honest typed accounting; reserve against conservative bounds and fail closed where policy requires a hard ceiling.
- **Notification semantics:** HTTP 2xx is not human delivery. Each adapter must declare its supported terminal states; the UI and proof ledger must never upgrade `accepted` to `delivered`.
- **Provider callbacks and credentials:** proving all nine channels requires real vendor accounts, callback endpoints, rotation, rate-limit handling, and privacy review.
- **Protected-environment secrets:** approval must not imply secret access. Issue narrowly scoped, short-lived deployment leases only after PromotionAuthority authorizes.
- **RLS risk:** evidence tables are especially sensitive and easy to query cross-org during global workers. Carry direct `org_id`, same-org composite FKs, forced RLS, and use the explicit system pool only for narrowly audited cross-org scheduling.
- **Fragment trust:** automatically authored governance data could encode an unsafe rule combination. New primitives require code review; generated combinations require conformance, shadow mode and admin activation.
- **Emergency bypass abuse:** require dual control for regulated tiers, short expiry, reason/incident linkage, immutable receipt, and mandatory follow-up audit/remediation.
- **Event volume/PII:** review transcripts, findings and provider receipts may contain source or personal data. Redact before event creation, keep raw access separately authorized, encrypt sensitive artifacts, and define retention per tier.
- **DORA causality:** policy revision correlation is not proof of causation. Expose sample size and confounders; use controlled canaries where safe; produce recommendations rather than autonomous policy weakening.
- **Product decisions still needed:** default tier for brownfield imports, maximum tolerated stale coverage, distinct-person requirements across categories, supported reauthentication providers, receipt semantics per channel, Fly promotion/rollback behavior, and whether a stale required live apex automatically pauses new work or only blocks policy activation.
