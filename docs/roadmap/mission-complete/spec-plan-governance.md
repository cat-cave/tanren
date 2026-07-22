# Governance full-tier build plan

This plan replaces the collapsed `gv-16..34` bucket with nineteen PR-sized consumer nodes. The ordering preserves one land authority (`MergeAuthorityV2`), one deployment authority (`PromotionAuthority`, which cannot land code), one proof store (SP-3 CAS), one event store (`PgEventStore`), native gates, jj workspaces, org-scoped forced RLS, and adapter contracts with shared conformance suites. Runtime-verification records are project capabilities and contain no scenario-specific identifiers.

Migrations start at the current free slot, `0111`. A node owns its listed migration, schema module, engine module, routes, generated API schema changes, tests, and dashboard surface; changes to shared registries, navigation, `main.ts`, or migration metadata are serialized through that node's PR.

## Node roster

| Node  | Name                                                   | Wave | Migration |
| ----- | ------------------------------------------------------ | ---: | --------- |
| gv-16 | Atomic audit finding lineage and spec materialization  |    1 | 0111      |
| gv-17 | Authoritative integration-node lineage                 |    1 | 0112      |
| gv-18 | Budget envelopes and atomic reservations               |    1 | 0113      |
| gv-19 | Budget settlement, pause, and override episodes        |    2 | 0114      |
| gv-20 | Semantic ownership and CODEOWNERS interoperability     |    1 | 0115      |
| gv-21 | Deploy-dependent pre-merge environments                |    2 | 0116      |
| gv-22 | Forge protection projection and reconciliation         |    2 | 0117      |
| gv-23 | Expiring break-glass grants                            |    3 | 0118      |
| gv-24 | Landing and promotion freezes                          |    3 | 0119      |
| gv-25 | Review sessions and quorum receipts                    |    2 | 0120      |
| gv-26 | Separation-of-duties enforcement                       |    3 | 0121      |
| gv-27 | Governance-bound native queue controls                 |    3 | 0122      |
| gv-28 | Transactional notification outbox                      |    2 | 0123      |
| gv-29 | PromotionAuthority                                     |    4 | 0124      |
| gv-30 | Notification receipts, acknowledgement, and escalation |    3 | 0125      |
| gv-31 | Runtime-verification governance coverage ledger        |    2 | 0126      |
| gv-32 | Signed governance export bundle and CLI                |    5 | 0127      |
| gv-33 | DORA metrics by immutable policy revision              |    5 | 0128      |
| gv-34 | Governed rollout and drift reconciliation              |    6 | 0129      |

## gv-16 — Atomic audit finding lineage and spec materialization

- **id** — `gv-16`
- **name** — Atomic audit finding lineage and spec materialization
- **What** — Add `AuditFindingRepository` and `FindingMaterializer` under `services/orchestrator/src/engine/governance/auditLineage/`, called by `workflow/auditorStage.ts` after findings are persisted and before the DAG is awakened. One org-scoped transaction records an immutable finding, exactly one disposition (`fixed_in_parent`, `new_spec`, `duplicate`, `risk_accepted`, `false_positive`, or `human_required`), validates a `new_spec` proposal through the existing spec validator, creates or reuses the remediation row in `specs`, writes `spec_dependencies` plus a finding-to-spec edge, appends the registered lineage events through `services/orchestrator/src/engine/eventStore.ts`, and enqueues the spec. It reuses `spec_origins` rather than creating a second provenance system and exposes the lineage through `/v1/orgs/:orgId/projects/:projectId/audit-findings` and the Finding Conveyor dashboard.
- **Acceptance** — A real-Postgres integration test submits two identical audit findings concurrently and proves one finding lineage, one remediation spec, the correct predecessor edges, one enqueue, registered events, and cross-org invisibility as `tanren_app`; an HTTP smoke reads the finding through to its created spec. Required negative control: a `new_spec` disposition whose proposal fails the spec validator must commit `needs_remediation_spec_repair` plus the validation failure, create no spec or queue row, and never disappear as a dropped proposal.
- **Deps** — `gv-1`, `gv-7`, `gv-9`, SP-2, SP-3, SP-8, existing `audit_jobs`, `specs`, `spec_origins`, and `spec_dependencies`.
- **Migration** — `0111_governance_audit_lineage.sql`: add `audit_runs`, `audit_findings`, `finding_dispositions`, `finding_spec_edges`, and `finding_quality_failures`; every table has `org_id NOT NULL`, composite same-org foreign keys, indexed org/project keys, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, and direct `app.current_org_id` policies.
- **Size** — About 900 non-generated lines.
- **Order** — Wave 1 because gv-31/32/33 require durable finding identity and it depends only on the completed governance spine.

## gv-17 — Authoritative integration-node lineage

- **id** — `gv-17`
- **name** — Authoritative integration-node lineage
- **What** — Replace the observe-only interpretation in `db/src/schemaIntegrationNodes.ts` with the canonical persisted member vector and base-shift history consumed by `merge/integrationNodeMaterializer.ts`, `dag/baseShiftCoordinator.ts`, `contracts/workspaceVcsCore.ts`, SP-7 gate-proof revalidation, and `MergeAuthorityV2`. `IntegrationNodeRepository` will write ordered member rows and every jj restack/base-shift operation, compute the member-set hash from those rows, and reject JSON/member divergence; `integration_nodes` remains the single run model for stacks, batches, bisect prefixes, and previews. The existing `authority_decisions` and CAS proof graph remain the only decision and proof stores. Read routes expose before/after member vectors and invalidation causes.
- **Acceptance** — A real-Postgres/jj integration test builds a six-member dependency chain, lands an ancestor, restacks descendants without replacing their work, records each base shift, retargets the forge mirror, invalidates stale SP-7 proof, regates, and lands in DAG order. Required negative control: deleting or reordering one persisted member, or presenting a proof root for the pre-shift head, must make materialization/revalidation fail closed and must produce no `CodeHost.landAuthorizedIntegration` call.
- **Deps** — `gv-3`, `gv-4`, `gv-9`, SP-3, SP-4, SP-7, existing `integration_nodes`, `integration_proofs`, `authority_decisions`, and jj `WorkspaceVcsCore`.
- **Migration** — `0112_authoritative_integration_lineage.sql`: add `integration_node_members` and `base_shift_operations`; add composite same-org foreign keys missing from `integration_nodes`/`integration_proofs`; enable and force RLS on both existing tables and both new tables with direct org policies.
- **Size** — About 950 non-generated lines.
- **Order** — Wave 1 because deployment, promotion, queue, and revision attribution all need an authoritative integration subject before they can issue receipts.

## gv-18 — Budget envelopes and atomic reservations

- **id** — `gv-18`
- **name** — Budget envelopes and atomic reservations
- **What** — Add `BudgetAuthority` under `engine/governance/budget/` and replace `workflow/budgetPreflight.ts`'s read-only ceiling check with an atomic reserve-before-work contract. Effective governance policy selects hierarchical org/project/spec/operation envelopes; each reservation stores a conservative maximum in typed `per_token`, `subscription`, `self_hosted`, or `unattributed` buckets and references the exact policy hash. `DagWalker`, agent dispatch, runner allocation, native gate, preview deployment, and promotion callers must obtain a reservation receipt before spending. The receipt maps to the existing explicit `BudgetScope` input of `MergeAuthorityV2`; unknown priced exposure is represented and blocks hard-ceiling envelopes.
- **Acceptance** — A real-Postgres contention test starts two operations whose combined reservation exceeds one envelope and proves exactly one reservation succeeds, all cost buckets remain disjoint, and the accepted receipt is callable by the live walker preflight. Required negative control: NULL/unknown exposure under a hard ceiling, a stale policy hash, or a missing reservation must prevent agent/runner/deploy invocation and cannot be converted to `not_required`.
- **Deps** — `gv-5`, `gv-7`, `gv-9`, SP-4, existing `cost_records`, `engine/contracts/money.ts`, and `workflow/budgetPreflight.ts`.
- **Migration** — `0113_budget_envelopes.sql`: add `budget_envelopes` and `budget_reservations`, each with `org_id NOT NULL`, composite same-org foreign keys, nonnegative finite amount checks, uniqueness for active scope/revision and idempotency keys, plus enabled/forced direct-org RLS.
- **Size** — About 850 non-generated lines.
- **Order** — Wave 1 because budget settlement, queue admission, previews, and production promotion all consume reservation receipts.

## gv-19 — Budget settlement, pause, and override episodes

- **id** — `gv-19`
- **name** — Budget settlement, pause, and override episodes
- **What** — Extend `BudgetAuthority` with append-only settlement and governed recovery. Usage and infrastructure costs settle reservations into a ledger, release unused commitment, and open one durable pause episode containing the exact held spec IDs when spend plus commitment or unknown exposure breaches policy. Admin-approved overrides are immutable, bounded by amount/scope/expiry, and resume the same held work through `DagWalker`; the Budget Control Center and `/v1/orgs/:orgId/budgets/*` routes show spend, commitment, unknown exposure, holds, overrides, and receipts without manufacturing a placeholder cost source.
- **Acceptance** — A real-Postgres workflow smoke reserves spend, records priced agent and infrastructure usage, crosses the envelope, proves one pause episode and zero new `run.queued` events, applies an authorized bounded override, and proves the same held spec resumes and settles exactly once. Required negative control: an expired or cross-org override, a settlement larger than its reservation without a new exposure record, or a NULL cost labeled as a known basis must remain paused and must not release or double-spend commitment.
- **Deps** — `gv-18`, SP-8, existing typed cost accounting and `DagWalker` pause/resume paths.
- **Migration** — `0114_budget_ledger.sql`: add `budget_ledger_entries`, `infra_costs`, `budget_pause_episodes`, `budget_pause_members`, and `budget_overrides`; all carry direct `org_id`, composite same-org foreign keys, append-only guards where applicable, amount/billing-mode/cost-basis checks, and enabled/forced org RLS.
- **Size** — About 900 non-generated lines.
- **Order** — Wave 2 because it requires atomic envelopes/reservations from gv-18 and then supplies durable controls to the queue, notifications, and DORA nodes.

## gv-20 — Semantic ownership and CODEOWNERS interoperability

- **id** — `gv-20`
- **name** — Semantic ownership and CODEOWNERS interoperability
- **What** — Add the host-neutral `OwnershipAdapter` contract in `engine/contracts/ownershipAdapter.ts`, with GitHub/GitLab CODEOWNERS parsers/renderers behind one conformance suite. `engine/governance/ownership/` derives versioned path and semantic-category ownership from Forge outputs, behavior/persona revisions, design contracts, and imported CODEOWNERS; the compiler stores normalized rules in governance policy and resolves required reviewer categories for an exact change. Import and preview endpoints show conflicts and the generated host file, while Tanren's internal ownership rules remain authoritative and host files remain projections.
- **Acceptance** — Contract tests run the same precedence, escaping, comments, teams, overlapping-pattern, and round-trip corpus against each adapter; an integration test changes security-owned and design-owned paths and proves both internal owner categories are required and the generated CODEOWNERS preview is stable. Required negative control: an unparseable required rule, unresolved team, unmatched protected semantic category, or adapter capability gap must block policy activation/change admission and cannot silently fall back to the repository's existing CODEOWNERS file.
- **Deps** — `gv-7`, `gv-9`, `gv-10`, `gv-13`, SP-1, and existing DesignContract/Forge derivation outputs.
- **Migration** — `0115_semantic_ownership.sql`: add `ownership_rule_revisions` and `ownership_rule_bindings`, both directly org-scoped with immutable revision lineage, composite same-org project/policy foreign keys, digest checks, enabled/forced org RLS, and one-active-binding constraints.
- **Size** — About 900 non-generated lines.
- **Order** — Wave 1 because review quorum, separation of duties, and host protection projection need normalized owner categories.

## gv-21 — Deploy-dependent pre-merge environments

- **id** — `gv-21`
- **name** — Deploy-dependent pre-merge environments
- **What** — Add protected deployment-environment policy in `engine/governance/environments/` and wire it into `workflow/plannerRunPreMergeBehavior.ts`. For a policy requiring deployment before land, the exact `integration_node` artifact is built and applied through SP-6 `DeployAdapter.applyPreview`, verified, exercised through SP-5 runtime verification, sealed into SP-3/SP-7, and supplied to land-time revalidation without changing the frozen `AuthorizeLandInput`. `deployment_environments` is distinct from the existing runner-image `environments` table; HTTP and dashboard surfaces expose readiness, exact artifact/head/policy hashes, behavior coverage, and teardown state.
- **Acceptance** — A deploy-adapter conformance test plus a real workflow smoke deploys an integration artifact to a staging-class environment, verifies it, records blocking behavior proof, tears it down after land, and shows the receipt in the governance read API. Required negative control: provider acceptance without READY verification, proof from another artifact/head/policy, missing required behavior evidence, or failed teardown accounting must withhold the land binding and never call the code-host land effect.
- **Deps** — `gv-9`, `gv-13`, `gv-17`, `gv-18`, SP-3, SP-4, SP-5, SP-6, and SP-7.
- **Migration** — `0116_deployment_environments.sql`: add `deployment_environments`, `environment_rule_bindings`, and `environment_verification_receipts`; each has `org_id NOT NULL`, composite same-org project/policy/integration/release foreign keys, immutable receipt digests, and enabled/forced direct-org RLS.
- **Size** — About 950 non-generated lines.
- **Order** — Wave 2 because it consumes authoritative integration nodes and budget reservations and is required before production promotion policy can reuse environment semantics.

## gv-22 — Forge protection projection and reconciliation

- **id** — `gv-22`
- **name** — Forge protection projection and reconciliation
- **What** — Add `HostGovernanceProjection` in `engine/contracts/hostGovernanceProjection.ts` for branch/ruleset protection reads, compare-and-set writes, and capability discovery, with GitHub/GitLab adapters and a shared conformance suite. `engine/governance/hostProjection/` compiles internal policy plus gv-20 ownership into a desired projection, previews the delta, applies it with provider ETag/CAS, and records observed state and drift. This extends the existing best-effort `VisibilityProjection` only by composition: host protection is never a land authority, and a tier that requires successful projection remains internally blocked when the host cannot represent or confirm it.
- **Acceptance** — Adapter conformance and a provider-backed smoke apply required checks/reviewer/owner restrictions, read them back, and prove the observed digest matches the desired policy hash. Required negative control: a stale ETag, unsupported required capability, partial provider write, or readback mismatch must mark projection `unsatisfied`, block activation for enforcing tiers, and must not weaken Tanren's internal `MergeAuthorityV2` checks.
- **Deps** — `gv-9`, `gv-11`, `gv-13`, `gv-20`, SP-4, and `engine/contracts/visibilityProjection.ts`.
- **Migration** — `0117_host_governance_projection.sql`: add `host_projection_states` and `host_projection_attempts`, with direct `org_id`, same-org project/policy foreign keys, desired/observed digests, provider capability/result fields, append-only attempts, and enabled/forced org RLS.
- **Size** — About 900 non-generated lines.
- **Order** — Wave 2 because ownership rules must exist first; gv-34 consumes its desired-versus-observed receipts.

## gv-23 — Expiring break-glass grants

- **id** — `gv-23`
- **name** — Expiring break-glass grants
- **What** — Add `BypassAuthority` under `engine/governance/bypass/` to request, approve, deny, revoke, expire, and consume narrowly scoped exceptions to named governance rule IDs. Grants require an incident/reason, exact org/project/environment or integration subject, immutable policy hash, two distinct authorized principals, and an absolute expiry; they never bypass native gate execution, unresolved conflicts, tenant isolation, artifact/head binding, or the sole-authority protocols. `MergeAuthorityV2` and gv-29 `PromotionAuthority` receive only a verified bypass receipt through their input assemblers, not a second decision path, and every use appends through `PgEventStore`.
- **Acceptance** — An API/workflow smoke obtains two approvals, consumes the grant once for its exact subject before expiry, records the bypassed rule IDs in the authority receipt, and creates a mandatory follow-up audit finding. Required negative control: self-approval, reused principal, broadened scope, changed policy/head, expired/revoked grant, or an attempt to bypass a non-bypassable invariant must deny and produce no land or promotion effect intent.
- **Deps** — `gv-9`, `gv-12`, `gv-16`, `gv-17`, SP-4, and SP-8.
- **Migration** — `0118_governance_bypass.sql`: add `bypass_requests`, `bypass_approvals`, `bypass_grants`, and `bypass_uses`; every table has direct `org_id`, composite same-org foreign keys, distinct-actor/expiry/scope constraints, append-only grant/use guards, and enabled/forced org RLS.
- **Size** — About 850 non-generated lines.
- **Order** — Wave 3 because it needs reviewer identity, audit follow-up, and exact integration subjects; freezes and promotion consume its receipts.

## gv-24 — Landing and promotion freezes

- **id** — `gv-24`
- **name** — Landing and promotion freezes
- **What** — Add `FreezeResolver` in `engine/governance/freezes/` for scheduled, manual, and incident-triggered `landing` or `promotion` freeze episodes scoped to org, project, branch, environment, integration component, or policy selector. The effective-policy compiler validates IANA timezone schedules and exclusions; `MergeAuthorityV2` and `PromotionAuthority` input assembly re-read active episodes immediately before effects. Freeze state is separate from queue pause: work, gates, reviews, and permitted prechecks continue while the protected effect is held. Exceptions are only gv-23 grants naming the freeze rule and carry stronger policy obligations.
- **Acceptance** — A clock-controlled integration test opens a scheduled freeze, proves work and native gates continue, proves land/promotion are held, then closes the episode and completes the same queued subject with an immutable episode receipt. Required negative control: DST ambiguity, invalid scope, missing end for a scheduled freeze, stale cached state, or an expired exception must resolve to frozen and produce neither land nor promotion effect intent.
- **Deps** — `gv-9`, `gv-13`, `gv-17`, `gv-21`, `gv-23`, and SP-4.
- **Migration** — `0119_governance_freezes.sql`: add `governance_freezes` and `governance_freeze_episodes`, directly org-scoped with same-org policy/project/environment foreign keys, validated kind/scope/time fields, immutable episode history, and enabled/forced org RLS.
- **Size** — About 750 non-generated lines.
- **Order** — Wave 3 because it requires policy validation, deployment-environment identity, and the only permitted exception mechanism.

## gv-25 — Review sessions and quorum receipts

- **id** — `gv-25`
- **name** — Review sessions and quorum receipts
- **What** — Replace the single-verdict reduction in `engine/governance/reviewRules.ts` with persisted `ReviewSessionRepository` and `ReviewQuorumEvaluator`. A session binds the exact integration head, base, member-set hash, policy hash, owner categories, reviewer model/prompt revision, and required human/team/agent counts; assignments, criterion-level verdicts, review threads, and forge publication receipts are separate immutable records. `merge/landSignals.ts` reduces them into one signed SP-3 quorum receipt and maps only a satisfied exact-head receipt to the existing `reviewVerdict: "approved"`; routes and Review Cockpit expose the minimal unsatisfied set.
- **Acceptance** — A workflow test requires two security-owner approvals plus one reviewer-agent approval, publishes required forge reviews, and proves `MergeAuthorityV2` authorizes only after all exact-head receipts exist; real-Postgres tests prove tenant isolation and idempotent publication callbacks. Required negative control: one approval on an older head, a pending/changes-requested verdict, missing provider publication, duplicate reviewer counted twice, or unreadable receipt must reduce to `unread`/`pending` and block land.
- **Deps** — `gv-2`, `gv-9`, `gv-12`, `gv-17`, `gv-20`, SP-3, SP-4, and the dedicated reviewer identity.
- **Migration** — `0120_review_quorums.sql`: add `review_sessions`, `review_assignments`, `review_verdicts`, `review_publications`, and `review_threads`; all carry direct `org_id`, composite same-org subject/principal foreign keys, exact-head/policy digests, append-only verdict/publication guards, and enabled/forced org RLS.
- **Size** — About 950 non-generated lines.
- **Order** — Wave 2 because normalized owners and exact integration subjects are ready, and SoD, promotion, exports, and DORA require durable quorum receipts.

## gv-26 — Separation-of-duties enforcement

- **id** — `gv-26`
- **name** — Separation-of-duties enforcement
- **What** — Add a deterministic `DutyConstraintEvaluator` in `engine/governance/reviews/separationOfDuties.ts` and extend the policy AST with distinct-principal constraints across author, code owner, reviewer, bypass approver, environment approver, and promotion actor categories. It evaluates stable principal IDs and delegated team membership, never display names, and emits an SP-3-backed `approval_rule_satisfaction` receipt consumed by review quorum and promotion input assembly. The chosen rule is strict graph coloring: one principal may fill multiple roles only when no active `distinctFrom` edge joins them; unresolved identity or team membership is unsatisfied.
- **Acceptance** — Property tests cover role graphs and a real workflow assigns distinct author, security reviewer, and production approver principals, then proves the satisfaction receipt is bound to the same policy/head/promotion subject. Required negative control: aliases for one principal, nested teams resolving to the same principal, deleted membership, or an unknown identity must not satisfy two constrained roles and must block land/promotion rather than count the displayed names separately.
- **Deps** — `gv-20`, `gv-23`, `gv-25`, SP-3, SP-4, and org/project RBAC principal IDs.
- **Migration** — `0121_separation_of_duties.sql`: add `approval_rule_satisfactions` and `approval_rule_principals`, with direct `org_id`, same-org review/policy foreign keys, exact subject digests, unique role/principal edges, immutable receipts, and enabled/forced org RLS.
- **Size** — About 700 non-generated lines.
- **Order** — Wave 3 because review sessions and stable semantic owner categories must exist before distinct-principal constraints can be evaluated.

## gv-27 — Governance-bound native queue controls

- **id** — `gv-27`
- **name** — Governance-bound native queue controls
- **What** — Bind the existing `QueuePolicyV1` and `queuePolicyController.ts` to immutable governance revisions through `engine/governance/queue/queueGovernanceBinding.ts`. The effective policy selects one queue-policy revision and constrains admission, speculative depth, batch/deploy-group limits, priority, windows, pause, drain, and partition scope; commands remain operational inputs and cannot authorize land. `DagWalker` records the resolved queue-policy hash beside the governance snapshot, while `MergeAuthorityV2` revalidation rejects a proof produced under a superseded binding. Queue pause preserves entries and order and remains distinct from gv-24 landing/promotion freezes.
- **Acceptance** — A queue integration test activates a binding, admits matching work, pauses one partition while another progresses, resumes without reordering, and proves every integration proof carries both policy hashes. Required negative control: no active binding, a matcher with missing facts, a command outside the actor's scope, a changed queue-policy hash, or a paused partition must prevent scheduling/landing and cannot fall back to the default queue route.
- **Deps** — `gv-9`, `gv-13`, `gv-17`, `gv-18`, `gv-24`, SP-4, SP-7, and existing `merge_queue_policies`, `merge_queue_commands`, and `merge_queue_windows` from migration 0103.
- **Migration** — `0122_governance_queue_bindings.sql`: add `governance_queue_policy_bindings` with direct `org_id`, composite same-org governance/queue-policy/project foreign keys, effective interval, immutable binding lineage, one-active-binding constraint, and enabled/forced org RLS.
- **Size** — About 700 non-generated lines.
- **Order** — Wave 3 because authoritative node identity, reservation admission, and freeze semantics must already be available to queue policy resolution.

## gv-28 — Transactional notification outbox

- **id** — `gv-28`
- **name** — Transactional notification outbox
- **What** — Clean-replace direct subscriber dispatch in `engine/notifications/subscriber.ts` with durable `NotificationOutbox` and leased dispatcher workers. `PgEventStore.append` and notification-intent derivation share the caller's org-scoped database transaction; `LISTEN/NOTIFY` remains only a wake-up hint, and workers catch up by ordered lease scans. Each intent binds source event ID, target/route, policy hash, redacted canonical payload digest, severity, idempotency key, and next delivery state; no second event/audit stream is introduced. Existing `notification_targets` and `notification_routes` remain configuration; the migration backfills the old `notifications` ledger into intents/attempts, the read API derives its compatibility shape from those canonical rows, and every direct legacy-ledger write is deleted.
- **Acceptance** — A real-Postgres crash/restart test appends an event, kills the worker after lease and after provider acceptance, restarts, and proves the durable intent dispatches exactly once logically with an idempotency key and remains org-isolated; an HTTP smoke shows pending and attempted states. Required negative control: rollback of the source-event transaction must leave no intent, and dropped `NOTIFY`, expired lease, disabled route, or worker restart must never lose the intent or falsely mark it delivered.
- **Deps** — `gv-6`, `gv-9`, SP-8, `services/orchestrator/src/engine/eventStore.ts`, and existing notification targets/routes/ledger.
- **Migration** — `0123_notification_outbox.sql`: add `notification_policy_revisions`, `notification_intents`, and `notification_attempts`; add direct `org_id` plus composite same-org target foreign keys to `notification_routes`; backfill and drop the legacy `notifications` table; all tenant tables use enabled/forced direct-org RLS, leased-row indexes, and unique source-event/route idempotency constraints.
- **Size** — About 950 non-generated lines.
- **Order** — Wave 2 because it needs effective policy identity and becomes the delivery substrate for freeze, bypass, budget, promotion, and drift alerts.

## gv-29 — PromotionAuthority

- **id** — `gv-29`
- **name** — PromotionAuthority
- **What** — Add the sibling `PromotionAuthority` contract and implementation in `engine/contracts/promotionAuthority.ts` and `engine/promotion/`. It is the only caller allowed to invoke SP-6 `DeployAdapter.promote` or `rollback`, and it has no code-host or land capability. A promotion request binds the merged source SHA, integration node, artifact digest, target protected environment, effective policy receipt, successful prechecks/runtime-verification proofs, budget reservation, freeze/bypass state, quorum/SoD receipt, and short-lived deployment secret-lease attestation. The implementation follows the same durable decision → idempotent effect intent → external CAS-capable effect → receipt/unknown-state reconciliation protocol as `MergeAuthorityV2`; `postMerge/deployOnMerge.ts` becomes its request producer.
- **Acceptance** — A conformance suite runs every deploy adapter through authorize/promote/receipt and ambiguous-effect reconciliation; a workflow smoke merges, creates a production request, obtains required approvals, promotes the exact artifact, verifies it, and records behavior evidence. Required negative control: changed artifact/head/policy, missing or expired secret lease, unsatisfied SoD/quorum, active freeze, failed verification, exhausted budget, or unknown provider effect state must produce no second promote call and must never report `completed`.
- **Deps** — `gv-17`, `gv-18`, `gv-21`, `gv-23`, `gv-24`, `gv-25`, `gv-26`, SP-3, SP-5, SP-6, SP-8, and existing `release_instances`/post-merge hook.
- **Migration** — `0124_promotion_authority.sql`: add `promotion_requests`, `promotion_decisions`, `promotion_effect_intents`, `promotion_effect_receipts`, and `secret_lease_attestations`; every table carries direct `org_id`, composite same-org integration/release/environment/policy foreign keys, immutable digest-bound records, idempotency/CAS state constraints, and enabled/forced org RLS.
- **Size** — About 950 non-generated lines.
- **Order** — Wave 4 because every required production decision input is delivered by gv-17/18/21/23/24/25/26; this is the first wave in which the complete promotion protocol can become live.

## gv-30 — Notification receipts, acknowledgement, and escalation

- **id** — `gv-30`
- **name** — Notification receipts, acknowledgement, and escalation
- **What** — Define `NotificationChannelAdapter` in `engine/contracts/notificationChannelAdapter.ts` with explicit supported terminal semantics (`provider_accepted`, `delivered`, `acknowledged`) and one conformance suite for ntfy, Slack, GitHub Checks, Teams, Discord, email, Twilio, PagerDuty, and generic webhook implementations. Extend the outbox dispatcher with idempotent retries driven by provider response class, callback/poll receipt ingestion, acknowledgement quorum, escalation routes, and dead-letter operations; the Notification Operations UI reports capability and live-proof state per adapter and never upgrades HTTP acceptance to human delivery.
- **Acceptance** — All nine adapters pass the same fake-provider conformance corpus, and provider-backed smokes for configured test accounts record honest provider IDs/states, acknowledgement quorum, retry, escalation, redaction, and dead-letter recovery. Required negative control: bad credentials, provider 429/5xx, duplicate callback, invalid callback signature, muted primary target, or an adapter without delivery callbacks must remain retryable/dead-lettered or `provider_accepted`; none may become `delivered`/`acknowledged` without its declared proof.
- **Deps** — `gv-28`, SP-3, SP-8, existing secret-store grants, callback infrastructure, and notification registry.
- **Migration** — `0125_notification_receipts.sql`: add `notification_receipts`, `notification_acknowledgements`, `notification_escalations`, and `notification_dead_letters`; all have direct `org_id`, composite same-org intent/attempt/target foreign keys, provider-id idempotency constraints, immutable receipt payload digests, and enabled/forced org RLS.
- **Size** — About 950 non-generated lines.
- **Order** — Wave 3 because the transactional intent/attempt lifecycle must be stable before channel-specific terminal states and recovery are added.

## gv-31 — Runtime-verification governance coverage ledger

- **id** — `gv-31`
- **name** — Runtime-verification governance coverage ledger
- **What** — Add `GovernanceCoverageEvaluator` under `engine/governance/coverage/` over the generic SP-5 `RuntimeVerificationRepository`, SP-3 proof units, and immutable behavior revisions. Policy declares required evidence classes, environments, adapter conformance, freshness, and named negative controls; observations bind a runtime-verification run, behavior revision, artifact/head/environment/policy hashes, proof-unit digest, and reducer verdict. `/governance/coverage` and the Governance Coverage dashboard show satisfied, stale, missing, failed, and unproven requirements for any project, while policy activation and authority input assembly consume the same receipt.
- **Acceptance** — A generic project smoke executes required API, browser, side-effect, and design checks in the runtime-verification harness, records their proof units, runs each declared negative control, and produces a callable coverage receipt used by activation/authority revalidation. Required negative control: seeded rows, test-only assertions, evidence from another project/revision/artifact/environment, stale evidence, a skipped required control, or a missing adapter capability must leave coverage unsatisfied and block the policy action that requires it.
- **Deps** — `gv-9`, `gv-13`, `gv-17`, `gv-21`, SP-1, SP-3, SP-5, SP-7, and SP-8.
- **Migration** — `0126_governance_coverage.sql`: add `coverage_requirements`, `coverage_observations`, and `negative_control_results`; all carry direct `org_id`, composite same-org policy/project/verification-run foreign keys, exact digest/freshness fields, immutable result constraints, and enabled/forced org RLS. Evidence bytes remain only in SP-3 CAS.
- **Size** — About 850 non-generated lines.
- **Order** — Wave 2 because generic runtime-verification and protected preview identities already exist, and exports, promotion, rollout, and drift need coverage receipts.

## gv-32 — Signed governance export bundle and CLI

- **id** — `gv-32`
- **name** — Signed governance export bundle and CLI
- **What** — Add canonical `GovernanceBundleV1` in `engine/contracts/governanceBundle.ts`, a bundle builder in `engine/governance/export/`, HTTP export endpoints, and `tanren governance export|validate|inspect`. A bundle contains immutable policy/tier/binding content, effective receipt, integration and authority receipts, audit lineage, ownership/host projection, budget episodes, reviews/SoD, queue state, notification manifest, deployment/promotion evidence, and generic coverage results by SP-3 digest. Canonical JSON is stored once in CAS and signed by an `ArtifactSigner` adapter whose private key is read through the existing secret-store contract; offline validation uses the embedded public key ID and signature, never a live database.
- **Acceptance** — A CLI smoke exports JSON and YAML views of one canonical bundle, validates it offline in a network-disabled container, resolves every declared CAS digest, verifies the signature/key ID, and reproduces the same bundle digest regardless of view format. Required negative control: changing one byte, removing a required receipt, substituting a cross-org digest, using an unknown/revoked key, or providing an unsigned bundle must make `tanren governance validate` exit nonzero and must never display the bundle as verified.
- **Deps** — `gv-16` through `gv-31`, SP-3, SP-4, SP-5, SP-6, SP-7, SP-8, and `engine/contracts/secretStore.ts`.
- **Migration** — `0127_governance_exports.sql`: add `governance_exports` with direct `org_id`, composite same-org project/policy foreign keys, CAS digest, schema version, signature algorithm, public key ID/version, revocation snapshot, and creation metadata; enable and force direct-org RLS. No artifact bytes or private keys are stored in Postgres.
- **Size** — About 900 non-generated lines.
- **Order** — Wave 5 because the bundle must describe the completed governance decision surface rather than introduce parallel partial formats.

## gv-33 — DORA metrics by immutable policy revision

- **id** — `gv-33`
- **name** — DORA metrics by immutable policy revision
- **What** — Extend the canonical reducers in `engine/insights/dora/` and `/routes/dora` to attribute deployment frequency, lead time, change-failure rate, and restore time to the effective policy revision/tier, queue-policy revision, integration member vector, and promotion environment that governed each outcome. The reducer reads registered `PgEventStore` events and immutable receipts, publishes sample size and missing/confounded classifications, and produces evidence-backed policy comparisons in Governance Studio; it never claims causation or autonomously weakens policy.
- **Acceptance** — A reducer integration test processes two policy revisions across merges, promotions, a failed deployment, remediation, and rollback, and proves each observation belongs to exactly one revision interval with correct boundary timestamps and drill-down receipt IDs; the existing DORA HTTP smoke returns revision segments. Required negative control: an outcome without a resolvable policy receipt, one spanning incompatible hashes, duplicate events, or a promotion without verified completion must be placed in `unattributed`/excluded with an explicit gap and must not inflate any revision's success metrics.
- **Deps** — `gv-9`, `gv-17`, `gv-19`, `gv-25`, `gv-29`, `gv-31`, SP-8, and existing canonical DORA reducers/routes.
- **Migration** — `0128_governance_dora_attribution.sql`: add `governance_dora_observations` and `governance_dora_aggregates`, with direct `org_id`, composite same-org policy/project/integration/promotion foreign keys, unique source-event attribution, metric/sample/confounder fields, and enabled/forced org RLS.
- **Size** — About 750 non-generated lines.
- **Order** — Wave 5 because accurate segmentation requires completed budget, review, coverage, and promotion outcomes; it then supplies rollout health signals.

## gv-34 — Governed rollout and drift reconciliation

- **id** — `gv-34`
- **name** — Governed rollout and drift reconciliation
- **What** — Add `GovernanceRolloutController` and `GovernanceDriftReconciler` under `engine/governance/rollout/`. Policy activation uses ordered project cohorts (`shadow`, `canary`, `enforcing`) with explicit entry/exit criteria based on simulator, coverage, host readback, authority denials, promotion results, notification health, and revision-segmented DORA; advancing or rolling back a cohort always creates a new binding/revision action. The reconciler continuously compares desired immutable policy, ownership, queue, notification, and environment bindings with observed runtime/host state, records durable drift episodes, reapplies only through each owning adapter's CAS contract, and halts rollout when a required capability cannot converge.
- **Acceptance** — A multi-project smoke rolls one revision from shadow to canary to enforcing, proves each cohort's receipts and health criteria, detects an out-of-band host protection change, reconciles it through `HostGovernanceProjection`, and resumes rollout without changing policy content. Required negative control: stale/missing coverage, adverse promotion/DORA threshold, notification dead letter, policy-hash mismatch, unsupported host capability, or repeated nonconvergent drift must halt the cohort, open one durable incident/notification episode, and must not auto-advance or silently downgrade the desired policy.
- **Deps** — `gv-13`, `gv-15`, `gv-22`, `gv-27`, `gv-29`, `gv-30`, `gv-31`, `gv-33`, SP-3, and SP-8.
- **Migration** — `0129_governance_rollout_drift.sql`: add `governance_release_plans`, `governance_release_cohorts`, `governance_release_observations`, and `governance_drift_episodes`; each carries direct `org_id`, composite same-org policy/project foreign keys, immutable desired/observed digests and transition receipts, uniqueness for open episodes, and enabled/forced org RLS.
- **Size** — About 950 non-generated lines.
- **Order** — Wave 6 because rollout is the final consumer of simulation, projection, queue, notification, coverage, promotion, and revision-attributed health evidence.
