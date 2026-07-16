## (1) IDEAL DESIGN + how it fits the engine + the owned-stack advantages it exploits

Build an Integration Lifecycle Engine, not another caller of `provisionCapability`.

The present implementation has four deeper breaks:

- `provisionCapability` performs grant lookup, discovery, bind/create, persistence, and one success event, but its only general production caller is the HTTP route; it has no spec, behavior, run, environment, binding generation, or proof identity. [provisioningEngine.ts:206–300](/home/trevor/projects/tanren/services/orchestrator/src/engine/integrations/provisioningEngine.ts:206), [routes/integrations/index.ts:113–146](/home/trevor/projects/tanren/services/orchestrator/src/routes/integrations/index.ts:113)
- Forge cannot declare the need structurally. `CaptureBehavior` is strict Given/When/Then, and derivation flattens those strings into acceptance text without an integration requirement. [types.ts:93–103](/home/trevor/projects/tanren/services/orchestrator/src/engine/forge/interview/types.ts:93), [deriveBehaviorSpec.ts:120–156](/home/trevor/projects/tanren/services/orchestrator/src/engine/forge/deriveBehaviorSpec.ts:120)
- Provisioned `secretRefs` never become `project_app_env`, although that table already supports secret references and phase scopes. [integrationProvisioner.ts:131–149](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/integrationProvisioner.ts:131), [provisioningEngine.ts:316–343](/home/trevor/projects/tanren/services/orchestrator/src/engine/integrations/provisioningEngine.ts:316), [schemaIntegrations.ts:68–103](/home/trevor/projects/tanren/db/src/schemaIntegrations.ts:68)
- Slack is the wrong plane and vertically incompatible. `SlackProvisioner` explicitly provisions Tanren’s Plane-A operator channel, not the built product’s Slack behavior. It returns a bot token ref plus channel ID, while the shipped notification channel resolves its destination as an incoming-webhook URL. Persistence selects `botTokenRef` first, so it can resolve an `xoxb-…` token and POST to it as if it were a webhook. [slackProvisioner.ts:1–21](/home/trevor/projects/tanren/services/orchestrator/src/engine/integrations/slack/slackProvisioner.ts:1), [slackProvisioner.ts:182–203](/home/trevor/projects/tanren/services/orchestrator/src/engine/integrations/slack/slackProvisioner.ts:182), [slack.ts:35–68](/home/trevor/projects/tanren/services/orchestrator/src/engine/notifications/channels/slack.ts:35), [provisioningEngine.ts:426–438](/home/trevor/projects/tanren/services/orchestrator/src/engine/integrations/provisioningEngine.ts:426)

The ideal definition of “supported integration” should therefore be:

> Tanren supports an integration only when it can derive the need from a behavior, select or author the application fragment, obtain the least-privilege grant, provision or bind the external resource idempotently, project the binding into speculative tests and the live deployment, and independently observe that the deployed Given/When/Then caused the intended external effect.

### Target lifecycle

```text
Forge G/W/T + DesignContract
        │
        ▼
IntegrationRequirementV1
        │
        ├── fragment selection ── missing fragment → F2 author/validate/persist
        │
        ▼
capability_prepare node in the project DAG
        │ discover → authorize → bind/create canary → materialize test binding
        ▼
ordinary spec node
 writer → checker → auditor → design oracle → native .tanren/ci.yml gate
        │
        ▼
jj speculative/eager integration proof
        │
        ▼
MergeAuthority — sole land decision
        │ authorized land + transactional delivery outbox
        ▼
production reconcile → scoped secret projection → runtime env attach
        ▼
deploy merged SHA → verify deploy
        ▼
A3: establish Given → perform When → independently observe external Then
        ▼
signed evidence → demo complete / degraded delivery / remediation DAG
```

### A. Compile a typed requirement from Forge

Add a strict, versioned `IntegrationRequirementV1` to the interview result and DesignContract:

```ts
interface IntegrationRequirementV1 {
  version: 1;
  capability: "messaging.send" | "errors.capture" | "deploy.release" | string;
  plane: "control" | "product";
  direction: "inbound" | "outbound" | "bidirectional";
  providerPolicy: {
    preferred?: string[];
    allowed?: string[];
    forbidden?: string[];
  };
  environments: Array<"test" | "preview" | "production">;
  trigger: BehaviorStimulusContractV1;
  expectedEffect: IntegrationEffectContractV1;
  requiredOperations: string[];
  requiredScopes: string[];
  bindingOutputs: AppBindingOutputV1[];
  validation: IntegrationValidationPlanV1;
  criticality: "merge_required" | "release_required" | "best_effort";
}
```

Compilation happens twice:

1. Immediately after interview capture validation, before fragment selection, using stable behavior keys. This lets the requirement select integration fragments and preflight grants.
2. Transactionally when real behavior/spec IDs are materialized. The second compilation must hash-match the provisional result or derivation fails loudly.

Current derive provisions deploy before the project and creates the project/entity graph afterward, leaving an activation race. [derive.ts:347–488](/home/trevor/projects/tanren/services/orchestrator/src/engine/forge/interview/derive.ts:347) The ideal creates a project shell in `deriving`, persists the complete behavior/spec/capability graph, then atomically flips it to `active` and wakes DagWalker. DagWalker must ignore ordinary spec work while the graph is incomplete.

### B. Make capability preparation a first-class DAG node

Extend DagWalker’s snapshot into a discriminated union:

```ts
type ProjectDagNode =
  | { kind: "spec"; specId: string /* existing fields */ }
  | { kind: "capability_prepare"; capabilityNodeId: string; requirementId: string; environment: "test" | "preview" };
```

Do not call these `integration_nodes`; that name already means jj-integrated source content. [integrationNodes.ts:1–35](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/integrationNodes.ts:1)

DagWalker remains a scheduler, not a second executor, preserving its current doctrine. [dagWalker.ts:1–27](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/dagWalker.ts:1) It routes:

- Spec nodes to the existing `createQueuedRunFromSpec` path.
- Capability nodes to a provider-operation queue with separate provider/rate-limit concurrency and no LLM runner allocation.

Specs depend on capability nodes. A missing grant parks that capability node as `awaiting_grant`; it consumes neither a runner slot nor a merge-queue slot. Independent ready nodes still advance, matching the existing per-spec isolation behavior. [walker.ts:175–205](/home/trevor/projects/tanren/services/orchestrator/src/engine/dag/walker.ts:175)

Eager preparation creates only reversible, namespaced test/canary resources. Production resources are promoted or reconciled after merge. Shared requirements coalesce onto one project binding, while each speculative run receives its own short-lived lease and correlation namespace.

### C. Separate the integration planes and make contracts vertical

Retain today’s control-plane provisioner for Tanren notifications, inboxes, and deployment providers. Add a distinct `ApplicationIntegrationProvisioner` for the built product.

The provider kit should comprise:

- `IntegrationCatalogAdapter`: capabilities, auth methods, resource kinds, scopes, quotas, regions, data classification, sandbox support.
- `ApplicationIntegrationProvisioner`: `discover`, `plan`, `provision`, `bind`, `observe`, `reconcile`, `rotate`, `teardown`.
- `BindingMaterializer`: converts typed outputs into project config and `project_app_env`.
- `RuntimeDeliveryAdapter`: the protocol the generated product actually invokes.
- `IntegrationEffectProbe`: independently observes the provider-side effect for A3.
- `IntegrationCompensator`: safe rollback/cleanup and ownership-aware teardown.

Conformance must be vertical, not merely per class. The artifact produced by a provisioner must be accepted by its materializer, runtime adapter, and validation probe. That would mechanically catch today’s bot-token-versus-webhook mismatch.

For Slack:

- Keep `slack.control.notify.v1` for Tanren’s own notifications.
- Add `slack.product.message.v1`.
- Default managed mode: the product receives a binding ID, relay URL, and audience-scoped workload credential. Tanren’s relay owns the Slack token, enforces channel/operation/idempotency policy, and returns a durable provider receipt.
- Direct mode: inject a separately authorized product Slack app’s `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`. Never silently reuse the Plane-A bot grant in product code.
- The validation adapter uses the relay receipt, Slack events, or `conversations.history` to independently observe the message. A `chat.postMessage` response trusted solely through the product is not sufficient proof.

### D. Extend fragment/template composition

Add an `integration` fragment phase and `TemplateConfig.integrations[]`. Each fragment declares an `IntegrationFragmentContractV1` containing:

- Logical env inputs and classifications.
- Product API/SDK surface.
- Recording fake.
- Native-gate test recipe and positive evidence.
- Runtime adapter and relay/direct modes.
- A3 trigger and observation driver.
- Compatible provider contract versions.

The existing fragment path already routes missing IDs to one F2 authoring run per fragment and refuses silent fallback. [selectFragmentConfig.ts:18–36](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/selectFragmentConfig.ts:18), [fragmentAuthoringRun.ts:1–20](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/fragmentAuthoringRun.ts:1)

F2 may author application source fragments. It must not hot-author privileged orchestrator provider code while holding credentials. A missing provider adapter becomes an ordinary Tanren maintenance spec/PR that passes adapter conformance, native CI, and MergeAuthority.

### E. Make the binding immutable and proof-bearing

Each spec receives an immutable `IntegrationBindingContractV1` before the writer starts. It contains resource identity, logical env keys, provider/adapter versions, binding generation, desired-state hash, and fake/probe schemas—never secret values.

The test binding generation participates in the existing `appEnvHash`, which is already part of jj proof reuse. Any grant, binding, fragment, or app-env generation change invalidates the proof and forces a re-gate. [integrationNodes.ts:103–140](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/integrationNodes.ts:103)

The native gate remains deterministic:

- Contract/schema tests.
- Recording fake.
- Negative controls.
- Test-binding shape and permission checks.
- No live Slack call as the merge verdict; provider outages must not become nondeterministic merge authority.

The native `CiConfigV1` already demands positive evidence for pre-merge tiers. [schema.ts:192–272](/home/trevor/projects/tanren/services/orchestrator/src/engine/ci/schema.ts:192)

### F. Preserve MergeAuthority and turn landing into release activation

Both direct and native-queue landing already route through one MergeAuthority. [mergeAuthorityGate.ts:1–14](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityGate.ts:1) Do not add an “integration merger,” provider callback, or post-deploy check that can land code.

On authorized land, extend the existing `merge.completed + spec merged` transaction to insert a durable delivery run/outbox row. [mergeAuthorityLandFinalizer.ts:27–60](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityLandFinalizer.ts:27) External provider calls happen only after that transaction commits.

The ideal post-merge delivery DAG is:

```text
reconcile production binding
→ mint activation-scoped Vault lease
→ materialize runtime env generation
→ attach runtime env
→ trigger deploy of merge SHA
→ verify deployment
→ execute behavior stimulus
→ observe provider effect
→ record signed evidence
→ mark delivery complete
```

The current subscriber has only issue → deploy → demo, with catch-and-log isolation. [subscriber.ts:145–167](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/subscriber.ts:145) Replace that fixed chain with a durable, resumable delivery DAG. Runtime binding must precede deploy; current deploy logic already attaches runtime env before triggering the release. [deployOnMerge.ts:263–326](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/deployOnMerge.ts:263)

### G. Owned-stack advantages

This architecture unlocks capabilities point products cannot compose:

- Semantic grant minimization: derive Slack operations and OAuth scopes from the behavior before asking for consent.
- Unified code/resource scheduling: provision reusable resources once, project per-run leases, and garbage-collect abandoned jj speculative work.
- Proof-bound merges: gate evidence is tied to code tree, gate policy, binding generation, runner image, app env, and grant generation.
- Transactional merge-to-release handoff: no “merged but nobody scheduled provisioning” gap.
- Closed-loop repair: drift or A3 failure can generate a typed finding/remediation spec, run the writer/checker/auditor loop, land through MergeAuthority, redeploy, and revalidate.
- Provider-version canaries: promote an adapter version only after conformance, speculative native-gate proof, and real deployed A3 evidence.
- Causal replay: reconstruct the exact jj tree, binding, lease metadata, merge SHA, deploy, stimulus, and observation—not “rerun today’s workflow with old input.”
- Safe multi-environment promotion: test/preview/prod are generations of one declared behavior, with explicit promotion and rollback.
- Independent negative proof: prove that 99 clicks does not notify, the 100th does, retries do not duplicate, revoked access fails durably, and cross-org access is denied.
- Continuous reconciliation: a resource rename, scope loss, token expiry, webhook drift, or external deletion becomes desired-versus-observed state, not a late runtime mystery.

---

## Continue reading

This bucket is split to respect the 500-line source-file cap. Section (1) above is the ideal design and owned-stack advantages; the operational spec continues in this sibling file:

1. [(2) comparator parity, (3) data model, (4) engine integration, (5) HTTP surface, (6) UI/dashboard, (7) apex-provability, (8) effort + phasing, (9) risks/unknowns](./integrations-engine-surfaces-phasing-risks.md)
