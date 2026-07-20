# ds-7 — Full framework reach

**Phase**: full (design-system)
**Node ID**: `ds-7`
**Deps**: ds-2 (web adapter), ds-4 (A4 gate) · SP-2/SP-5
**Node credit**: **0** until independent audit, green gates, and merge

## Purpose and boundary

Make the design compiler multi-target: `generic-web`, `bevy`, `swiftui`, `jetpack-compose`, `flutter`, `react-native`, and `document-media`, alongside the already-real `web-react`. This is an adapter-registry extension, not seven compilers or an alternate render/gate path.

It builds ON `DesignTargetAdapter` / `DesignTargetAdapterRegistry` in `services/orchestrator/src/engine/design/system/designTargetAdapter.ts`, strict `DesignContractV2.targetProfiles` (`designContractV2.ts`), `FrameworkDesignArtifactManifestV1` (`designArtifactSchemas.ts`), and ds-2's reference implementation (`webAdapter.ts`). The live `composeProjectWebDesignSystem` in `composeProjectWebDesignSystem.ts` directly constructs `WebDesignTargetAdapter`; ds-7 replaces that closed construction with the registry while retaining F2D selection, CAS persistence, release publication, and ds-4's `verifyAndRecordDesignRender` → `resolveDesignRenderGate` path. No framework gets its own composer or gate.
The registry is the only non-web selection mechanism; `web-react` remains a registered implementation, never a fallback for another target.

## Production call graph

Today, `POST /orgs/:orgId/onboarding/interview/derive` (`routes/onboarding/index.ts`) → `deriveFromCapture` → injected `composeDesignSystem` → `buildForgeDesignSystemComposerFactory` → `composeProjectWebDesignSystem` → private `buildWebAdapter` → `WebDesignTargetAdapter.publish` → `persistWebDesignArtifact`.

Ds-7 adds ONE production entry point, **`composeProjectTargetDesignSystems`**, from that same factory callback. It derives current V2 profiles, resolves each required target through `DesignTargetAdapterRegistry`, then uses the existing F2D selector/authorer, `DesignSystemReleaseStore`, ArtifactStore, and ds-4 verdict writer. Adapter modules implement only the frozen interface; they add neither routes, direct EventStore writes, nor another composer/gate.
Publication remains the existing `DesignSystemReleaseStore.publishRelease` transition after evidence, not a conformance-suite authority.

## DesignAdapterConformanceReceiptV1 (frozen Zod contract)

`engine/design/system/adapterConformanceReceipt.ts` defines strict `version: 1` / `schemaVersion: "design_adapter_conformance.v1"`: a closed target union (`web-react`, `generic-web`, `bevy`, `swiftui`, `jetpack-compose`, `flutter`, `react-native`, `document-media`), adapter version, resolved capabilities, artifact/matrix digests, critical proof requirements, positive cases, mandatory negative controls, and outcome. `passed` requires every critical proof and negative control to decisively match; its canonical SHA-256 is persisted. `DesignContractV2` and `FrameworkDesignArtifactManifestV1` remain the sole intent/artifact contracts—no framework-specific contract fork.

## Data model

`design_adapter_conformance_runs` (one migration, **next free slot at build time**) is org/project scoped with `(org_id, id)` PK and composite FKs to existing `projects`, `design_system_releases`, and `design_artifacts`. It records target, adapter version, receipt digest, outcome, and evidence artifact digest; CHECKs admit only frozen target/outcome values and require receipt/evidence for `passed`. ENABLE + FORCE RLS use the direct ds-5 `org_id = current_setting('app.current_org_id', true)` policy. `schema.ts` only re-exports new `schemaDesignAdapterConformance.ts`.
There is no mutable per-framework capability/default table that could turn an unproven target into a pass.

## Provable / callable / visible

- **Provable**: real static/build/export and matrix validation append existing `designSystem.artifact.validated`; successful CAS persistence keeps appending `design.artifact.published`; recorded target scenarios use `designRender.scenario.recorded`. All append through `PgEventStore` in `engine/eventStore.ts`; no new event name.
- **Callable**: `GET /v1/orgs/:orgId/projects/:projectId/design-adapters/:target/conformance` returns receipt/evidence IDs only after org/project authorization.
- **Visible**: extend existing `/projects/:projectId/design-studio` with a target-conformance panel: target, required capabilities, receipt outcome, evidence links, and loud unsupported/inconclusive state.

## Fail-closed proof

The invariant is: a required target is publishable and gate-usable only if its exact registered adapter satisfies every required capability and has a passed receipt for the exact artifact/matrix. `registry.resolve` retains `DesignAdapterNotRegisteredError`; unsupported capabilities retain `UnsupportedDesignCapabilityError` and enter F2D. Failed, absent, corrupt, or stale receipts propagate `inconclusive_infrastructure`, so the ds-4 gate blocks rather than treating a partial platform projection as web success. The gravest fail-open is a Bevy/mobile/document artifact marked green because web checks ran.
The receipt is evidence consumed by the existing gate; it never substitutes for MergeAuthority or an A4 verdict.

Local proof is target-fixture conformance plus `just affected-typecheck` / `just affected-test`; the independent adversarial GO alters a native resource, removes a required capability, and fails the renderer/device, each proving no publish/pass. `frameworkDesignAdapters.conformance.test.ts`, `composeProjectTargetDesignSystems.integration.test.ts`, and `frameworkAdapterConformance.rls.integration.test.ts` exercise real factory/registry/EventStore order and foreign-org zero rows.

## Size / migration

Target ~850 changed lines across small per-adapter modules and fixtures (all files <=500); one migration. It serializes only on `db/src/schema.ts` for the re-export, not `screens.ts`, `main.ts`, or `mountFeatureRoutes.ts`.

## Acceptance

Every target passes the same positive/negative suite and round-trips its manifest through the existing ArtifactStore; the real derive callback composes a non-web target and persists a gate-readable outcome. Unknown target, missing capability, mismatched receipt/artifact, and foreign-org receipt block with no release or success event. Finish `just fast-check`, `just ci`, and `just smoke`, then independent adversarial GO with the negative control.
