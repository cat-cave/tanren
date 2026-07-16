> Continuation of the integrations bucket. Section (1) ideal design lives in [`integrations.md`](./integrations.md).
> This file holds §2 comparator parity, §3 data model, §4 engine integration, §5 HTTP surface, §6 UI/dashboard surface, §7 apex-provability, §8 effort + phasing, and §9 risks/unknowns.

## (2) COMPARATOR PARITY MATRIX — a table: comparator capability -> how Tanren matches it -> how Tanren EXCEEDS it

The matrix covers the integration-lifecycle and workflow capabilities of Zapier, Make, Backstage, and modern secret-delivery systems—not merely the seed checklist.

| Comparator capability                                                                                                                                                                                                                                                                    | How Tanren matches it                                                                                                                                                          | How Tanren EXCEEDS it                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zapier’s broad connector catalog; Make’s action/search/trigger/webhook/universal/responder modules. [Zapier triggers](https://docs.zapier.com/integrations/build/trigger), [Make module types](https://developers.make.com/custom-apps-documentation/app-structure/modules)              | Versioned provider catalog with typed provisioning, runtime, and observation capabilities; unsupported providers use F2 application fragments or a normal provider-adapter PR. | “Supported” means provisionable, bindable, gate-testable, deployable, and live-observable—not merely callable.                                                                |
| API key, OAuth 1/2, JWT, session, basic, and digest connections with refresh/reconnect. [Zapier auth](https://docs.zapier.com/integrations/build/auth), [Make connections](https://developers.make.com/custom-apps-documentation/app-components/connections)                             | Reusable org connections, provider auth adapters, refresh, expiry, validation, rotation, and revocation.                                                                       | Compile exact permissions from the behavior; validate effective scopes before authoring and again before deployment.                                                          |
| Shared connections without showing credentials; ownership transfer and health management. [Zapier shared connections](https://help.zapier.com/hc/en-us/articles/8496326497037), [connection management](https://help.zapier.com/hc/en-us/articles/8496290788109)                         | Opaque secret handles, grant subjects, owners, generations, health, dependents, rotate/revoke/replace.                                                                         | Scope use to org + project + plane + capability + environment + run/deploy—not merely workspace membership.                                                                   |
| Secure credential requests listing exact apps/modules; owner can authorize, revoke, or reauthorize. [Make credential requests](https://help.make.com/credential-requests)                                                                                                                | `awaiting_grant` inbox with behavior, provider, exact operations/scopes, environment, requester, reason, and expiry.                                                           | The request is generated from an unmet proof obligation; authorization automatically wakes the capability node and continues through merge, deploy, and A3.                   |
| Admin-managed apps, allow/deny policies, action restrictions, and publishing approval. [Zapier app policies](https://help.zapier.com/hc/en-us/articles/8496307974541-App-access-policies-in-Zapier), [publishing restrictions](https://help.zapier.com/hc/en-us/articles/21705940108941) | Provider/action/region/data-classification policies, approval thresholds, destructive-operation controls.                                                                      | Evaluate before code or resources exist; select a compliant provider or generate remediation instead of failing a live workflow.                                              |
| Dynamic fields, dropdowns, dependent choices, pagination, and live resource discovery. [Zapier dynamic dropdowns](https://docs.zapier.com/integrations/build-cli/dynamic-dropdowns), [Make RPCs](https://developers.make.com/custom-apps-documentation/app-components/rpcs)              | Typed paginated discovery, compatibility filters, choice schemas, cached observations, explicit ambiguity handling.                                                            | Rank resources using behavior semantics, topology, ownership, policy, health, naming, quota, and deploy region; export the rationale.                                         |
| Create/update/search/find-or-create/delete actions. [Zapier actions](https://docs.zapier.com/integrations/build/action)                                                                                                                                                                  | `discover → bind/create → reconcile → teardown`, idempotency keys, adoption and ownership policy.                                                                              | Desired-state hashes converge across crashes and speculative attempts; destructive teardown is blocked while a deployed behavior depends on the resource.                     |
| Polling triggers with dedupe and near-real-time hooks. [Zapier triggers](https://docs.zapier.com/integrations/build/trigger)                                                                                                                                                             | Poll/push observation adapters, cursors, signature validation, dedupe, normalization, rate limits.                                                                             | Select the observer from the behavior proof obligation and correlate it to the exact deployed stimulus.                                                                       |
| Automated webhook subscribe/unsubscribe and expiry renewal. [Zapier REST hooks](https://docs.zapier.com/integrations/build/cli-hook-trigger)                                                                                                                                             | Durable subscription bindings, callback ownership, signing refs, renewal, health, teardown.                                                                                    | Deploy provides the callback URL; Tanren patches it, proves signed round-trip delivery, and rebinds automatically on rollback or URL change.                                  |
| Instant/scheduled webhook queues, ordered or parallel processing, custom responses. [Make webhooks](https://help.make.com/webhooks)                                                                                                                                                      | Durable callback queues with partition ordering, concurrency, signatures, custom response contracts, and backpressure.                                                         | One rate/concurrency budget spans speculative tests, deployment activation, production delivery, and A3.                                                                      |
| Data mapping, formatters, functions, searches, dependent fields. [Zapier tools](https://help.zapier.com/hc/en-us/categories/38051190329997-Zapier-tools), [Make mapping and modules](https://help.make.com/scenarios)                                                                    | Typed transformations inside generated code and adapter contracts.                                                                                                             | Compile against application types and integration schemas so mappings cannot silently drift from source code.                                                                 |
| Filters, multi-branch/nested paths, fallbacks, routers. [Zapier Paths](https://help.zapier.com/hc/en-us/articles/8496288555917), [Make Router](https://help.make.com/router)                                                                                                             | Conditional requirement branches and fallback/remediation edges in the project DAG.                                                                                            | Statically prove every required behavior branch has a grant, binding, code path, gate test, deploy projection, and observer.                                                  |
| Loops, iterators, aggregators, fan-out/fan-in. [Zapier Looping](https://help.zapier.com/hc/en-us/articles/8496106701453), [Make Iterator](https://help.make.com/iterator), [Make Aggregator](https://help.make.com/aggregator)                                                           | Bounded provider-operation concurrency, typed fan-out/fan-in, deterministic result aggregation.                                                                                | Share one resource across specs while giving each speculative run an isolated lease/canary; garbage-collect only abandoned children.                                          |
| Schedules, delays, on-demand runs, and rate-limit queues. [Make scheduling](https://help.make.com/schedule-a-scenario)                                                                                                                                                                   | Scheduled drift/expiry reconciliation, provider Retry-After support, delayed redrive, quotas.                                                                                  | Schedule and rate decisions account for DAG priority, deploy criticality, provider cost, speculative depth, and proof freshness.                                              |
| Raw authenticated API requests and custom TypeScript/AI-authored actions. [Zapier API Request](https://help.zapier.com/hc/en-us/articles/12899607716493), [Zapier Custom Actions](https://help.zapier.com/hc/en-us/articles/16276574838925)                                              | Typed HTTP escape hatch plus F2-authored product fragments and a provider adapter SDK.                                                                                         | The escape hatch must graduate into a reviewed, versioned, conformance-tested fragment or adapter before reuse.                                                               |
| Reusable subflows, sub-Zaps, subscenarios, public/team templates. [Zapier Sub-Zaps](https://help.zapier.com/hc/en-us/articles/32283713627533), [Make templates](https://help.make.com/scenario-templates)                                                                                | Reusable capability subplans, curated fragments/templates, typed inputs/outputs, F2 for missing coverage.                                                                      | Selection originates in the DesignContract; missing coverage becomes a DAG dependency and cannot be silently hand-wired.                                                      |
| Zapier Tables/Forms and Make data stores provide automation state and operator forms. [Zapier Tables](https://help.zapier.com/hc/en-us/articles/29712888250509), [Zapier Forms](https://help.zapier.com/hc/en-us/articles/15927500577037)                                                | Org-RLS Postgres state, generated forms/fragments, import/export, remediation UI.                                                                                              | The state is the same truth used by DagWalker, gate proof, deploy projection, and A3—not a parallel automation database.                                                      |
| Natural-language workflow building and maintenance. [Zapier Copilot](https://help.zapier.com/hc/en-us/articles/38215656607757)                                                                                                                                                           | Forge turns rough product notes into personas, G/W/T, DesignContract, integration requirements, and DAG nodes.                                                                 | It continues beyond workflow creation through source implementation, gate, merge, deploy, and observed behavior.                                                              |
| Sample/real-data step testing and publish validation. [Zapier step testing](https://help.zapier.com/hc/en-us/articles/18811411817741)                                                                                                                                                    | Provider conformance, recording fakes, canary resources, native-gate evidence, schema validation.                                                                              | Test once against the exact jj speculative tree and again through the deployed user behavior plus independent provider observation.                                           |
| Connector semver, private/beta versions, migration, promotion, deprecation, usage visibility. [Zapier versioning](https://docs.zapier.com/integrations/manage/versions), [migration](https://docs.zapier.com/integrations/manage/migrate)                                                | Version every provider contract, fragment, requirement, binding, materializer, and probe with compatibility matrices.                                                          | Automatically canary/promote based on native-gate conformance and deployed A3 evidence; emit remediation specs for incompatible consumers.                                    |
| Error branches, skip/retry/resume/commit/rollback, incomplete executions. [Zapier error handlers](https://help.zapier.com/hc/en-us/articles/22495436062605), [Make error handling](https://help.make.com/overview-of-error-handling)                                                     | Typed failure taxonomy, durable claims, resumable phases, compensation, progress-signature convergence.                                                                        | Failures relinquish provider/merge capacity according to DAG dependency; post-merge failures become degraded delivery work, never a weaker merge decision.                    |
| Manual/autoreplay, whole-run replay, historical trigger backfill. [Zapier replay](https://help.zapier.com/hc/en-us/articles/8496241726989), [Make replay](https://help.make.com/scenario-run-replay)                                                                                     | Redrive any reconciliation or validation from an immutable generation and saved stimulus.                                                                                      | Reconstruct exact code tree, gate config, binding generation, lease metadata, deployment, and probe version instead of replaying against an ambiguous “current” workflow.     |
| Run history, per-step status, HTTP detail, exports, audit logs, log streams. [Zapier history](https://help.zapier.com/hc/en-us/articles/8496291148685), [Zapier audit log](https://help.zapier.com/hc/en-us/articles/13295074298125)                                                     | Typed append-only events, sanitized operation attempts, provider IDs, costs, quotas, signed evidence export.                                                                   | Produce one causal chain from interview phrase to external receipt and deployed SHA.                                                                                          |
| Org/workspace/team roles, shared assets, audit, budgets and usage. [Zapier roles](https://help.zapier.com/hc/en-us/articles/47031545308557), [Make teams](https://help.make.com/teams)                                                                                                   | Direct `org_id` on every lifecycle row, deny-by-default RLS, scoped roles, quotas and budgets.                                                                                 | Carry the same tenant boundary through DB, DAG, SSH workload, Vault, provider namespace, deploy, relay, and proof.                                                            |
| Backstage’s centralized metadata, ownership, lifecycle, relations, search, and plugin views. [Backstage Catalog](https://backstage.io/docs/features/software-catalog/)                                                                                                                   | Requirements, grants, resources, bindings, owners, relations, health, and evidence are searchable entities and exportable manifests.                                           | They are executable desired state that directly controls readiness, deployment, and live proof—not inventory alone.                                                           |
| Entity providers/processors perform full/delta ingestion, validation, stitching, conflict/orphan handling. [Backstage external integrations](https://backstage.io/docs/features/software-catalog/external-integrations/)                                                                 | Desired-versus-observed reconciliation, external ownership, drift, orphan state, stable provider identity.                                                                     | Drift can generate a repair spec, pass the native gate, land through MergeAuthority, redeploy, and close only after A3.                                                       |
| Central SCM/provider credentials used for read/publish integrations. [Backstage integrations](https://backstage.io/docs/integrations/)                                                                                                                                                   | Central provider connections and multiple scoped grants, schedules, discovery and rate awareness.                                                                              | Select and instantiate the provider from a product behavior; no preconfigured annotation or manual plugin wiring is required.                                                 |
| Software Templates parameterize skeletons, execute steps, publish repositories, and register components. [Backstage templates](https://backstage.io/docs/features/software-templates/)                                                                                                   | Fragments materialize integration code/config/tests and register the binding contract.                                                                                         | Continue through writer/checker/auditor/design-oracle, native gate, jj queue, MergeAuthority, deploy, and demo.                                                               |
| Custom scaffolder actions and action registry. [Backstage custom actions](https://backstage.io/docs/features/software-templates/writing-custom-actions)                                                                                                                                  | Introspectable adapters behind contracts.                                                                                                                                      | Every action declares idempotency, compensation, secret flow, gate driver, runtime consumer, and A3 observer, then passes conformance.                                        |
| Template editor, JSON-schema forms, conditional/iterated steps, dry-run files/logs. [Backstage writing templates](https://backstage.io/docs/features/software-templates/writing-templates/)                                                                                              | Validate and dry-run the integration contract, fragment composition, resource plan, and secret requirements.                                                                   | Dry-run against the actual speculative tree/deploy topology and carry one plan hash through provision, gate, merge, injection, and validation.                                |
| Granular plugin/template/action permissions and conditional policies. [Backstage permissions](https://backstage.io/docs/permissions/overview/)                                                                                                                                           | Fine-grained grant, override, validation, rotation, teardown and evidence permissions.                                                                                         | Human authority governs credentials/destruction; native CI governs code; only MergeAuthority governs landing. No authority leaks across domains.                              |
| Environment overlays, `$env`/`$file`, and JSON-schema config validation. [Backstage configuration](https://backstage.io/docs/conf/)                                                                                                                                                      | Typed environment contracts and reference-only secret values.                                                                                                                  | Project the same logical binding through separate test and production leases, then prove which generation the live revision consumed.                                         |
| Vault KV versioning, CAS, soft delete, undelete, and destruction. [Vault KV](https://developer.hashicorp.com/vault/docs/secrets/kv)                                                                                                                                                      | Secret generation/CAS, explicit destruction authority, opaque handles.                                                                                                         | Bind the secret generation to integration and deployment proof; stale generations invalidate evidence.                                                                        |
| Deny-by-default, path/operation/parameter policies and least privilege. [Vault policies](https://developer.hashicorp.com/vault/docs/concepts/policies), [Kubernetes secret practices](https://kubernetes.io/docs/concepts/security/secrets-good-practices/)                              | Exact org/project/environment/run paths; no wildcard/list access; negative permission tests.                                                                                   | Mechanically compile the policy from the behavior and prove both required access and forbidden access in the native gate.                                                     |
| Dynamic secrets, TTL leases, renewal and cascading revocation. [Vault leases](https://developer.hashicorp.com/vault/docs/concepts/lease)                                                                                                                                                 | Separate provisioning, speculative-run, deployment, and validation leases with revoke-on-cancel/rebase.                                                                        | Align lease lifetime with DagWalker claim, SSH workload, jj workspace, deployment rollout, and demo completion.                                                               |
| Workload identity and short-lived federated credentials. [Vault identities](https://developer.hashicorp.com/vault/docs/about-vault/why-use-vault/identities), [SPIFFE Workload API](https://spiffe.io/docs/latest/spiffe-specs/spiffe_workload_api/)                                     | Prefer audience-bound workload federation; fall back to scoped Vault projections when providers require static tokens.                                                         | Encode org/project/spec/run/deploy claims and join provider/Vault audit to the exact engine operation.                                                                        |
| Agent/CSI memory or file injection with renewal/rotation. [Vault Agent vs CSI](https://developer.hashicorp.com/vault/docs/deploy/kubernetes/injector-csi), [CSI auto-rotation](https://secrets-store-csi-driver.sigs.k8s.io/topics/secret-auto-rotation.html)                            | Provider-neutral projection, mounted-version status, rollout on rotation; env only where unavoidable.                                                                          | Enforce bind → lease → inject → deploy → verify loaded generation → A3 → revoke superseded generation.                                                                        |
| Short-TTL single-use response wrapping with origin/interception checks. [Vault response wrapping](https://developer.hashicorp.com/vault/docs/concepts/response-wrapping)                                                                                                                 | One-use runner/deployer handoff, origin/TTL verification, immediate anomaly event.                                                                                             | An anomalous unwrap cancels the claim, revokes the subtree, and makes its gate evidence ineligible for merge.                                                                 |
| HMAC-redacted audit of nearly all secret API traffic with correlation headers. [Vault audit](https://developer.hashicorp.com/vault/docs/audit)                                                                                                                                           | Vault audit plus typed Tanren reference events; joinable request/lease accessors without values.                                                                               | APEX joins engine, Vault, provider, deployment, and observed-effect evidence into one signed attestation.                                                                     |
| Manual integration wiring: read docs, create app/channel/project, copy secrets, edit env, redeploy, and test by hand.                                                                                                                                                                    | The same operations are represented as versioned plans, grants, bindings, env projections, deploy stages, and probes.                                                          | The declared behavior itself drives the entire workflow and produces machine-verifiable proof; manual wiring becomes an explicit exceptional approval, never the normal path. |

## (3) DATA MODEL (tables/migrations, entities, org-scoping)

Current `org_integrations` permits only one row per `(org_id, provider_kind)` and carries a single broad credential reference. [schemaIntegrations.ts:35–66](/home/trevor/projects/tanren/db/src/schemaIntegrations.ts:35) That cannot model multiple Slack workspaces/accounts, separate product/control grants, scope revisions, or environment authority.

Create a new schema module, kept under the 500-line cap, and one serialized migration using the next available migration number.

| Entity                                      | Important columns and constraints                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integration_requirements`                  | `requirement_id`, direct `org_id`, `project_id`, capability, plane, direction, immutable `desired_state`, source/revision/hash, policy version, criticality, status, `superseded_by`. Unique active source/hash.           |
| `behavior_integration_requirements`         | Direct `org_id`, `behavior_id`, `requirement_id`, relation role. Composite tenant-aware FKs.                                                                                                                               |
| `capability_nodes`                          | Direct `org_id`, project, requirement, environment, executor kind, desired hash, status, wait reason, priority, generation. One active node per requirement/environment/generation.                                        |
| `capability_node_dependencies`              | Capability-to-capability edges, direct `org_id`; cycle checked during graph materialization.                                                                                                                               |
| `spec_capability_dependencies`              | Direct `org_id`, spec, capability node; makes ordinary spec readiness depend on a prepared binding.                                                                                                                        |
| `org_integration_connections`               | Migrated from `org_integrations`: provider, upstream account/workspace identity, auth kind, credential ref, auth generation, owner, expiry, health, metadata. Multiple accounts per provider.                              |
| `org_integration_grants`                    | Connection, plane, environment, permitted capabilities/operations/provider scopes/resource constraints, policy/consent revision, status, expiry/revocation. No credential value.                                           |
| `integration_bindings`                      | Requirement, grant, environment, provider/adapter versions, external resource ID/name, ownership (`created/adopted/shared`), teardown policy, desired/observed hashes and generations, provider ETag, status, drift state. |
| `integration_binding_env`                   | Binding output → logical key → `project_app_env` row; scope, classification, required flag, materialized generation.                                                                                                       |
| `integration_reconciliations`               | Durable saga: operation ID, coordinates, phase, idempotency key, request fingerprint, claim lease, status, attempt/progress signature, retry-after, failure classification, compensation/state-unknown data.               |
| `integration_resource_snapshots`            | Sanitized discovery/observation results, provider cursor/ETag, last seen, health and drift. Raw sensitive provider bodies are prohibited.                                                                                  |
| `delivery_runs` / `delivery_stage_attempts` | Generic sibling-C post-merge release DAG: merge SHA, requirement/binding generations, stages, claims, retry/attention/degraded state. Reuse sibling C’s schema if available.                                               |
| `integration_validation_proofs`             | Behavior/spec/binding/deploy/probe coordinates, correlation ID, trigger digest, sanitized observation, provider receipt, verdict, evidence digest/ref, freshness, signature. Full reuse key unique per org.                |

Extend `project_app_env` with:

- Mandatory direct `org_id`.
- `environment`.
- `binding_id`.
- `binding_generation`.
- `secret_generation`.
- Unique `(org_id, project_id, environment, key)`.

Its existing secret-ref/plain-value XOR remains. Secret values continue to live only in Vault. Runtime resolution must fail closed on a missing or stale generation.

### Migration and tenancy rules

- Backfill current `org_integrations` into one connection plus one grant per row; retain compatibility views/routes during rollout.
- Replace the one-provider-per-org unique index with upstream-account identity uniqueness.
- Every new hot table carries direct, mandatory, indexed `org_id`; do not rely solely on FK traversal.
- Add composite unique keys `(org_id, id)` and composite FKs so a binding cannot reference another org’s grant or requirement.
- Apply deny-by-default direct RLS. The current baseline establishes that an unset org scope sees zero rows and rejects writes. [0000_collapsed_baseline.sql:924–961](/home/trevor/projects/tanren/db/migrations/0000_collapsed_baseline.sql:924)
- Grant mutations only to the control-plane state writer; the data plane should enqueue operations but not directly mutate lifecycle state.
- Never hold an org-scoped DB transaction open across provider network I/O. Claim briefly, perform I/O, then commit observed state in a new scoped transaction.
- Serialize this migration, generated event vocabulary, shared schema exports, and `screens.ts` work under the repository’s worktree rules.

### Typed event vocabulary

All events still append only through `EventStore`, which already requires `orgId` and supports org-only events. [eventStore.ts:13–38](/home/trevor/projects/tanren/services/orchestrator/src/engine/eventStore.ts:13)

Add at least:

- `integration.requirement.derived|superseded`
- `capability.node.enqueued|ready|awaiting_grant|needs_attention`
- `integration.reconcile.started|retry_scheduled|fixed_point|state_unknown`
- `integration.resource.discovered|selected|provisioned|adopted`
- `integration.binding.committed|materialized|drifted`
- `integration.grant.requested|linked|validated|rotated|revoked`
- `integration.runtime.attached`
- `integration.validation.started`
- `integration.stimulus.emitted`
- `integration.effect.observed`
- `integration.validation.passed|failed`
- `integration.recovery.enqueued`
- `integration.teardown.completed|failed`
- `delivery.completed|degraded|needs_attention`

Payloads contain IDs, generations, hashes, key names, provider receipt IDs, and correlation IDs—never tokens, wrapped tokens, provider bodies, or sensitive message text.

## (4) ENGINE INTEGRATION (which DAG stage / gate / merge-queue / post-merge hook)

| Engine point                         | Ideal integration                                                                                                                                                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Forge interview                      | Derive `IntegrationRequirementV1` from G/W/T and DesignContract. Ask focused follow-ups only when provider/resource semantics materially change the result.                                                                |
| Before fragment selection            | Use provisional requirements to choose integration fragments and calculate required grants/scopes.                                                                                                                         |
| F2                                   | Author each missing application integration fragment; run isolated, full-library, runtime, fake-delivery, and negative-control composition before persistence.                                                             |
| Entity graph transaction             | Persist behaviors, specs, requirements, capability nodes and cross-kind edges, then flip project `deriving → active` and wake DagWalker.                                                                                   |
| DagWalker                            | Schedule `capability_prepare` nodes alongside specs but through a provider queue. Specs cannot become ready until mandatory capability nodes are ready.                                                                    |
| Capability preparation               | `discover → policy/consent → select → bind/create canary → observe → persist binding → materialize test env`. External creation uses an idempotency key and desired hash.                                                  |
| Runner admission                     | Pin the binding generation and mint a precise run-scoped Vault lease before workspace/model allocation where possible.                                                                                                     |
| Writer/checker/auditor/design-oracle | Supply the requirement, binding contract, fragment contract, fake protocol, and proof obligations as structured context. Generated source remains an ordinary jj diff.                                                     |
| Native `.tanren/ci.yml` gate         | Run deterministic application contract/fake/permission/negative-control tests and emit positive JUnit/artifact evidence. No GitHub Actions and no live-provider merge gate.                                                |
| Speculative/eager jj execution       | Include binding/app-env generation in proof identity. Rebase/restack preserves the code work; generation drift invalidates proof and re-gates.                                                                             |
| Merge queue                          | Admit only gate-proven candidates with current binding hashes. A capability block never enters the queue. If a final race invalidates a hash after claim, dequeue to re-gate/repair and continue with independent entries. |
| MergeAuthority                       | Unchanged sole authority. It sees the native gate verdict for the exact commit and either authorizes or refuses land. It never calls Slack, Vault, or a provisioner.                                                       |
| Authorized land                      | Atomically record `merge.completed`, mark the spec merged, and enqueue the post-merge delivery run.                                                                                                                        |
| Post-merge activation                | Reconcile/promote the production binding, mint activation-scoped secrets, materialize runtime env, then deploy.                                                                                                            |
| Deploy                               | Attach the exact runtime binding generation before triggering the merged SHA.                                                                                                                                              |
| A3/demo                              | Establish the Given, execute the When against the verified live surface, independently observe the provider Then, record evidence, then complete the demo.                                                                 |
| Continuous operations                | Reconcile drift, expiry, resource deletion, scope loss, adapter upgrades, cost/quota, and webhook renewal. Route repair through ordinary specs where code changes are needed.                                              |

### Non-clogging dispositions

| Condition                               | Disposition                                                      | Queue effect                                             |
| --------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| Missing grant/consent                   | Capability node `awaiting_grant`; emit actionable request        | Never enters merge queue; independent DAG nodes continue |
| Provider 429/5xx                        | Release operation claim; provider-directed delayed retry         | Separate provider queue only                             |
| Repeated unchanged permanent failure    | `fixed_point` / `needs_attention` on capability node             | Blocks only dependent specs                              |
| Provider succeeded but DB commit failed | `state_unknown`; reconcile by external idempotency key/discovery | Never blindly create twice                               |
| Binding generation changed before gate  | Invalidate proof and re-gate                                     | No queue admission                                       |
| Binding changes after queue claim       | Dequeue/park for re-gate under sibling-C fairness                | Next independent candidate advances                      |
| Post-merge provision/deploy/A3 failure  | `delivery.degraded`, retry or remediation spec                   | Merge remains landed; merge queue continues              |
| Policy denial/destructive ambiguity     | Durable human decision                                           | No implicit fallback or destructive call                 |

The current coordinator’s generic returned `blocked` path can hold a queue entry, while `needs_attention` dequeues and frees the DAG. [coordinator.ts:244–268](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/coordinator.ts:244), [coordinator.ts:334–352](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/coordinator.ts:334) Sibling C therefore needs a typed “park/dequeue for capability re-gate” disposition rather than mapping integration failures to generic merge retry.

## (5) HTTP SURFACE (endpoints)

All external-resource mutations return `202 Accepted` with an operation URL, require `Idempotency-Key`, and support generation/ETag preconditions. Reads never expose raw credential references; return provider, owner label, presence, scope, generation, expiry, and health.

| Endpoint                                                          | Purpose and authority                                                                       |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /orgs/:orgId/integration-catalog`                            | Provider capabilities, auth modes, scopes, regions, resource schemas, sandbox/probe support |
| `GET /orgs/:orgId/integration-connections`                        | List sanitized accounts/workspaces, owners, health, expiry, dependent count                 |
| `POST /orgs/:orgId/integration-connections`                       | API-key/manual connection creation; org admin; write-only credential body                   |
| `POST /orgs/:orgId/integration-connections/:provider/oauth/start` | Begin OAuth with signed state and requested scope manifest                                  |
| `GET /integrations/oauth/:provider/callback`                      | Complete provider consent and store credential only in Vault                                |
| `POST /orgs/:orgId/integration-connections/:id/validate`          | Validate principal, effective scopes, account identity, health                              |
| `POST /orgs/:orgId/integration-connections/:id/rotate`            | Rotate/re-authorize and reconcile dependents                                                |
| `POST /orgs/:orgId/integration-connections/:id/revoke`            | Revoke after impact preview/approval                                                        |
| `GET /orgs/:orgId/integration-grants`                             | List plane/environment/capability/resource-scoped grants                                    |
| `POST /orgs/:orgId/integration-grant-requests`                    | Create consent request derived from requirements                                            |
| `POST /orgs/:orgId/integration-grant-requests/:id/authorize`      | Authorize requested operations/scopes; grant owner/admin                                    |
| `GET /orgs/:orgId/projects/:projectId/integration-requirements`   | Requirements with behavior/spec links and lifecycle state                                   |
| `GET /.../integration-requirements/:requirementId`                | Desired-state contract, rationale, binding and proof status                                 |
| `POST /.../integration-requirements/:id/reconcile`                | Enqueue reconciliation against current generation                                           |
| `GET /.../integration-requirements/:id/discovery`                 | Sanitized resources, compatibility scores and rationale                                     |
| `PUT /.../integration-requirements/:id/binding-intent`            | Select/adopt/create resource using `If-Match`; operator only when ambiguous                 |
| `GET /.../capability-nodes`                                       | Cross-kind DAG status and wait reasons                                                      |
| `GET /.../integration-bindings`                                   | Bindings by environment, provider, generation, drift and dependents                         |
| `POST /.../integration-bindings/:id/validate`                     | Run provider/binding probe without deploying                                                |
| `POST /.../integration-bindings/:id/rotate`                       | Rotate output generation and schedule rollout/A3                                            |
| `POST /.../integration-bindings/:id/teardown`                     | Ownership/dependency-aware destructive operation with approval                              |
| `GET /.../delivery-runs/:deliveryRunId`                           | Post-merge stage state, retries, degradation and evidence                                   |
| `GET /.../integration-validations`                                | Validation history and freshness                                                            |
| `GET /.../integration-validations/:id/evidence`                   | Signed, sanitized evidence bundle                                                           |
| `GET /.../integration-contract`                                   | Canonical `.tanren/integrations.yml` representation                                         |
| `GET /.../integration-contract/schema`                            | JSON Schema for offline validation                                                          |
| `GET /.../integrations/stream`                                    | Org/project-scoped SSE lifecycle events                                                     |

Response semantics:

- `202`: durable operation accepted, including `awaiting_grant`.
- `409`: ambiguous resource choice or conflicting active binding.
- `412`: stale `If-Match`/generation.
- `422`: unsupported capability, invalid scope combination, or policy denial.
- `403`: insufficient Tanren authority.
- Provider 429/5xx is normally absorbed into operation state, not reflected as an unstable synchronous API response.

The current `/integrations/provision` and `/discover` routes remain compatibility facades but must enqueue the same lifecycle operations; they must no longer own orchestration.

Internal machine-authenticated endpoints should expose claim/heartbeat/complete/state-unknown operations through an `IntegrationStateWriter`, matching the existing data-plane de-privilege pattern.

## (6) UI/DASHBOARD SURFACE (what the operator sees + any exportable/validateable artifact)

Replace “link once, enable per project” with an Integration Control Center. Today’s screen supports only a raw token form and blind enable button, lists four providers, selects the first project, and exposes credential ref names. [IntegrationsBody.tsx:66–180](/home/trevor/projects/tanren/services/dashboard/src/components/integrations/IntegrationsBody.tsx:66), [integrations.ts:81–106](/home/trevor/projects/tanren/services/dashboard/src/api/integrations.ts:81)

The ideal screen shows:

- Organization, project, environment and deployment selectors.
- A graph: `behavior → requirement → capability node → grant → resource → binding/env → gate proof → merge → deploy → observed effect`.
- Requirement cards containing the exact G/W/T phrase, compiler rationale, criticality and provider policy.
- Grant cards showing workspace/account, owner, allowed plane/environments, effective scopes, expiry, health and dependent bindings—never raw secret paths.
- Consent inbox with a human-readable scope diff: “Tanren needs `chat:write`, channel management, and validation history read because behavior B-17 must send and independently verify a message.”
- Discovery comparison with resource ownership, compatibility, quota, policy, confidence and smart-default rationale.
- Capability/DAG status: preparing, awaiting grant, retry scheduled, ready, fixed point, dependent specs.
- Binding generations, logical env keys, projection scopes, loaded runtime generation and drift.
- Provider operation timeline with sanitized request IDs, Retry-After, compensation and state-unknown reconciliation.
- Separate status indicators for:
  - Code merged.
  - Binding ready.
  - Runtime generation attached.
  - Deployment verified.
  - Behavior cross-validated.
  - Delivery degraded.
- Rotation/revoke/teardown impact previews.
- Provider cost, quotas, rate budget, speculative resource leases and pending garbage collection.
- A3 evidence showing stimulus, negative controls, receipt, observation time, deploy SHA and proof freshness.

Exportable artifacts:

1. `.tanren/integrations.yml` — repository-owned, provider-neutral `IntegrationContractV1`; no bindings or secrets.
2. `integration-binding-lock.v1.json` — environment-specific selected resources, provider/fragment versions and generations; signed, no values.
3. `integration-plan.v1.json` — dry-run mutations, permissions, costs, compensations and approval points.
4. `integration-evidence.v1.dsse.json` — signed requirement→binding→deploy→observation attestation.
5. `integration-sbom.v1.json` — provider/adapter/fragment versions, scopes, resource ownership and data-flow classification.

Provide CLI validation:

```sh
tanren integrations validate .tanren/integrations.yml
tanren integrations plan --project <id> --environment production
tanren integrations verify-evidence integration-evidence.v1.dsse.json
```

Dashboard response types should be generated from orchestrator Zod/JSON schemas rather than hand-mirrored.

## (7) APEX-PROVABILITY (which events/artifacts prove it fired live)

The current APEX rough notes explicitly request “when any short link crosses 100 clicks, post a celebratory message to our Slack channel.” [apex-run-playbook.md:340–359](/home/trevor/projects/tanren/docs/operator-guide/apex-run-playbook.md:340) Yet the present E2E artifact vocabulary contains no integration requirement, binding, secret projection, provider receipt, or cross-validation evidence, and its apex case is hermetic. [manifest.ts:22–38](/home/trevor/projects/tanren/tests/e2e/lib/manifest.ts:22), [manifest.ts:174–204](/home/trevor/projects/tanren/tests/e2e/lib/manifest.ts:174)

A live pass must produce this correlated chain:

```text
integration.requirement.derived
→ capability.node.enqueued
→ integration.grant.validated
→ integration.resource.selected|provisioned
→ integration.binding.committed
→ integration.binding.materialized
→ credential.scoped_token_minted
→ native pre_merge gate passed for binding generation
→ merge.completed
→ delivery.activation.claimed
→ app_env.runtime_attached
→ deploy.triggered
→ deploy.verified
→ integration.validation.started
→ integration.stimulus.emitted
→ integration.effect.observed
→ integration.validation.passed
→ demo.completed
→ delivery.completed
```

For the Slack celebration fixture, A3 must:

1. Prove the deployed artifact is the authorized merge SHA.
2. Prove the production binding generation was attached before deploy.
3. Create a fresh short link with a validation correlation ID.
4. Establish the Given at 99 clicks.
5. Observe no matching Slack message.
6. Perform the 100th click against the verified live URL.
7. Independently observe exactly one message in the authorized channel through the relay receipt, Slack event, or history API.
8. Match behavior ID, correlation ID, channel, sanitized template digest, binding generation and deploy SHA.
9. Retry the click/request and prove no duplicate message.
10. Perform the 101st click and prove no second celebration.
11. Exercise a wrong-org binding access and prove RLS/relay denial.
12. Revoke or replace a canary grant and prove a durable, redacted failure—not silent success.

Required persisted artifacts/readers:

- `integration_requirement`
- `capability_dag_node`
- `integration_binding`
- `runtime_secret_attachment`
- `integration_delivery_receipt`
- `behavior_cross_validation`
- `integration_evidence_attestation`

The provider receipt ID/time, binding generation, validation correlation ID, Vault audit accessor, deployment ID/SHA and evidence digest are retained. Tokens and message bodies are not.

`integration.provisioned`, a channel row, HTTP 200, a generated source file, or today’s route-reachability demo are individually insufficient. Current web demo evidence treats any 2xx/3xx route as a behavior pass; it cannot prove a Slack effect. [demoEvidence.ts:97–132](/home/trevor/projects/tanren/services/orchestrator/src/engine/demo/demoEvidence.ts:97)

## (8) EFFORT + PHASING (MVP vs full, rough size, deps on sibling buckets)

This is intentionally not a small route-wiring patch.

### MVP: real Slack Plane-B vertical

Roughly 18–25 engineer-weeks, 15–22k production/test LOC, or 8–12 elapsed weeks with three parallel worktrees after shared contracts serialize.

| Phase                     | Scope                                                                                                                        | Rough effort |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -----------: |
| M0: contracts/model       | `IntegrationRequirementV1`, binding/env/proof contracts, migrations/RLS, control-plane writer, events, generated API schemas |       2–3 ew |
| M1: Forge/fragments       | Requirement compiler, `deriving` lifecycle, integration fragment phase, F2 validation, `.tanren/integrations.yml`            |       3–4 ew |
| M2: DAG/reconciler        | Capability nodes/edges, provider work queue, durable saga/claims, grant wake, progress-based retry                           |       4–5 ew |
| M3: Slack product binding | Managed relay or separate product app, app-env materializer, vertical conformance, scoped Vault access                       |       3–5 ew |
| M4: release lifecycle     | Transactional delivery outbox, durable post-merge DAG, bind-before-deploy, degraded/recovery state                           |       3–4 ew |
| M5: A3/API/UI/APEX        | Live trigger/observe proof, negative controls, Control Center, artifact readers and attestation                              |       3–5 ew |

“MVP” is complete only when the real deployed 100-click Slack behavior is independently observed. Calling the existing provisioner from DagWalker is not an MVP.

### Full ideal

Approximately 45–70 engineer-weeks core, 30–50k LOC, plus 3–6 engineer-weeks per production-grade provider and live conformance sandbox.

Full scope adds:

- Multi-account OAuth grant lifecycle and scope negotiation.
- Managed relay/workload identity with regional routing.
- Direct-provider and relay modes.
- Multi-environment promotion/rollback.
- Drift, renewal, rotation, revocation and teardown.
- Speculative-resource garbage collection.
- Provider cost/quota/rate budgeting.
- Adapter/fragment version canary promotion.
- Replay/time-travel and deterministic reconstruction.
- Signed evidence and integration SBOM.
- Provider development kit and sandbox certification.
- Backstage-quality inventory/search/ownership.
- Zapier/Make-quality history, retry, choice and remediation UX.
- Continuous repair-spec generation.

### Dependencies on sibling buckets

- **Sibling A3:** owns the generic semantic stimulus/observation/evidence contract and negative-control executor. This capability supplies the provider binding and Slack observation adapter.
- **Sibling C:** owns detached post-merge delivery state, fair queue/park semantics, degraded-release handling, and liveness. This capability supplies integration activation stages.
- Existing deploy-on-merge env attachment is a hard dependency.
- Vault scoping must generalize beyond LLM/GitHub refs; current per-run scoping is precise but does not collect integration refs. [plannerRunScopedCreds.ts:65–110](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/plannerRunScopedCreds.ts:65)
- MergeAuthority and jj WorkspaceVcsCore require no competing implementation; only additional immutable proof inputs and invalidation wiring.

Worktrees can parallelize `engine/integrations/**`, capability-DAG support, post-merge stages, and dashboard feature files after contracts freeze. Serialize DB migrations, event registries, schema exports, navigation/`screens.ts`, and land-finalizer changes.

Each implementation PR runs the narrow affected checks, then `just fast-check`, `just ci`, and `just smoke`; provider slices also need a native-gate sandbox/canary smoke. This response is design-only: no files were modified and checks were not run.

## (9) RISKS/UNKNOWNS

- Slack app installation and OAuth consent cannot always be silent. Enterprise Grid policy, admin approval, channel creation, private-channel membership and history-read scopes vary. The honest autonomous state is sometimes `awaiting_grant`, not a fabricated success.
- Plane leakage is the highest security risk. A Tanren operator bot token must never become a product credential without an explicit product grant.
- Managed relay adds a critical production service, egress/data-processing obligations, regionality, availability and abuse controls. Direct mode avoids that dependency but broadens secret exposure.
- Exactly-once external delivery is generally impossible. Implement at-least-once with stable idempotency/deduplication keys and prove observed non-duplication for the validation window.
- Provider APIs are not transactional with Postgres. Every phase needs durable idempotency, ownership, state-unknown reconciliation and compensation.
- Provider eventual consistency can make creation appear absent. Retry must follow observed progress/provider guidance, not arbitrary attempt ceilings.
- Live validation creates real side effects. Use dedicated canary namespaces/channels, correlation markers, rate/cost budgets, cleanup policy and explicit production-side-effect consent.
- Requirement inference can hallucinate a provider or over-request scopes. Keep capability provider-neutral, expose rationale, require follow-up on consequential ambiguity, and fail closed when confidence is insufficient.
- Independent observation may require additional read scopes. If the org grants only `chat:write`, Tanren cannot honestly claim provider-independent Slack proof; it must use a relay receipt/events path or label validation degraded.
- Multi-account migration is substantial because current schema and callers assume one provider connection per org.
- Speculative resources can orphan after rebase, cancellation or requirement supersession. Every created resource needs ownership, lease/retention policy and audited garbage collection.
- Secret leases for provisioning/test can be short-lived; the production application still needs a durable credential strategy. Prefer workload identity or relay; otherwise rotate a project-scoped provider credential rather than injecting an org root token.
- Non-Vault secret backends currently bypass child-token deprivileging. They need equivalent scoped-lease conformance or product integration autonomy should fail closed.
- A live provider call must not become a nondeterministic pre-merge authority. Native-gate fakes/conformance and post-deploy A3 have distinct purposes.
- Post-merge validation cannot retroactively become a merge condition. It governs delivery/demo health and recovery; MergeAuthority remains temporally and structurally the sole land decision.
- Binding drift during a merge race needs typed proof invalidation plus sibling-C fair parking; mapping it to today’s generic queue `blocked` risks head-of-line stalls.
- F2 must not author privileged provider adapters under live credentials. That would let generated code expand its own authority.
- Evidence can be forged if observation comes solely from product output. Require a provider/relay-side receipt or independent read path and bind it to deploy and correlation identity.
- Direct `org_id`, composite tenant FKs and RLS are mandatory, but external provider resources also need tenant-safe naming and ownership checks before any side effect.
- The exact boundaries with sibling A3 and C should be frozen first; otherwise both buckets will independently invent delivery state, proof schemas and retry semantics.

---

← Back to section (1) ideal design in [`integrations.md`](./integrations.md).
