## (1) IDEAL DESIGN + how it fits the engine + the owned-stack advantages it exploits

Build a **Runtime Behavior Proof Graph**, not a richer demo probe.

Today Tanren stores Given/When/Then but not an executable contract: `Behavior` has free-form `metadata`, and creation defaults that metadata to `{}` in [behaviors.ts:9–86](/home/trevor/projects/tanren/services/orchestrator/src/engine/entities/behaviors.ts:9). Forge derives prose acceptance criteria without executable metadata in [deriveBehaviorSpec.ts:71–151](/home/trevor/projects/tanren/services/orchestrator/src/engine/forge/interview/deriveBehaviorSpec.ts:71), and the post-merge loader then discards Given/When/Then entirely in [demoOnDeployReads.ts:94–114](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/demoOnDeployReads.ts:94).

That produces the current weak proof:

- Missing demo routes fall back to `/` in [demoEvidence.ts:42–67](/home/trevor/projects/tanren/services/orchestrator/src/engine/demo/demoEvidence.ts:42).
- Any HTTP status from 200–399 counts as success; no body or behavioral assertion is required in [demoEvidence.ts:97–132](/home/trevor/projects/tanren/services/orchestrator/src/engine/demo/demoEvidence.ts:97).
- The production probe is effectively a GET-with-redirects transport in [demoWebProbe.ts:12–18](/home/trevor/projects/tanren/services/orchestrator/src/engine/demo/demoWebProbe.ts:12).
- App-channel evidence can pass based on metadata presence rather than an observed side effect in [demoAppChannelArm.ts:114–135](/home/trevor/projects/tanren/services/orchestrator/src/engine/demo/demoAppChannelArm.ts:114).
- The DesignOracle explicitly works from static evidence and cannot render the product in [designOraclePrompt.ts:20–24](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/designOracle/designOraclePrompt.ts:20).
- JUnit ingestion is explicitly best-effort and cannot affect the gate in [ingestGateJunit.ts:93–113](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/gate/ingestGateJunit.ts:93). That explains the observed `ci_test_results=0`.
- Demo execution happens after merge, outside the gate, in [subscriber.ts:145–167](/home/trevor/projects/tanren/services/orchestrator/src/engine/postMerge/subscriber.ts:145), while merge authorization currently supplies `demoOutcome: "not_required"` in [mergeAuthorityBundleBuild.ts:189–216](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/mergeAuthorityBundleBuild.ts:189).

### The proposed authority chain

```text
Forge behavior revision
  → deterministic executable-plan compiler
  → fragment/F2 resolution
  → exact jj integration node
  → immutable application artifact
  → deployed preview
  → real-surface actions and assertions
  → per-behavior verdicts and artifacts
  → native gate proof
  → merge-queue bisection
  → MergeAuthority
  → promote the proven artifact
  → production re-proof
  → proof-backed demo
```

The central invariant is:

> A behavior is not covered because source code mentions it, a test name resembles it, or `/` returned 200. It is covered only when its immutable behavior revision has a validated executable plan and that plan produced a passing, assertion-bearing verdict against the exact deployed artifact being considered for merge.

### A. Immutable behavior authority

Introduce `BehaviorRevision`, rather than mutating the meaning of an existing behavior in place. Each revision carries:

- Given/When/Then and acceptance prose.
- Persona and project scope.
- Examples, preconditions, data tables, doc strings and tags.
- Required real surface: browser, API, CLI, package, app channel, external integration, mobile or combinations.
- Required side-effect observables.
- DesignContract version and visual checkpoints.
- Auth, fixture, cleanup and destructive-operation policies.
- Content hash and complete Forge/interview provenance.

The canonical compiler output is `ExecutableBehaviorPlanV1`, not arbitrary JavaScript and not opaque metadata:

```ts
interface ExecutableBehaviorPlanV1 {
  behaviorRevisionId: string;
  behaviorRevisionHash: string;
  given: readonly FixtureStep[];
  when: readonly ActionStep[];
  then: readonly AssertionExpression[];
  examples: readonly ExampleRow[];
  matrix: ExecutionMatrix;
  visualCheckpoints: readonly DesignCheckpointRef[];
  cleanup: readonly CleanupStep[];
  artifactPolicy: ArtifactPolicy;
  flakePolicy: FlakePolicy;
  provenance: PlanProvenance;
}
```

Assertions form a typed tree covering:

- Scalar equality, ordering, ranges, schemas and predicates.
- Sets, bags, cardinality, uniqueness and “exactly once” semantics.
- Eventual assertions with a persisted provider cursor or delivery watermark.
- Causal relations such as `forEvery(trigger), exactlyOne(effect)`.
- HTTP, DOM, accessibility-tree, database-observer and external-provider facts.
- Image, layout, token, contrast and semantic DesignContract assertions.
- Negative assertions and counterfactual sentinels.

The compiler is deterministic. The same behavior revision, DesignContract, fragment set and compiler version must yield the same plan hash. Ambiguous or unobservable requirements produce `needs_respec`, never a guessed selector or a vacuous assertion.

### B. Fragment composition and F2 authoring

Every plan step binds to a versioned fragment with a declared capability:

- `fixture`
- `driver`
- `action`
- `assertion`
- `observer`
- `visual_checkpoint`
- `cleanup`
- `artifact_capture`

This directly extends Tanren’s existing fragment composition in [compose.ts:1–60](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/compose.ts:1) and its per-missing-fragment Plan → Write → Validate loop in [fragmentAuthoringRun.ts:1–20](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/fragmentAuthoringRun.ts:1).

Built-in fragments live in reviewed engine modules. Project-specific fragments live in version control under a `.tanren/verification/fragments/` contract, not as executable database blobs. The database records identities, versions, capability declarations and hashes.

When composition cannot satisfy a step:

1. The compiler emits a typed missing-capability obligation.
2. `DagWalker` creates a verification-support prerequisite.
3. F2 authors one fragment at a time.
4. Each fragment passes schema, security and adapter conformance tests.
5. A negative control proves the assertion fails when the expected effect is removed or corrupted.
6. The whole behavior plan is recomposed and validated.
7. The project’s native gate reviews the fragment like any other source change.

This preserves the existing “fail loudly rather than substitute a fallback” rule documented in [fragments/README.md:120–133](/home/trevor/projects/tanren/services/orchestrator/src/engine/templates/fragments/README.md:120).

### C. Adapters behind contracts

Add contracts with mandatory conformance suites:

- `PreviewDeploymentAdapter`: build immutable artifact, plan, deploy preview, promote, roll back, tear down.
- `BrowserDriverAdapter`: Playwright first; browsers, locators, traces, video, screenshots and accessibility snapshots.
- `ApiDriverAdapter`, `CliDriverAdapter`, `PackageDriverAdapter`, `MobileDriverAdapter`.
- `FixtureLeaseAdapter`: isolated org, account, channel, dataset and cleanup lifecycle.
- `SideEffectObserverAdapter`: Slack first, then email, webhook, payment, queue and database observers.
- `RenderCaptureAdapter`: screenshot, DOM, computed styles, accessibility tree, console and network.
- `ArtifactStoreAdapter`: content-addressed, encrypted, retention-aware evidence.
- `VisualVerdictAdapter`: deterministic comparison rules; the DesignOracle explains and routes failures but does not unilaterally turn them green.

The current deployment contract says preview/apply/promote/rollback remain deferred in [deployAdapter.ts:14–22](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/deployAdapter.ts:14). Runtime proof makes that lifecycle mandatory.

No production adapter may have a “pretend succeeded” implementation. An unavailable adapter yields `inconclusive_external` and blocks merge.

### D. A1: executable acceptance against a deployed product

For each exact jj integration node:

1. Export only a conflict-free tree through `WorkspaceVcsCore`. Its contract already makes jj authoritative and conflicts first-class in [workspaceVcsCore.ts:1–20](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/workspaceVcsCore.ts:1).
2. Build one immutable OCI artifact.
3. Deploy that artifact to an isolated Fly preview.
4. Acquire fixture leases.
5. Execute all affected behavior revisions across their required matrices.
6. Record a verdict only if at least one required assertion executed.
7. Bind all verdicts to the jj tree, integration node, artifact digest, deployment fingerprint and execution context.
8. Promote the same artifact digest after authorization; do not rebuild.

The exact integration-node model already spans speculative, eager, batch, stack and bisect execution in [integrationNodes.ts:23–35](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/integrationNodes.ts:23). Runtime proof becomes another property of that node, not a parallel CI system.

### E. A2: proof-backed demos

`DemoEngine` should consume the same `ExecutableBehaviorPlanV1` and verdict artifacts.

Every demo segment must identify:

- The behavior revision.
- The actual surface exercised.
- The exact action performed.
- The expected assertion.
- The observed result.
- A trace, screenshot, video or provider receipt.
- The production deployment and artifact digest.

Remove `/` fallback and transport-only “success.” An unexercisable behavior is `unverified`; narration cannot substitute for proof. For expensive or destructive behavior, the demo may replay a signed live-proof artifact, but it must disclose that it is replaying the already-observed production result.

### F. A3: real behavior-to-integration causality

For “100 clicks cause 100 Slack messages”:

1. Provision a dedicated real test org and real Slack channel using a fixture lease.
2. Capture the initial Slack cursor.
3. Drive 100 actual UI actions with Playwright.
4. Assign a unique correlation and idempotency identifier to each application transaction.
5. Observe application completion/delivery receipts.
6. Query the real Slack provider API until its monotonic cursor passes the last relevant receipt or the explicit provider SLA lease expires.
7. Assert:
   - 100 completed application triggers.
   - 100 distinct provider-side messages.
   - Exact trigger/effect correlation-set equality.
   - Zero missing effects.
   - Zero duplicate effects.
   - Payload predicates and ordering where specified.
   - Recorded delivery distribution.

8. Store provider object identifiers and salted hashes, not message bodies or credentials.
9. Clean up or archive the channel according to the fixture contract.

If the product lacks a correlation seam, Tanren creates a normal verification-support spec for production-safe observability. It does not infer causality from “the channel has some messages.”

### G. A4: rendered DesignContract verification

Extend the present DesignContract—which has behavior/persona references but no rendered checkpoint model in [designContract.ts:63–127](/home/trevor/projects/tanren/services/orchestrator/src/engine/design/designContract.ts:63)—with `DesignContractV2`:

- Behavior-linked states and checkpoints.
- Viewport, browser, locale, theme, motion and contrast matrices.
- Immutable baseline references.
- Layout constraints and component relationships.
- Token and computed-style expectations.
- Text hierarchy and overflow rules.
- ARIA structure, focus order and accessibility policies.
- Dynamic masks and explicit pixel tolerances.
- Required network/console cleanliness.
- Baseline provenance and approval policy.

The runtime captures:

- Actual, expected and diff images.
- DOM snapshot.
- Accessibility tree.
- Computed tokens and layout.
- Focus traversal.
- Console and network records.
- Playwright trace and video.

Deterministic rules gate the result. The DesignOracle receives those real artifacts to explain the discrepancy, connect it to the relevant contract clause and propose a repair. It may route to Writer or propose a new DesignContract revision, but it cannot silently alter a baseline or expected result.

### H. Native gate and sole merge authority

`CiConfigV1` remains the project-authored native SSH gate. Its existing `when` phases are `per_iteration`, `pre_audit` and `pre_merge` in [ci/schema.ts:3–16](/home/trevor/projects/tanren/services/orchestrator/src/engine/ci/schema.ts:3), and `runGateForWhen` already emits gate verdicts in [runGateForWhen.ts:47–118](/home/trevor/projects/tanren/services/orchestrator/src/engine/workflow/gate/runGateForWhen.ts:47).

Create an engine-owned `EffectiveGatePlanV1`:

```text
EffectiveGatePlanV1 =
  all required CiConfigV1 native tiers
  AND mandatory runtime behavior proof
```

Projects cannot omit or mark the behavior tier `continue-on-error`. GitHub Actions is not involved. GitHub receives only a published `tanren/gate` Check.

The result is a signed `GateProofBundleV2` containing:

- Prepared head and jj tree IDs.
- Integration-node ID and member-set hash.
- Native CI config and gate-result hashes.
- Application artifact digest.
- Preview deployment and surface fingerprints.
- Required behavior-revision set and plan-set hash.
- Per-behavior verdict Merkle root.
- Compiler, fragment, adapter, browser and fixture versions.
- DesignContract versions.
- Runtime context hash.
- Artifact-manifest root.
- Expiration and anti-replay nonce.

`MergeAuthority` remains the only land decision. Its contract is already explicitly fail-closed in [mergeAuthority.ts:1–23](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/mergeAuthority.ts:1). It verifies bundle completeness, signature, freshness and exact-head binding. `demoOutcome: not_required` can remain semantically true because demos are post-merge, but it can no longer stand in for runtime verification: a separate mandatory `runtimeBehaviorOutcome: passed` is required.

### I. Flake hardening without weakening behavior obligations

Each attempt is immutable. A final verdict separates outcome from classification:

- `passed`
- `failed_product`
- `failed_verification_contract`
- `failed_visual`
- `inconclusive_infrastructure`
- `inconclusive_external`
- `cancelled_superseded`

Flake state is orthogonal: `stable`, `suspected`, `confirmed`, `quarantined_fragment`.

Policies support retries, stress repetitions and stable-pass thresholds, matching comparator functionality. But:

- A fail-then-pass is always retained and classified as flaky.
- Blind retries cannot turn a failing behavior green.
- Product assertion failures fail immediately unless a replay is needed for classification.
- Progress comes from persisted evidence, provider cursors or new immutable attempts, not hidden sleeps.
- External lease expiration is inconclusive, not a false product failure.
- Quarantine is scoped to behavior revision, fragment version and execution matrix.
- A quarantine requires owner, reason, expiry, exit criteria and a generated root-cause spec.
- The quarantined assertion continues running.
- It never waives the behavior: merge requires a separate non-quarantined proof of the same obligation or remains blocked.

This is much stronger than the current same-SHA fail/pass heuristic in [ciFlakyTests.ts:1–18](/home/trevor/projects/tanren/services/orchestrator/src/engine/insights/ciFlakyTests.ts:1).

### J. Owned-stack advantages

Tanren can uniquely provide:

1. **Intent-to-proof bijection:** every Forge-authored behavior revision has an executable plan and verdict history.
2. **Exact speculative proof:** behavior evidence is tied to a jj integration node, not merely a branch SHA.
3. **Behavior-aware bisection:** the queue bisects the behavior that actually failed and preserves its deployed context.
4. **Interaction culprit sets:** if no member fails alone, Tanren can find a two-or-more-member interaction rather than blame the first PR.
5. **Build once, prove once, promote the same bits.**
6. **Real integration causality:** org-scoped credentials, application receipts and provider observations are available within one controlled system.
7. **Render-aware design repair:** actual rendered evidence returns directly to DesignOracle and Writer.
8. **Automatic respec:** ambiguous or contradicted intent goes to a distinct Answerer and produces a new behavior revision and affected DAG.
9. **Proof-derived demos:** the demonstration cannot drift away from what was gated.
10. **Counterfactual confidence:** generated negative controls prove that the test detects the failure it claims to detect.
11. **Cross-run behavioral memory:** history follows semantic behavior revisions, not fragile test names.
12. **One authority:** adapters observe, gates prove, queues schedule, but only `MergeAuthority` decides whether work lands.

---

## Continue reading

This bucket is split to respect the 500-line source-file cap. Section (1) above is the ideal design and owned-stack advantages; the operational spec continues in spec order across these sibling files:

1. [(2) Comparator parity matrix, (3) data model, (4) engine integration, (5) HTTP surface](./runtime-comparator-data-engine-http.md)
2. [(6) UI/dashboard surface, (7) runtime-behavior provability, (8) effort + phasing, (9) risks/unknowns](./runtime-ui-apex-phasing-risks.md)
