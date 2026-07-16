> Continuation of the backhalf bucket. Section (1) ideal design lives in [`backhalf.md`](./backhalf.md).
> This file holds §6 UI/dashboard surface, §7 apex-provability, §8 effort + phasing, and §9 risks/unknowns.

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

| Phase                                | Scope                                                                                                                                                                                                                                   |                                                     Rough size |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------: |
| P0 — truth and provenance foundation | Normalize issue loops/findings, fix external provenance, make triage a real task, harden webhook uniqueness/claims/reconciliation, source lifecycle revisions, basic UI origin badges.                                                  | 6–10 specs; 8–14k production/test/doc LOC; 6–10 engineer-weeks |
| P1 — closed-loop MVP                 | GitHub/manual sources, Fly deployment binding, HTTP/JSON and Playwright DOM contracts, baseline reproduction, production verification, `ResolutionAuthority`, close/reopen outbox/readback, P0 repair routing, minimal proof bundle/UI. |                  14–20 specs; 22–35k LOC; 20–30 engineer-weeks |
| P2 — rich runtime proof              | Full Given/When/Then loading, visual/a11y/trace evidence, A1/A3 runtime-verification reuse, preview/canary checks, counterfactual retention, verification fragments and F2 authoring.                                                   |                  14–22 specs; 20–35k LOC; 20–30 engineer-weeks |
| P3 — comparator breadth              | Sentry, Linear, Jira, Slack/generic, SARIF/CodeQL, dependency/advisory sources, Renovate/Dependabot-equivalent policy, observational/hybrid soak.                                                                                       |                  18–28 specs; 25–45k LOC; 22–34 engineer-weeks |
| P4 — owned-stack apex                | Batch symptom verification and bisect, entity health barriers, progressive rollout/rollback, cross-repo issue loops, failure-aware model routing, organization fix-efficacy learning, signed certificates.                              |                  18–30 specs; 30–50k LOC; 28–42 engineer-weeks |
| P5 — production hardening            | Chaos/restart tests, source drift reconciliation, privacy/retention tooling, proof CLI, fleet analytics, live provider conformance, long-running apex burn-in.                                                                          |                  10–16 specs; 10–18k LOC; 12–20 engineer-weeks |

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

| Risk or unknown                                             | Required mitigation                                                                                                                                                                                             |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A faulty oracle produces false confidence                   | Mandatory old-live baseline, immutable contract hash, independent probe implementation, counterfactual old-artifact replay, proof grades, and explicit contract-version history.                                |
| The report is vague or unreproducible                       | Keep the issue open in `awaiting_reproduction`; request evidence, author an observational contract, or route to an investigation spec. Never infer fixed.                                                       |
| Intermittent symptoms                                       | Statistical sample/window policy, seeded inputs, regional cohorts, active plus passive evidence, and confidence thresholds. Silence alone is not proof.                                                         |
| Production probes cause side effects                        | Dedicated test tenant/principal, idempotent fixtures, cleanup assertions, route/method allowlists, spend/destructive bounds, and explicit approval for dangerous flows.                                         |
| Exact artifact identity is unavailable                      | Extend providers/builders to return OCI/package/store digests and attestations. Downgrade proof grade rather than fabricate identity.                                                                           |
| Cache, CDN, rollout, or multi-region skew                   | Bind evidence to region, route, release cohort, response headers, and settle policy; verify more than one edge when required.                                                                                   |
| Authentication hides the real product                       | Use managed synthetic identities and least-privilege session minting. A 401/403 may prove reachability but never the symptom.                                                                                   |
| Prompt injection from issue bodies/logs                     | Treat source text as untrusted structured data, isolate it from standing instructions, constrain network/tool access, redact secrets, and require adapter-normalized fields.                                    |
| PII in screenshots, traces, or raw payloads                 | Pre-storage redaction where possible, envelope encryption, short retention, region policy, elevated raw access, and auditable deletion.                                                                         |
| Human/provider closes or edits an issue during execution    | Revision/ETag checks, desired-versus-observed state, provider readback, superseding source revisions, and conflict-visible reconciliation.                                                                      |
| External source APIs are unavailable or rate-limited        | Durable outbox, provider idempotency keys, progress-aware retry, reconciliation, and `verified_source_sync_pending` rather than a false closed state.                                                           |
| Hot autonomous repair loops burn budget                     | Evidence-signature fixed-point detection, required new hypothesis/decomposition, budget governance, model escalation, and `needs_attention` when no new information appears. No arbitrary “three attempts” cap. |
| Rollback is unsafe after schema/data migration              | Separate traffic rollback from code/data rollback, require forward-compatible migrations, encode rollback safety in the contract, and escalate irreversible cases.                                              |
| A batch contains several plausible causes                   | Bind contracts to integration nodes, run batch previews, use semantic entity claims, and invoke native bisect before blaming a spec.                                                                            |
| Source adapters disagree on “resolved” semantics            | Provider-specific adapter implementation behind a common desired/observed contract and a shared conformance suite.                                                                                              |
| Mobile/store/manual surfaces cannot be actively probed      | Use device-farm or channel adapters where available; otherwise label evidence `attested`, never `active_causal`.                                                                                                |
| Push webhooks are lost                                      | Push plus periodic provider reconciliation; never make webhook configuration disable the backstop.                                                                                                              |
| System-scope code accidentally crosses tenants              | System scope only discovers IDs; all processing enters org scope. Add composite-org foreign keys, RLS conformance, and cross-org apex assertions.                                                               |
| Signing key compromise or proof retention cost              | Rotatable versioned signing keys, transparency/audit log, evidence tiering, lifecycle deletion, and verification that remains valid after media expiry via hashes.                                              |
| Comparator/provider behavior changes                        | Version adapter capabilities, run scheduled conformance against provider sandboxes, and verify every dependency/image/API pin against upstream before updates.                                                  |
| UI overstates certainty                                     | Distinct visual states for gate, merge, readiness, demo, live symptom, proof grade, and external source readback. A waiver must never render as verified.                                                       |
| A1/A3 contracts are not yet stable enough                   | Freeze their probe/evidence interfaces before P1, or isolate them behind `SymptomProbeAdapter`; avoid parallel bespoke browser stacks.                                                                          |
| Live environment retention for counterfactuals is expensive | Retain prior verified artifacts or create reproducible ephemeral deployments; if unavailable, record the weaker proof grade honestly.                                                                           |
| Scope is operationally large                                | Keep the architecture contract-first and adapter-driven, ship the genuine GitHub/Fly closed-loop MVP, then expand sources and modalities without weakening the authority boundary.                              |

The ambitious cost is justified because this is the point where Tanren stops being an auto-PR generator and becomes an autonomous engineering system that can prove—rather than merely claim—that it repaired the live product.

---

← Back to section (1) ideal design in [`backhalf.md`](./backhalf.md).
