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

## (2) COMPARATOR PARITY MATRIX — a table: comparator capability -> how Tanren matches it -> how Tanren EXCEEDS it

| Comparator capability | How Tanren matches it | How Tanren EXCEEDS it |
|---|---|---|
| **Cucumber — Feature, Rule, Scenario, Given/When/Then, Background, descriptions, localization and living documentation.** [Gherkin reference](https://cucumber.io/docs/gherkin/reference/) | Imports and exports lossless `.feature` files; supports Rule/Background/Scenario semantics, descriptions, tags and localized authoring. | Forge authors the authoritative behavior before code exists; every document element maps to a revision, executable plan, deployed verdict and demo segment. |
| **Cucumber — Scenario Outlines, Examples, placeholders, Data Tables and Doc Strings.** [Gherkin reference](https://cucumber.io/docs/gherkin/reference/) | `ExecutableBehaviorPlanV1` has typed examples, tables and document values with one verdict per expanded case. | Example rows can provision isolated org fixtures and drive real external integrations; history remains attached to the semantic row across generated-code changes. |
| **Cucumber — regex/Cucumber Expressions, custom parameter/DataTable/DocString transforms, ambiguous/undefined/pending outcomes.** [Step definitions](https://cucumber.io/docs/cucumber/step-definitions/) | Typed fragments provide expressions, transforms and explicit ambiguous/missing outcomes. | Undefined fragments automatically enter F2; ambiguity blocks compilation, and conformance plus negative controls prove a new binding has real discriminating power. |
| **Cucumber — host-language assertions, hooks, conditional tags, fresh scenario World/state.** [Cucumber API](https://cucumber.io/docs/cucumber/api/), [state guidance](https://cucumber.io/docs/cucumber/state/) | Supports hooks, tags, isolated fixture contexts and rich assertion adapters. | Fixture state is an org-scoped leased resource with cleanup evidence; external systems and deployment identity are part of the World rather than hidden global test state. |
| **Cucumber — parallelism, sharding, ordering, fail-fast and implementation-specific retries.** [Parallel execution](https://cucumber.io/docs/guides/parallel-execution/), [Cucumber-JS runtime options](https://cucumber.github.io/cucumber-js/interfaces/api.IRunOptionsRuntime.html) | Runs example/browser matrices in containerized SSH workers with shards, filters, ordering and explicit retry policies. | Scheduler uses behavioral duration history, fixture conflict graphs and live allocator capacity; exact-node proof reuse avoids rerunning semantically identical deployments. |
| **Cucumber — Messages, progress/pretty/HTML/JSON/rerun/JUnit/TestNG reports, hosted reports and attachments.** [Reporting](https://cucumber.io/docs/cucumber/reporting/) | Exports Cucumber Messages, Gherkin, JUnit, JSON, HTML and artifacts. | First-class history is keyed by behavior revision and deployment, feeds the gate and bisection, and is cryptographically bound to a proof bundle. |
| **Playwright — Chromium, Firefox, WebKit, browser channels, projects, devices, OS and environment matrices.** [Projects](https://playwright.dev/docs/test-projects), [emulation](https://playwright.dev/docs/emulation) | Playwright is the first browser adapter; plans specify browser, viewport, locale, time zone, theme, motion, permissions and device matrices. | Forge and DesignContract choose the matrix from personas and behaviors; Tanren verifies the exact preview and then production artifact rather than a detached test environment. |
| **Playwright — resilient locators, actionability auto-waiting and web-first assertions.** [Locators](https://playwright.dev/docs/locators), [actionability](https://playwright.dev/docs/actionability), [assertions](https://playwright.dev/docs/test-assertions) | Uses role/label/text/test-id locators, auto-waiting, soft assertions, polling, custom matchers and assertion messages. | Selector healing may change only a locator under the same semantic anchor; it can never weaken the expected behavior or silently skip broken product functionality. |
| **Playwright — composable test/worker fixtures, dependency ordering, auth state and isolated BrowserContexts.** [Fixtures](https://playwright.dev/docs/test-fixtures), [isolation](https://playwright.dev/docs/browser-contexts) | Generates typed fixtures and isolated browser contexts with setup/teardown dependencies. | Browser isolation extends to real Tanren orgs, databases, Slack channels, deployment leases and cleanup receipts. |
| **Playwright — worker parallelism, machine sharding, blob-report merging and changed-test filters.** [Parallelism](https://playwright.dev/docs/test-parallel), [sharding](https://playwright.dev/docs/test-sharding), [CLI](https://playwright.dev/docs/test-cli) | Supports workers, shards, merged reports, affected selection and full-suite policy points. | Selection uses behavior↔spec↔source↔integration-node edges authored by Forge and verified by execution; missing an obligation is a gate failure, not an assumed skip. |
| **Playwright — retries, pass/flaky/fail classification, repeat-each, tags, annotations, skip/fixme/fail/slow.** [Retries](https://playwright.dev/docs/test-retries), [annotations](https://playwright.dev/docs/test-annotations) | Supports explicit repetition, tags, policy annotations and retained attempts. | Flake history is persistent and behavior-aware; quarantine cannot waive a required behavior, and Tanren automatically creates a repair spec or respec request. |
| **Playwright — trace timeline, DOM snapshots, source, console, network, screenshots, video and attachments.** [Trace Viewer](https://playwright.dev/docs/trace-viewer), [video](https://playwright.dev/docs/videos) | Retains full Playwright traces, screenshots, video and structured attachments in a content-addressed store. | Artifacts are tied to assertions, provider receipts, gate proof, bisection node, promoted digest and demo—not merely a test attempt. |
| **Playwright — screenshot comparison, masks/tolerances, text snapshots, ARIA snapshots and axe integration.** [Visual comparisons](https://playwright.dev/docs/test-snapshots), [ARIA snapshots](https://playwright.dev/docs/aria-snapshots), [accessibility testing](https://playwright.dev/docs/accessibility-testing) | Matches pixel, semantic accessibility and automated a11y checks. | The expected state comes from a versioned DesignContract; runtime render evidence enters DesignOracle, baseline changes require respec/approval, and semantic layout/token rules supplement pixels. |
| **Playwright — API testing, request routing, HAR replay, network and WebSocket inspection.** [API testing](https://playwright.dev/docs/api-testing), [mocking](https://playwright.dev/docs/mock) | Supports API setup/assertion, request inspection, mocks for narrow local tests and real-network gate profiles. | Pre-merge behavior proof forbids mocks for obligations requiring real integrations and correlates UI actions with actual provider-side effects. |
| **Playwright — component testing, Android, Electron and WebView surfaces.** [Component testing](https://playwright.dev/docs/test-components), [Android](https://playwright.dev/docs/api/class-android) | Adapters expose these surfaces with capability-specific matrices and artifacts. | One behavior can cross surfaces—browser trigger, API receipt, Android result and Slack side effect—under one causal verdict. |
| **Playwright — UI mode, Inspector, VS Code integration and codegen.** [UI mode](https://playwright.dev/docs/test-ui-mode), [codegen](https://playwright.dev/docs/codegen) | Provides interactive replay, locator inspection and deterministic generated test export. | Generation starts from authoritative Forge intent; edits round-trip through a typed plan instead of allowing test code to become a second requirements source. |
| **Playwright — planner, generator and healer agents.** [Test Agents](https://playwright.dev/docs/test-agents) | Uses agents to explore, generate fragments, replay failures and propose locator repairs. | Agents cannot skip a broken product or redefine success. Product failure routes to Writer, verifier failure to F2, visual failure to DesignOracle and intent failure to the separate Answerer/respec loop. |
| **Playwright — HTML/blob/JSON/JUnit/GitHub/custom reporters.** [Reporters](https://playwright.dev/docs/test-reporters) | Produces all common formats and a custom lossless proof reporter. | Reporting is not the terminal use: per-behavior verdicts directly control the native gate, queue bisection, merge authorization, deployment and demo. |
| **Azure Playwright Workspaces — remote browser fleets, high parallelism and portal reporting with traces/screenshots/video.** [Workspace limits](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/resource-limits-quotas-capacity), [reporting](https://learn.microsoft.com/en-us/azure/app-testing/playwright-workspaces/quickstart-advanced-diagnostic-with-playwright-workspaces-reporting) | A remote-browser adapter can use Azure or another fleet while preserving Playwright report fidelity. | Fleet vendor is replaceable behind conformance. Tanren schedules from the behavior DAG, owns target preview capacity and retains authoritative history independently of vendor storage. |
| **Cypress — E2E/component testing, real browsers, `cy.request` and `cy.intercept`.** [Testing types](https://docs.cypress.io/app/core-concepts/testing-types), [network requests](https://docs.cypress.io/app/guides/network-requests) | Browser/API/component adapters cover equivalent surfaces and network assertions. | Cross-surface actions and real provider effects belong to one behavior proof instead of separate test suites joined by naming convention. |
| **Cypress — linked-query retryability, actionability and Chai/Sinon assertion richness.** [Retryability](https://docs.cypress.io/app/core-concepts/retry-ability), [assertions](https://docs.cypress.io/app/references/assertions) | Provides retrying DOM assertions, actionability checks, spies, stubs and rich typed assertions. | Temporal retries use persisted delivery progress and explicit causal watermarks; hidden waiting cannot manufacture a pass. |
| **Cypress — test isolation, fixtures, aliases, hooks, spies, stubs and clock control.** [Test isolation](https://docs.cypress.io/app/core-concepts/test-isolation), [stubs/spies/clocks](https://docs.cypress.io/app/guides/stubs-spies-and-clocks) | Matches local lifecycle and deterministic clock/network controls. | Gate profiles replace mocked effects with leased, real org-scoped resources while still allowing mocks for narrow writer feedback. |
| **Cypress — Command Log/time travel, screenshots, video and Test Replay.** [Screenshots/video](https://docs.cypress.io/app/guides/screenshots-and-videos), [Test Replay](https://docs.cypress.io/cloud/features/test-replay) | Offers action timelines, DOM snapshots, console/network records, screenshots and video. | Replay includes behavior intent, expected/actual assertion nodes, side-effect receipts, jj node and merge decision, not only browser activity. |
| **Cypress Cloud Smart Orchestration — parallelization, dynamic load balancing, failed-spec prioritization and auto-cancel.** [Smart Orchestration](https://docs.cypress.io/cloud/features/smart-orchestration/overview), [load balancing](https://docs.cypress.io/cloud/features/smart-orchestration/load-balancing) | Dynamically assigns shards using historical duration and prioritizes prior failures. | Scheduling also understands fixture contention, DAG critical path, preview capacity, behavior impact and reusable exact-node proofs. |
| **Cypress Cloud — recorded runs, groups, tags, attempts, code history and artifacts.** [Recorded runs](https://docs.cypress.io/cloud/features/recorded-runs) | Retains complete structured runs and artifacts with branch/tag/matrix dimensions. | History survives renamed/generated tests because semantic identity is the immutable behavior revision. |
| **Cypress Cloud — retry-based flaky detection, rates, severity, history and alerts.** [Flaky Test Management](https://docs.cypress.io/cloud/features/flaky-test-management) | Detects fail-then-pass, calculates rates and exposes attempt histories and notifications. | Classification separates product, verifier, infrastructure, visual and external failures; quarantine cannot convert an unproven user behavior into mergeable work. |
| **Cypress Cloud — run/test analytics, duration, top failures, filters and Data Extract exports.** [Analytics](https://docs.cypress.io/cloud/features/analytics/project-analytics), [Data Extract API](https://docs.cypress.io/cloud/integrations/data-extract-api) | Provides live and historical filters, aggregates and CSV/JSON export. | Data is available immediately from Tanren’s own append-only facts and joins intent, deployment, queue, bisection, cost and demo outcomes. |
| **Cypress Branch Review — compare base/change runs, failures, flakes, code and UI-coverage/accessibility deltas.** [Branch Review](https://docs.cypress.io/cloud/features/branch-review) | Compares base and exact prospective integration nodes across verdicts and artifacts. | Comparison operates on jj speculative/eager nodes and can prove or isolate multi-PR interaction failures before any branch lands. |
| **Cypress visual testing through third-party integrations.** [Visual testing](https://docs.cypress.io/app/tooling/visual-testing) | Provides native screenshot, semantic and DesignContract comparison. | Visual authority remains inside the same intent/gate/design-oracle loop; no external tool must infer which behavior or contract clause a pixel change violates. |
| **Cypress UI Coverage — zero-instrumentation interactive-element coverage, trends, result policies and AI generation.** [UI Coverage](https://docs.cypress.io/ui-coverage/get-started/introduction), [test generation](https://docs.cypress.io/ui-coverage/guides/address-coverage-gaps) | Tracks exercised and asserted interactions by rendered view/component and can generate missing plans. | Coverage is requirement-based: 100% clickable-element coverage cannot compensate for an unproven behavior, while one causal behavior may intentionally span many surfaces. |
| **Cypress Accessibility — repeated axe checks, score/history, issue comparison and policy gates.** [Accessibility](https://docs.cypress.io/accessibility/get-started/introduction) | Runs automated accessibility checks at behavior checkpoints with history and gating. | Accessibility expectations are persona- and DesignContract-specific, correlated to actual interaction states, and include focus/ARIA/layout evidence beyond an aggregate score. |
| **Cypress Studio and AI — recorded tests, `cy.prompt`, assertion suggestions and selector self-healing.** [Studio](https://docs.cypress.io/app/guides/cypress-studio), [AI generation](https://docs.cypress.io/app/guides/ai-test-generation) | Supports recording, natural-language plan assistance and bounded selector repair. | Forge intent, fragment hashes and negative controls constrain generation; self-healing cannot mask semantic product drift. |
| **Mergify Test Insights — multi-CI/framework ingestion and JUnit/framework integrations.** [Test Insights](https://docs.mergify.com/test-insights/), [CI status checks](https://docs.mergify.com/integrations/ci-status-checks/) | Ingests JUnit and common reporter formats while maintaining native first-class behavior results. | Reporter ingestion is compatibility only; Tanren directly observes execution and can prove test↔behavior↔deployment identity. |
| **Mergify CI Insights — job/runner health, queue time, duration, utilization, throughput and cost.** [Runner insights](https://docs.mergify.com/ci-insights/runners/) | Exposes worker, browser, preview, fixture and queue capacity metrics. | Resource metrics feed the DagWalker and proof-aware scheduler; they are correlated with behavior critical paths and external-provider constraints. |
| **Mergify — same-SHA flaky definition, weighted detection/confidence/impact and Prevention reruns.** [Detection](https://docs.mergify.com/test-insights/detection/), [Prevention](https://docs.mergify.com/test-insights/prevention/) | Retains same-context attempts, confidence, impact and deliberate repeat execution. | Context includes exact jj tree, artifact, behavior revision, fragment set, deployment, fixture and browser—not merely SHA—and failures can generate a targeted repair spec. |
| **Mergify Auto-Retry — rules over job/pipeline/log state and retry modes.** [Auto-Retry](https://docs.mergify.com/ci-insights/auto-retry/) | Supports typed retry policies for infrastructure, external providers and verified flake signatures. | Tanren retries the smallest behavior shard in the same immutable context and never lets a retry erase the original gate-relevant failure. |
| **Mergify quarantine — manual/automatic, branch scope, reasons, history, recovery, CLI/API/Slack.** [Mitigation](https://docs.mergify.com/test-insights/mitigation/), [quarantine](https://docs.mergify.com/test-insights/quarantine/) | Provides scoped quarantine governance, provenance, expiry, recovery and notifications. | Mergify can ignore a quarantined test’s failure; Tanren cannot waive the underlying behavior obligation. An independent proof or repaired fragment is mandatory. |
| **Mergify — PR summaries, Slack notifications, issues, dashboards, APIs and CLI.** [PR reports](https://docs.mergify.com/changelog/2025-07-31-ci-insights-pr-report/), [Slack](https://docs.mergify.com/integrations/slack/) | Publishes concise PR/check summaries, detailed dashboard history, API and CLI exports. | Reports link directly to Forge intent, actual actions, side effects, bisection and respec/design repair, then control Tanren’s sole merge authority. |
| **Mergify merge-queue retries.** [Queue retry](https://docs.mergify.com/changelog/2026-03-18-automatic-ci-retries-in-merge-queue/) | Supports retrying failed speculative nodes under explicit policy. | Tanren performs behavior-aware prefix bisection and interaction-set reduction over exact jj nodes rather than simply recreating a queue attempt. |
| **GitHub Checks — lifecycle/conclusions, rich summaries, annotations, images, rerun and custom actions.** [Checks guide](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-checks), [Check runs](https://docs.github.com/en/rest/checks/runs) | Publishes one `tanren/gate` Check with per-behavior annotations, images and a details URL. | GitHub is only a projection. The authoritative proof, history, retry policy and merge decision remain inside Tanren’s native gate and MergeAuthority. |
| **GitHub Actions — matrices, include/exclude, fail-fast, max-parallel, dependencies and concurrency.** [Matrix jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations) | Tanren’s SSH workers execute equivalent matrices and DAG dependencies. | The matrix is synthesized from personas, behaviors and DesignContract and deployed as an exact jj node; no GitHub Actions workflow participates in gating. |
| **GitHub — logs, grouped output, annotations, job summaries, cancel and rerun.** [Workflow commands](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions), [reruns](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs) | Provides live structured logs, SSE events, cancellation and replay. | Replay is content-addressed and context-bound; operators can replay one behavior/example/matrix or queue subset without granting GitHub execution authority. |
| **GitHub — arbitrary artifacts, retention, downloads and attestations.** [Workflow artifacts](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflow-artifacts) | Stores JUnit, traces, screenshots, video, reports and signed attestations. | Tanren’s proof manifest includes intent, observations, artifact digest, deployment, queue node and verdict Merkle root; retention is independently governed per evidence class. |
| **GitHub — required checks/deployments and merge queue/merge-group builds.** [Merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | Publishes the native gate as a required external check and recognizes merge-group state. | GitHub never makes the final decision. Tanren’s jj-native speculative/eager queue, runtime bisection and `MergeAuthority` own the complete land decision. |

## (3) DATA MODEL (tables/migrations, entities, org-scoping)

Use ordered, serialized migrations. The labels below are roadmap groupings; actual migration numbers must be allocated when implementation begins.

| Migration | Table/entity | Essential fields and purpose |
|---|---|---|
| RBV-1 | `behaviors` alteration | Add direct `org_id`, `project_id`, `current_revision_id`; backfill through persona/project relationships; reject ambiguous or orphaned rows. |
| RBV-1 | `behavior_revisions` | Immutable `org_id`, `project_id`, `behavior_id`, revision number, persona, Given/When/Then, acceptance body, tags/examples, content hash, authoring provenance, supersession relation. |
| RBV-1 | `spec_behavior_revisions` | Bind a spec to the exact behavior revision it promises to implement, not a mutable behavior identity. |
| RBV-2 | `behavior_verification_plans` | Behavior revision, DesignContract revision, compiler/schema version, typed plan JSON, plan hash, status, unresolved capability list and provenance. |
| RBV-2 | `verification_fragments` | Stable fragment identity, org/project ownership, capability key and kind. |
| RBV-2 | `verification_fragment_versions` | Immutable source path, jj change/tree, content hash, contract version, conformance status and supersession. Executable code remains in VCS. |
| RBV-2 | `verification_plan_fragments` | Exact plan-step-to-fragment-version binding and source span. |
| RBV-2 | `behavior_coverage_edges` | Versioned behavior→spec/source/component/integration/design/dependency edges for affected selection and completeness checks. |
| RBV-3 | `verification_environments` | Integration node, artifact digest, deployment target, preview/production identity, environment fingerprint, test-tenant lease and lifecycle status. |
| RBV-3 | `behavior_verification_runs` | Purpose, run/spec/batch/integration node, prepared head/tree, plan-set hash, runtime-context hash, deployment, status and policy. |
| RBV-3 | `behavior_verification_attempts` | Behavior revision, plan, example, matrix, shard, seed, replay relation, outcome, classification, timing, failure signature and artifact manifest. |
| RBV-3 | `behavior_verdicts` | One final verdict per required behavior/case/matrix in a run; required assertion count, executed assertion count, attempts, stability and gate effect. |
| RBV-3 | `behavior_assertion_observations` | Typed expected/actual values, comparison operator, temporal/set semantics, redaction class and pass/fail. |
| RBV-3 | `behavior_effect_observations` | Trigger ID hash, observer/provider, provider object hash, cursor/watermark, occurrence count, latency and duplicate/missing classification. |
| RBV-3 | `verification_artifacts` | Content hash, object-store key, MIME/kind, size, encryption/redaction state, retention, producing attempt and manifest membership. |
| RBV-4 | `design_visual_checkpoints` | DesignContract revision, behavior revision, state, viewport/theme/locale matrix and deterministic rules. |
| RBV-4 | `design_visual_baselines` | Immutable baseline artifact, environment fingerprint, approval actor/reason and supersession. |
| RBV-4 | `design_render_verdicts` | Actual/baseline/diff, DOM/a11y/token artifacts, rule results and DesignOracle finding linkage. |
| RBV-5 | `behavior_quarantines` | Behavior revision, fragment version, matrix scope, evidence, owner, reason, expiry, exit criteria, replacement proof and generated repair spec. |
| RBV-5 | `gate_proof_bundles` | Signed bundle, exact head/tree/node/artifact/context bindings, required/passed counts, verdict/artifact roots, issuance and invalidation. |
| RBV-5 | `integration_proofs` alteration | Add `gate_proof_bundle_id` and explicit `runtime_behavior_context_hash`; old proof keys become non-reusable under V2. |

The current database gives personas direct org/project scope while behaviors depend on persona scope in [schema.ts:359–409](/home/trevor/projects/tanren/packages/db/src/schema.ts:359). Current RLS therefore reaches behaviors indirectly in [0000_collapsed_baseline.sql:980–997](/home/trevor/projects/tanren/packages/db/migrations/0000_collapsed_baseline.sql:980). Runtime evidence is too sensitive and high-volume for that ambiguity.

Required tenancy rules:

- Every tenant-owned table has a direct, non-null `org_id`.
- Project-specific rows also have non-null `project_id`.
- Composite foreign keys include `(org_id, project_id, referenced_id)` to prevent cross-tenant joins even if application code errs.
- `ENABLE ROW LEVEL SECURITY` and `FORCE ROW LEVEL SECURITY`.
- Policies use transaction-local org/project settings and have both `USING` and `WITH CHECK`.
- Repositories require an org-scoped context object; no unscoped list or artifact lookup.
- Artifact object keys are org-prefixed, encrypted and accessed through short-lived authorized URLs.
- Secrets are represented only by grant/reference IDs and resolved inside adapters.
- Observation payloads are schema-redacted before persistence. Provider tokens and message bodies never enter events.
- Behavior revisions, attempts, observations, verdicts and proof bundles are append-only; corrections create superseding rows.

All lifecycle events must still be appended through [eventStore.ts:82–149](/home/trevor/projects/tanren/services/orchestrator/src/engine/eventStore.ts:82), preserving Tanren’s sole event-writer invariant. Operational fact tables are written through scoped repositories; events carry IDs, hashes and classifications rather than duplicating sensitive bodies.

For compatibility, project each attempt into the existing `ci_test_results` table with an identity such as:

```text
behavior:<behavior-revision>:<example-hash>:<matrix-hash>
```

That makes generic CI analytics and exports work—and eliminates the current zero-result blind spot—but `ci_test_results` remains a projection. First-class behavior tables are authoritative.

## (4) ENGINE INTEGRATION (which DAG stage / gate / merge-queue / post-merge hook)

| Engine point | Runtime behavior integration | Effect |
|---|---|---|
| Forge interview | Ask for missing surface, fixture, action, expected observable, failure state and design checkpoint. Create immutable behavior revisions. | Ambiguous/unobservable intent stays in interview or becomes `needs_respec`. |
| DesignContract synthesis | Bind behavior states to visual/semantic checkpoints. | Design obligations become executable rather than static checklist coverage. |
| Plan compilation | Compile all GWT revisions into `ExecutableBehaviorPlanV1`; validate completeness and negative controls. | Produces plan hashes or typed missing-fragment obligations. |
| F2 fragment stage | Schedule one prerequisite per missing capability through `DagWalker`; author, conformance-test and compose to a fixed point. | No fallback step or invented locator can enter execution. |
| Spec DAG construction | Add plan, fragment, fixture, preview and integration dependencies. | Runtime proof remains part of the existing DAG, not a second scheduler. |
| Writer `per_iteration` | Run narrow affected behavior plans against an iteration deployment when useful; always run fragment and plan conformance. | Fast proof feedback goes directly to Writer/fixer. |
| Checker/Auditor `pre_audit` | Deploy the exact spec head; execute linked behaviors and rendered DesignContract checks. | Static coverage is supplemented by runtime evidence before audit. |
| SPECULATIVE/EAGER queue | Build/deploy exact ready integration nodes as soon as their dependencies and fixture leases are available. | Expensive proof is overlapped and cached safely. |
| Native `pre_merge` gate | Execute all affected behaviors and transitive invariants on the exact integration node. Combine with all `.tanren/ci.yml` tiers. | Mandatory composite verdict; no GitHub Actions. |
| Merge-queue failure | Classify failure and run behavior-aware prefix/subset checks. | Finds product culprit or interaction set; infrastructure does not falsely blame a PR. |
| MergeAuthority | Validate signed proof bundle, exact-head binding, completeness and freshness. | Sole decision to land or reject. |
| Deploy-on-merge | Promote the already-proven artifact digest. | No rebuild gap. |
| Post-merge hook | Re-execute required production-safe behavior plans against production. | Detects config, routing, credential and provider differences. |
| Demo engine | Build the demo from passing production behavior verdicts and artifacts. | Every demo statement has a real assertion and evidence. |

`DagWalker` already exists as the persistent scheduler abstraction in [dagWalker.ts:1–27](/home/trevor/projects/tanren/services/orchestrator/src/engine/contracts/dagWalker.ts:1). The ideal implementation adds node kinds and readiness requirements; it does not create a separate behavior runner with its own orchestration semantics.

### Gate execution policy

- `per_iteration`: affected behaviors and fragment conformance; a preview may be reused only if its exact tree and context match.
- `pre_audit`: every behavior directly owned by the spec plus changed DesignContract checkpoints.
- `pre_merge`: all affected behavior revisions, their invariants and the required browser/integration matrix.
- Release/periodic proof: full project behavior corpus against production-safe fixtures.
- A missing plan, missing adapter, zero executed assertions, unacquired required fixture or absent artifact is a failure/inconclusive blocker—not a skip.

Impact selection can reduce work early, but pre-merge completeness is checked against the behavior graph. “Not selected” must be justified by a persisted edge analysis; unknown impact expands execution.

### Proof reuse

The current reuse check is exact and fail-closed over six context components in [integrationProofReuse.ts:100–155](/home/trevor/projects/tanren/services/orchestrator/src/engine/dag/integrationProofReuse.ts:100). V2 adds an explicit runtime component:

```text
runtimeBehaviorContextHash = H(
  required behavior revisions,
  plan hashes,
  fragment versions,
  compiler version,
  DesignContract versions,
  artifact digest,
  deployment/surface fingerprint,
  fixture data and integration grants,
  adapters and browser/device versions,
  secret-version identifiers,
  policy
)
```

It must be a separate proof-key field, not hidden in a generic environment hash. Any mismatch invalidates reuse.

### Merge-queue bisection

The current batch coordinator already integrates, checks, bisects, removes a culprit and reforms the batch in [batchCoordinator.ts:222–285](/home/trevor/projects/tanren/services/orchestrator/src/engine/merge/batchCoordinator.ts:222). Extend it as follows:

1. Prove the base node passes the failing behavior under the same context.
2. Reuse the failing behavior, examples and matrix as the initial discriminator.
3. Use prefix bisection where monotonicity holds.
4. If no singleton reproduces the failure, run delta-debugging over subsets to identify a minimal interaction set.
5. Persist every tested node, deployment and behavior proof.
6. Run the full effective gate on the surviving reformed batch.
7. Do not attribute `inconclusive_infrastructure` or `inconclusive_external` to a member.
8. A visual failure routes through DesignOracle; a verifier-contract failure routes to F2; an ambiguous contract routes to Answerer/respec.
9. Only `MergeAuthority` turns the resulting proof into a land decision.

### Post-merge failure policy

A failed production re-proof should:

- Mark the deployment unverified.
- Pause dependent queue promotion.
- Roll back to the last production-proven artifact when the behavior is rollback-safe.
- Create a P0 regression or respec DAG node with the full proof bundle.
- Notify operators with the failing behavior and concrete assertion.
- Prevent the demo from claiming the behavior passed.

## (5) HTTP SURFACE (endpoints)

All public endpoints are under:

```text
/orgs/:orgId/projects/:projectId
```

They require org/project membership, use opaque IDs and never accept a caller-supplied secret value.

### Behavior contracts

- `GET /behaviors/:behaviorId/revisions`
- `GET /behaviors/:behaviorId/revisions/:revisionId`
- `POST /behaviors/:behaviorId/revisions` — explicit respec/revision, never in-place mutation.
- `GET /behaviors/:behaviorId/verification-plan`
- `POST /behaviors/:behaviorId/verification-plan/compile`
- `POST /behavior-verification-plans/:planId/validate`
- `GET /behavior-verification-plans/:planId/fragments`
- `GET /behavior-verification-plans/:planId/export?format=gherkin|plan-v1|cucumber-messages|playwright`

Compilation is idempotent on behavior revision, DesignContract revision and compiler context.

### Runs, attempts and evidence

- `POST /behavior-verification-runs` — authorized manual/canary execution.
- `GET /behavior-verification-runs?runId=&behaviorId=&status=&purpose=&integrationNodeId=`
- `GET /behavior-verification-runs/:verificationRunId`
- `GET /behavior-verification-runs/:verificationRunId/verdicts`
- `GET /behavior-verification-runs/:verificationRunId/attempts`
- `GET /behavior-verification-runs/:verificationRunId/artifacts`
- `GET /behavior-verification-runs/:verificationRunId/artifacts/:artifactId`
- `POST /behavior-verification-runs/:verificationRunId/replay`
- `POST /behavior-verification-runs/:verificationRunId/cancel`
- `GET /behavior-verification-runs/:verificationRunId/events` — resumable SSE.
- `GET /runs/:runId/behavior-verdicts`
- `GET /behaviors/:behaviorId/verdict-history`

Replay defaults to the exact stored context. Any override creates a visibly different run and proof key. Mutating requests require idempotency keys and record actor/reason events.

### Governance and design

- `GET /behavior-quarantines`
- `POST /behavior-quarantines`
- `POST /behavior-quarantines/:quarantineId/clear`
- `GET /behavior-quarantines/:quarantineId/evidence`
- `GET /design-visual-checkpoints/:checkpointId/history`
- `POST /design-visual-baselines/:baselineId/approve`
- `POST /design-visual-baselines/:baselineId/reject`
- `POST /behaviors/:behaviorId/respec`

Baseline approval cannot originate from the implementation agent whose change produced the new image.

### Queue and proof

- `GET /merge-queue/nodes/:integrationNodeId/behavior-proof`
- `GET /merge-queue/batches/:batchId/bisection`
- `GET /gate-proof-bundles/:proofBundleId`
- `GET /gate-proof-bundles/:proofBundleId/export`
- `POST /gate-proof-bundles/verify` — verifies schema/signature/hash bindings without rerunning.
- `GET /deployments/:deploymentId/behavior-proof`
- `GET /demos/:demoId/behavior-evidence`

### Internal observer surface

Use one-use, lease-bound service authentication:

- `POST /internal/behavior-verification/observers/:leaseId/events`
- `POST /internal/behavior-verification/observers/:leaseId/watermarks`
- `POST /internal/behavior-verification/deployments/:deploymentId/receipts`

These endpoints carry correlation hashes, provider handles and cursors—not credentials or unrestricted message payloads.

The existing behavior API currently exposes free metadata rather than an executable contract in [routes/behaviors/index.ts:20–50](/home/trevor/projects/tanren/services/orchestrator/src/routes/behaviors/index.ts:20); retain read compatibility but reject new runtime semantics encoded as arbitrary metadata.

## (6) UI/DASHBOARD SURFACE (what the operator sees + any exportable/validateable artifact)

### Project Behavior Proof Matrix

One row per behavior revision and columns for:

- Plan state.
- Surface and required matrix.
- Latest preview verdict.
- Latest production verdict.
- Assertion count.
- Stability/flake state.
- DesignContract state.
- External integration state.
- Owning specs.
- Last proven artifact.
- Demo evidence.

“Reachable” and “behavior proven” are distinct. Zero behaviors, zero assertions or zero results are red/unknown, never green.

### Behavior detail

Show:

- Given/When/Then and persona.
- Expanded examples.
- Compiled step graph and fragment versions.
- Real surface and fixtures.
- Expected assertion tree.
- Revision history.
- Per-matrix verdict history.
- Related specs/source/design checkpoints.
- Generated negative controls.
- Export actions.

### Run detail

The current run page renders only BDD behavior IDs in [RunDetailBody.tsx:283–295](/home/trevor/projects/tanren/services/dashboard/src/components/runDetail/RunDetailBody.tsx:283). Replace that with an assertion timeline:

```text
fixture acquired
→ deployed preview ready
→ browser action
→ application receipt
→ external provider observation
→ assertion
→ cleanup
→ verdict
```

Each node links to logs, trace, video, screenshot, DOM, network, console or provider receipt.

### External-effect causality viewer

For A3, show:

- `100 UI triggers`
- `100 application completions`
- `100 Slack observations`
- `0 missing`
- `0 duplicate`
- Correlation-set comparison.
- Delivery distribution.
- Provider cursor/watermark.
- Redaction state.

Operators can expand a trigger into its action screenshot, app receipt and Slack provider object hash.

### Visual verification workspace

Provide:

- Baseline / actual / diff tri-pane.
- Pixel heat map and overlay slider.
- DOM and accessibility-tree diff.
- Design token and computed-layout differences.
- Viewport/theme/locale selector.
- DesignContract clause links.
- DesignOracle explanation.
- “Fix implementation,” “respec contract,” and privileged “approve new baseline” paths.

### Merge-queue view

Show:

- Exact jj node and member set.
- Preview deployment/artifact.
- Behavior shards in flight.
- Proof-reuse decisions.
- Failing behavior and classification.
- Prefix/subset bisection tree.
- Minimal culprit or interaction set.
- Reformed batch.
- Final MergeAuthority decision.

### Flake and quarantine workspace

Show persistent behavior-level history, failure signatures, affected matrices, owner, expiry, exit criteria and generated repair spec. Clearly distinguish:

- Product flake.
- Verifier flake.
- Infrastructure instability.
- External provider instability.
- Visual nondeterminism.

Never label a quarantined, otherwise-unproven behavior as passed.

### Exportable and independently validatable artifacts

Operators can export:

- `BehaviorProofBundleV1` — signed JSON/CBOR manifest.
- Gherkin `.feature`.
- Cucumber Messages.
- Generated Playwright source.
- JUnit XML.
- SARIF/GitHub annotations.
- Trace/video/screenshot bundles.
- Design baseline/actual/diff bundle.
- Redacted causal side-effect ledger.

A CLI command such as:

```sh
tanren proof verify behavior-proof-bundle.json
```

validates schema, signature, artifact hashes, behavior/plan completeness, exact artifact binding and event-root consistency offline.

The existing review UI is a manual checkbox exercise in [ReviewBody.tsx:284–325](/home/trevor/projects/tanren/services/dashboard/src/components/review/ReviewBody.tsx:284). Keep human review for intent and baseline governance, but do not ask operators to eyeball evidence that Tanren can execute and assert.

## (7) APEX-PROVABILITY (which events/artifacts prove it fired live)

Define one mandatory apex workflow, `apex-runtime-behavior-proof`, that proves the whole architecture rather than isolated units.

### Apex behavior

```gherkin
Given notifications are enabled for a dedicated Tanren organization
And a real Slack workspace and empty leased channel are connected
When an operator clicks "Send notification" 100 times in the deployed UI
Then exactly 100 distinct Slack messages land in that channel
And no notification is missing or duplicated
And the rendered confirmation state matches the DesignContract
```

### Positive-path proof

The apex run must prove:

1. Forge created an immutable behavior revision.
2. The compiler produced a non-empty plan with action, external observer and visual assertion fragments.
3. F2 authored at least one deliberately absent fragment and passed isolated/full composition plus a negative control.
4. An exact speculative jj node was built into artifact digest `D`.
5. `D` was deployed to a real preview.
6. Playwright made 100 real clicks.
7. The application produced 100 completion/delivery receipts.
8. The Slack provider API returned 100 distinct messages past the recorded cursor.
9. Trigger and effect sets were equal.
10. The headless render passed DesignContract pixel, semantic and accessibility assertions.
11. Every behavior verdict had `executed_assertion_count > 0`.
12. The native gate recorded the runtime proof.
13. `MergeAuthority` authorized the exact node using that bundle.
14. The same digest `D` was promoted.
15. The production-safe behavior rerun passed.
16. Demo evidence referenced the production verdict rather than a `/` probe.

### Required events

Add registered schemas for:

- `behavior.contract.compilation_started`
- `behavior.contract.compiled`
- `behavior.contract.rejected`
- `behavior.fragment.missing`
- `behavior.fragment.authoring_started`
- `behavior.fragment.validated`
- `behavior.verification.started`
- `behavior.shard.started`
- `behavior.attempt.started`
- `behavior.action.observed`
- `behavior.assertion.observed`
- `behavior.effect.observed`
- `design.render.captured`
- `design.render.verdict_recorded`
- `behavior.verdict.recorded`
- `behavior.verification.completed`
- `gate.behavior_proof.bound`
- existing composite `gate.verdict`
- `integration.proof.recorded`
- `integration.proof.reused`
- `merge.batch.behavior_failed`
- `merge.batch.bisecting`
- `merge.batch.culprit_set_identified`
- `behavior.respec.requested`
- `post_merge.behavior.verified`
- `post_merge.behavior.failed`
- `deployment.promoted`
- `deployment.rolled_back`
- existing `demo.evidence.recorded`, extended with proof references

Every event is emitted through `eventStore.ts`; payloads contain stable IDs, hashes, counts and classifications.

### Required artifacts

- Immutable behavior revision and Forge provenance.
- Executable plan and fragment manifest.
- Fragment conformance and negative-control results.
- jj tree and integration-node manifest.
- OCI provenance/attestation.
- Preview and production deployment fingerprints.
- Browser trace and video.
- Action screenshots.
- DOM and accessibility snapshots.
- Network/console logs.
- Slack cursor, provider object hashes and causal-set report.
- Baseline, actual and diff images.
- Per-attempt results.
- Per-behavior verdicts.
- Native CI evidence.
- Signed gate proof bundle.
- MergeAuthority decision.
- Queue-bisection tree.
- Production verification and demo evidence.

### Negative apex proofs

The apex suite must also demonstrate that the system catches failures:

1. **Assertion sensitivity:** a child jj node disables Slack emission. The generated behavior fails, `MergeAuthority` blocks it and the bad node never lands.
2. **Visual sensitivity:** alter a required token/layout state. Runtime visual verification fails and produces a DesignOracle finding tied to the exact contract clause.
3. **Queue bisection:** place the bad member in a multi-member speculative batch; Tanren records base/prefix proofs and identifies it.
4. **Interaction failure:** split the defect across two individually passing members; subset reduction returns a two-member culprit set.
5. **Verifier defect:** corrupt the Slack observer fragment; classification routes to F2 rather than blaming product code.
6. **External outage:** deny provider availability; the outcome is inconclusive and blocks without falsely identifying a code culprit.
7. **Cross-tenant attack:** attempt to read another organization’s artifacts/verdicts; RLS and object authorization deny it.
8. **Proof replay:** submit a proof for a different tree, artifact, deployment or expired context; `MergeAuthority` rejects it.
9. **Baseline laundering:** attempt to approve a new baseline from the implementation agent; policy rejects it.
10. **Demo honesty:** remove proof evidence; the demo becomes unverified instead of falling back to `/`.

The database-level apex invariant is:

```text
required_behavior_revision_count
  = validated_plan_count
  = required_verdict_count
```

and a passing gate additionally requires:

```text
every required verdict = passed
AND every required verdict.executed_assertion_count > 0
AND gate proof artifact digest = promoted artifact digest
```

`ci_test_results` must be non-zero as a compatibility projection, while first-class behavior tables prove the stronger identity.

The apex workflow must drive only public HTTP/dashboard surfaces and real provisioned resources, with database/artifact reads used only for verification. That fits the no-mocks end-to-end requirement in [architecture-checks.md:53](/home/trevor/projects/tanren/docs/contracts/architecture-checks.md:53).

## (8) EFFORT + PHASING (MVP vs full, rough size, deps on sibling buckets)

The brief forbids time estimates in [PROJECT_BRIEF.md:1314](/home/trevor/projects/tanren/PROJECT_BRIEF.md:1314), so effort is expressed as specifications, PRs, migrations, contracts and non-generated code size.

### MVP: production-safe vertical slice

The MVP should cover all four mandates narrowly, not postpone A3/A4:

- Immutable behavior revisions.
- Compiler and typed assertion DSL.
- F2 fragment workflow.
- Browser/API execution through Playwright.
- One real Slack side-effect observer.
- One rendered DesignContract browser/viewport path.
- Fly preview deployment, immutable promotion and teardown.
- Content-addressed artifact storage.
- Per-behavior attempts/verdicts/history.
- Effective native gate and `GateProofBundleV2`.
- MergeAuthority enforcement.
- Speculative/eager queue integration and prefix bisection.
- Proof-backed production demo.
- Basic Behavior Proof Matrix and artifact viewer.
- Gherkin, JUnit and signed proof exports.
- Positive and negative apex workflow.

Rough size:

- 24–32 owned roadmap specs.
- 20–28 PRs.
- 3–4 serialized migration batches.
- 7–9 new or materially extended contracts with conformance suites.
- Approximately 20–30k lines of non-generated TypeScript/SQL/tests/docs.
- Roughly 10–14 first-class tables plus alterations.
- Significant Fly, Playwright, Slack, object-store and dashboard integration testing.

### Full ideal

Add:

- Full browser/device/locale/theme matrices.
- CLI, package, desktop, mobile and component adapters.
- Email, webhook, queue, payment and database side-effect observers.
- Interaction-set reduction and cross-behavior invariant analysis.
- Adaptive distributed scheduling and capacity economics.
- Full DesignContract semantic/layout/token/a11y engine.
- Persistent flake confidence, root-cause clustering and quarantine governance.
- Automatic verifier repair and intent-aware respec DAGs.
- Production canaries and periodic full behavior corpus.
- Cross-project/org reusable fragment catalogs with trust policies.
- Advanced causal and performance assertions.
- Historical behavior-risk models.
- Cloud browser-fleet adapters.
- Rich comparison, analytics and replay UI.
- Proof transparency log and long-term attestation/export tooling.

Rough total program size:

- 50–75 roadmap specs.
- 45–65 PRs.
- 6–8 serialized migration batches.
- 12+ adapter/conformance suites.
- Approximately 50–80k lines of non-generated implementation, tests and contracts.
- A substantial ongoing browser/provider conformance corpus.

### Phasing

| Phase | Deliverable | Exit condition |
|---|---|---|
| 0 — authority foundations | Behavior revisions, plan schemas, hashes, artifact manifest, RLS and event contracts. | One behavior compiles deterministically and verifies cross-tenant isolation. |
| 1 — compiler and F2 | Typed DSL, fragment registry, missing-fragment DAG and negative controls. | Every MVP behavior has a validated, non-vacuous plan. |
| 2 — deployed gate | Fly preview lifecycle, Playwright/API executor, evidence store, native gate bundle, MergeAuthority and queue bisection. | A deployed behavior failure blocks and bisects an exact jj node. |
| 3 — causal integrations | Slack fixture/observer, correlation protocol and cardinality assertions. | The real 100-click/100-message apex passes and its negative control fails. |
| 4 — rendered design | DesignContractV2, render capture, deterministic verdicts and DesignOracle routing. | A visual contract regression blocks and produces actionable evidence. |
| 5 — production/demo/UI | Promote-same-artifact, production re-proof, proof-backed demo, history and dashboard. | The promoted artifact and demo are bound to the same behavior proof. |
| 6 — full intelligence | Broader adapters, adaptive scheduler, interaction reduction, flake governance and automatic respec. | Full comparator parity and owned-stack advantages operate across surfaces. |

### Sibling-bucket dependencies

Hard dependencies:

- Preview deploy/apply/promote/rollback lifecycle for Fly.
- Immutable artifact and provenance storage.
- Forge behavior revisioning and interview questions.
- WS-D4a / DesignContractV2 rendered checkpoint semantics.
- Org-scoped integration grants and secret resolution.
- Slack observer permissions and dedicated test workspace/channel strategy.
- Gate proof and `MergeAuthority` contract evolution.
- Integration-proof key V2 and queue node deployment identity.
- CI intelligence projections and artifact retention.
- Dashboard API generation and run-detail expansion.

Coordination dependencies:

- Database migrations must be serialized.
- Shared dashboard navigation, `screens.ts`, `main.ts` and generated API contracts must be serialized.
- `MergeAuthority`, gate schemas and integration-proof keys are shared contract files and should land before dependent executor work.
- Roadmap specs must declare owned paths. Browser, Slack, visual, artifact and UI adapters can proceed in isolated worktrees after shared contracts stabilize.
- Every source/config/doc module stays under the 500-line architecture limit; split execution, evidence, visual and observer concerns into separate contract-driven modules.

## (9) RISKS/UNKNOWNS

| Risk or unknown | Consequence | Ideal control |
|---|---|---|
| Generated tests merely restate implementation behavior | False confidence | Compile from immutable Forge intent; require explicit expected observables and counterfactual negative controls. |
| Given/When/Then is ambiguous or not externally observable | Compiler invents semantics | Emit `needs_respec`; Answerer revises intent and affected DAG. Never guess. |
| Locator self-healing masks a broken experience | False pass | Permit only semantic-anchor-preserving locator changes; expected assertions and behavior meaning are immutable. |
| Preview differs from production | Preview passes, live product fails | Promote the same artifact; fingerprint config/routes/integrations; run production proof before demo. |
| External provider eventual consistency | Flake or arbitrary sleeps | Use application receipts, monotonic provider cursors, explicit SLA leases and persisted progress. |
| Slack/API rate limits or cost from 100 real actions | Provider abuse or unstable gate | Dedicated tenants/channels, provider-aware quotas, serialized leases and explicitly budgeted stress behaviors. Correctness obligations cannot silently downscale. |
| Provider cannot expose a causal identifier | Inability to prove trigger/effect mapping | Add production-safe correlation/idempotency instrumentation through a verification-support spec. |
| Destructive or irreversible behaviors | Unsafe acceptance runs | Typed destructive policy, isolated account, compensation fragments, privileged approval and purpose-specific production-safe variants. |
| Fixture leakage or cross-test collision | Flakes and tenant contamination | Org-scoped leases, conflict-aware scheduling, cleanup evidence and quarantine of the fixture adapter—not the behavior. |
| Cross-tenant evidence disclosure | Severe security breach | Direct `org_id`, composite FKs, FORCE RLS, encrypted org-prefixed objects, redacted events and conformance tests. |
| Traces/screenshots contain PII or secrets | Security/privacy incident | Capture classification, DOM/network redaction, secret scanning, encryption, retention classes and audited access. |
| Visual rendering nondeterminism | Noisy gate | Pin browser/fonts/OS/time/animations/data; favor semantic/token/layout assertions; record environment fingerprint. |
| DesignOracle nondeterminism | Unreliable authority | Deterministic comparison gates; oracle only explains/routes. Baseline updates require independent approval. |
| Baseline laundering | Product regression is approved away | Immutable baseline provenance, separate actor/role approval and behavior/DesignContract revision review. |
| Flake quarantine becomes a bypass | Unproven behavior lands | Quarantine only a verifier fragment/matrix; require independent proof of the behavior obligation. |
| Infrastructure failure blamed on a PR | Incorrect queue eviction | Typed classification, base-node reproduction and no culprit attribution from inconclusive runs. |
| Non-monotonic merge failures | Prefix bisection identifies the wrong member | Fall back to subset/delta reduction and represent culprit sets, not only single PRs. |
| Runtime proof makes the queue expensive | Throughput collapse | Affected selection, exact-context proof reuse, eager execution, adaptive shards and fixture-aware scheduling. Never sacrifice mandatory completeness at final pre-merge. |
| Proof reused across materially different contexts | Stale green | Explicit V2 runtime-context hash including behavior, plan, fragment, deployment, fixture, adapter, browser and secret versions. |
| Artifact rebuilt after proof | Proven bits differ from deployed bits | Build once, content-address, attest, promote the exact digest. |
| Proof/event tampering or replay | Unauthorized merge | Signed bundles, Merkle artifact roots, freshness/nonce checks and exact MergeAuthority binding. |
| Compiler/fragment version evolution | History becomes incomparable | Immutable versioned plans/fragments and explicit migrations/recompilation; never reinterpret historical results. |
| Agent “fix” weakens the expectation | Test passes by changing success | Writer cannot edit the behavior revision or baseline; respec requires Answerer and explicit provenance. |
| Existing behavior rows have ambiguous tenancy | Unsafe migration | Backfill through persona/project, audit every row, stop migration on ambiguity and add composite constraints before enabling writers. |
| Fly preview lifecycle semantics are not implemented | A1 cannot be authoritative | Treat preview/apply/promote/rollback/teardown as a hard foundational dependency, not an optional adapter enhancement. |
| Artifact-store provider/retention is undecided | Evidence durability unknown | Finalize storage, encryption, deletion and legal-retention contract before enabling video/network capture. |
| Slack grant lacks message-history scope | A3 cannot observe actual landing | Decide dedicated workspace/channel and least-privilege provider scopes before claiming Slack support. |
| DesignContract does not yet define runtime tolerances | A4 outcomes disputed | WS-D4a must specify deterministic checkpoint, matrix, tolerance and baseline-governance semantics. |
| GitHub annotation limits truncate detail | Poor PR UX | Publish bounded summaries/annotations and link to Tanren’s authoritative proof UI. |
| Provider terms prohibit automated production-like traffic | Legal/operational risk | Maintain provider-specific conformance and policy metadata; use dedicated real test tenants approved for automation. |
| Program breadth creates architectural sprawl | Maintenance burden | Contracts/conformance suites, strict ownership, sub-500-line modules and one DagWalker/gate/authority path. |

The main unresolved product decisions are therefore not whether runtime behavioral verification belongs in Tanren—it does—but which real provider tenants, artifact-retention policy, DesignContractV2 semantics and production-safe execution policies Tanren will standardize first. The architecture should make those explicit contracts while refusing to translate missing decisions into fake green evidence.
