> Continuation of the runtime bucket. Section (1) ideal design lives in [`runtime.md`](./runtime.md).
> This file holds §6 UI/dashboard surface, §7 runtime-behavior provability, §8 effort + phasing, and §9 risks/unknowns.

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

## (7) Runtime-behavior provability (which events/artifacts prove it fired live)

> The general pipeline emits and asserts the following for **every behavior-gated run**;
> an apex-class fixture merely exercises them all at once. See
> [`apex.md`](../../operator-guide/apex.md) for the binding doctrine.

### Example fixture behavior

```gherkin
Given a behavior-gated product declares N interactions on a target surface
And a real Slack workspace and empty leased channel are connected
When an operator performs N declared interactions in the deployed UI
Then exactly N distinct external effects land on that target surface
And no notification is missing or duplicated
And the rendered confirmation state matches the DesignContract
```

This is one example fixture behavior, not the definition of apex.

### Positive-path proof

The general pipeline proves, for any behavior-gated run:

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

### Negative-path provability (fault detection)

The general pipeline must also demonstrate that it catches failures:

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

The behavior-completeness invariant is:

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

Runtime-behavior verification drives only public HTTP/dashboard surfaces and real
provisioned resources, with database/artifact reads used only for verification. That
fits the no-mocks end-to-end requirement in [architecture-checks.md:53](/home/trevor/projects/tanren/docs/contracts/architecture-checks.md:53).

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
- Positive and negative runtime-behavior verification.

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

| Phase                     | Deliverable                                                                                                             | Exit condition                                                                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0 — authority foundations | Behavior revisions, plan schemas, hashes, artifact manifest, RLS and event contracts.                                   | One behavior compiles deterministically and verifies cross-tenant isolation.                                                     |
| 1 — compiler and F2       | Typed DSL, fragment registry, missing-fragment DAG and negative controls.                                               | Every MVP behavior has a validated, non-vacuous plan.                                                                            |
| 2 — deployed gate         | Fly preview lifecycle, Playwright/API executor, evidence store, native gate bundle, MergeAuthority and queue bisection. | A deployed behavior failure blocks and bisects an exact jj node.                                                                 |
| 3 — causal integrations   | Slack fixture/observer, correlation protocol and cardinality assertions.                                                | The current example fixture's real 100-click/100-message case passes through the normal pipeline and its negative control fails. |
| 4 — rendered design       | DesignContractV2, render capture, deterministic verdicts and DesignOracle routing.                                      | A visual contract regression blocks and produces actionable evidence.                                                            |
| 5 — production/demo/UI    | Promote-same-artifact, production re-proof, proof-backed demo, history and dashboard.                                   | The promoted artifact and demo are bound to the same behavior proof.                                                             |
| 6 — full intelligence     | Broader adapters, adaptive scheduler, interaction reduction, flake governance and automatic respec.                     | Full comparator parity and owned-stack advantages operate across surfaces.                                                       |

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

| Risk or unknown                                           | Consequence                                  | Ideal control                                                                                                                                                            |
| --------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Generated tests merely restate implementation behavior    | False confidence                             | Compile from immutable Forge intent; require explicit expected observables and counterfactual negative controls.                                                         |
| Given/When/Then is ambiguous or not externally observable | Compiler invents semantics                   | Emit `needs_respec`; Answerer revises intent and affected DAG. Never guess.                                                                                              |
| Locator self-healing masks a broken experience            | False pass                                   | Permit only semantic-anchor-preserving locator changes; expected assertions and behavior meaning are immutable.                                                          |
| Preview differs from production                           | Preview passes, live product fails           | Promote the same artifact; fingerprint config/routes/integrations; run production proof before demo.                                                                     |
| External provider eventual consistency                    | Flake or arbitrary sleeps                    | Use application receipts, monotonic provider cursors, explicit SLA leases and persisted progress.                                                                        |
| Slack/API rate limits or cost from 100 real actions       | Provider abuse or unstable gate              | Dedicated tenants/channels, provider-aware quotas, serialized leases and explicitly budgeted stress behaviors. Correctness obligations cannot silently downscale.        |
| Provider cannot expose a causal identifier                | Inability to prove trigger/effect mapping    | Add production-safe correlation/idempotency instrumentation through a verification-support spec.                                                                         |
| Destructive or irreversible behaviors                     | Unsafe acceptance runs                       | Typed destructive policy, isolated account, compensation fragments, privileged approval and purpose-specific production-safe variants.                                   |
| Fixture leakage or cross-test collision                   | Flakes and tenant contamination              | Org-scoped leases, conflict-aware scheduling, cleanup evidence and quarantine of the fixture adapter—not the behavior.                                                   |
| Cross-tenant evidence disclosure                          | Severe security breach                       | Direct `org_id`, composite FKs, FORCE RLS, encrypted org-prefixed objects, redacted events and conformance tests.                                                        |
| Traces/screenshots contain PII or secrets                 | Security/privacy incident                    | Capture classification, DOM/network redaction, secret scanning, encryption, retention classes and audited access.                                                        |
| Visual rendering nondeterminism                           | Noisy gate                                   | Pin browser/fonts/OS/time/animations/data; favor semantic/token/layout assertions; record environment fingerprint.                                                       |
| DesignOracle nondeterminism                               | Unreliable authority                         | Deterministic comparison gates; oracle only explains/routes. Baseline updates require independent approval.                                                              |
| Baseline laundering                                       | Product regression is approved away          | Immutable baseline provenance, separate actor/role approval and behavior/DesignContract revision review.                                                                 |
| Flake quarantine becomes a bypass                         | Unproven behavior lands                      | Quarantine only a verifier fragment/matrix; require independent proof of the behavior obligation.                                                                        |
| Infrastructure failure blamed on a PR                     | Incorrect queue eviction                     | Typed classification, base-node reproduction and no culprit attribution from inconclusive runs.                                                                          |
| Non-monotonic merge failures                              | Prefix bisection identifies the wrong member | Fall back to subset/delta reduction and represent culprit sets, not only single PRs.                                                                                     |
| Runtime proof makes the queue expensive                   | Throughput collapse                          | Affected selection, exact-context proof reuse, eager execution, adaptive shards and fixture-aware scheduling. Never sacrifice mandatory completeness at final pre-merge. |
| Proof reused across materially different contexts         | Stale green                                  | Explicit V2 runtime-context hash including behavior, plan, fragment, deployment, fixture, adapter, browser and secret versions.                                          |
| Artifact rebuilt after proof                              | Proven bits differ from deployed bits        | Build once, content-address, attest, promote the exact digest.                                                                                                           |
| Proof/event tampering or replay                           | Unauthorized merge                           | Signed bundles, Merkle artifact roots, freshness/nonce checks and exact MergeAuthority binding.                                                                          |
| Compiler/fragment version evolution                       | History becomes incomparable                 | Immutable versioned plans/fragments and explicit migrations/recompilation; never reinterpret historical results.                                                         |
| Agent “fix” weakens the expectation                       | Test passes by changing success              | Writer cannot edit the behavior revision or baseline; respec requires Answerer and explicit provenance.                                                                  |
| Existing behavior rows have ambiguous tenancy             | Unsafe migration                             | Backfill through persona/project, audit every row, stop migration on ambiguity and add composite constraints before enabling writers.                                    |
| Fly preview lifecycle semantics are not implemented       | A1 cannot be authoritative                   | Treat preview/apply/promote/rollback/teardown as a hard foundational dependency, not an optional adapter enhancement.                                                    |
| Artifact-store provider/retention is undecided            | Evidence durability unknown                  | Finalize storage, encryption, deletion and legal-retention contract before enabling video/network capture.                                                               |
| Slack grant lacks message-history scope                   | A3 cannot observe actual landing             | Decide dedicated workspace/channel and least-privilege provider scopes before claiming Slack support.                                                                    |
| DesignContract does not yet define runtime tolerances     | A4 outcomes disputed                         | WS-D4a must specify deterministic checkpoint, matrix, tolerance and baseline-governance semantics.                                                                       |
| GitHub annotation limits truncate detail                  | Poor PR UX                                   | Publish bounded summaries/annotations and link to Tanren’s authoritative proof UI.                                                                                       |
| Provider terms prohibit automated production-like traffic | Legal/operational risk                       | Maintain provider-specific conformance and policy metadata; use dedicated real test tenants approved for automation.                                                     |
| Program breadth creates architectural sprawl              | Maintenance burden                           | Contracts/conformance suites, strict ownership, sub-500-line modules and one DagWalker/gate/authority path.                                                              |

The main unresolved product decisions are therefore not whether runtime behavioral verification belongs in Tanren—it does—but which real provider tenants, artifact-retention policy, DesignContractV2 semantics and production-safe execution policies Tanren will standardize first. The architecture should make those explicit contracts while refusing to translate missing decisions into fake green evidence.

---

← Back to section (1) ideal design in [`runtime.md`](./runtime.md).
