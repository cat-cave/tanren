# ds-8 — Ecosystem & cross-org design systems

**Phase**: full (design-system)
**Node ID**: `ds-8`
**Deps**: ds-5 (within-org Studio/reuse), ds-6 (queue/deploy/demo compounding) · SP-3/SP-4
**Node credit**: **0** until independent audit, green gates, and merge

## Purpose and boundary

Add a Figma/external-registry bridge, deliberately sanitized public release projection, expiring share/grant redemption, and destination-owned imports/forks. A foreign release can become a destination-owned quarantined candidate or immutable fork; it never becomes a cross-org row reference or writable source alias.

It builds ON ds-5's `DesignStudioStore.putBinding` and `resolveProjectWebDesignSystem` (`designStudioStore.ts`, `designSystemStore.ts`): their composite `(org_id, design_system_id)` / `(org_id, pinned_release_id)` FKs plus FORCE RLS are the correct within-org boundary. It reuses immutable `design_system_releases`/`design_artifacts`, ArtifactStore, and the Studio mount in `mountFeatureRoutes.ts`. It does NOT weaken `project_design_bindings`, add `OR visibility = 'public'` to tenant policy, or modify a consumer repo directly; a fork/binding upgrade is an ordinary spec subject to `MergeAuthorityV2`.

## Production call graph

Today, `mountFeatureRoutes` → `createDesignStudioRoutes` → `DesignStudioStore.putBinding` → `runWithOrgScope` validates only a same-org published release/channel; the live writer path then calls `resolveProjectWebDesignSystem`.

Ds-8 adds ONE production command entry point, **`DesignEcosystemService.execute`**, behind `POST /v1/orgs/:orgId/design-ecosystem/commands` in a sibling Studio route module. It dispatches publication, share create/redeem, fork/import, Figma pull/push, and registry import as discriminated commands. Narrow public-projection/redeem lookup uses existing `runWithSystemScope` (loud without its BYPASSRLS pool), then destination writes re-enter `runWithOrgScope`; a fork uses existing release/artifact stores and only a destination-owned binding reaches ds-5.

## DesignPublicationV1 and ExternalDesignImportReceiptV1 (frozen Zod contracts)

`engine/design/system/designEcosystemContracts.ts` defines strict versioned contracts. `DesignPublicationV1` is `version: 1` / `schemaVersion: "design_publication.v1"`, carrying only public slug, release/manifest digests, safe preview digest, license/attribution, and publication state—never source, object-store key, secret, or source-org private metadata. `ExternalDesignImportReceiptV1` is `version: 1` / `schemaVersion: "design_external_import.v1"`, a closed `figma|registry` source union with stable external revision, snapshot digest, license verdict, lossiness report, and `quarantined|candidate|rejected` disposition. Command bodies are strict discriminated unions; bearer tokens are input-only and never receipts/events.

## Data model

One migration (**next free slot at build time**) adds no cross-tenant FK into private source tables:

- `published_design_system_releases`: system-owned sanitized projection (`publication_id`, source-release digest, public slug, safe-preview digest, state/revocation); ENABLE + FORCE RLS permits public SELECT only for published, non-revoked rows and system-role writes.
- `design_share_links`: source-org token hash, publication/release reference, permission, expiry, redemption count/limit and revocation; FORCE RLS + composite source-release FK, never plaintext bearer tokens.
- `design_system_grants`: destination-org grant ID, public-projection FK, allowed capability/release digest, expiry/revocation/import policy; FORCE RLS and no FK to a foreign private system.
- `design_imports`: destination-owned system/release FKs, public publication/digest, attribution, sync policy and last-seen upstream; FORCE RLS. A fork copies into existing destination `design_systems` / `design_system_releases`.
- `design_external_imports`: destination-org Figma/registry locator, revision, receipt/artifact digest and quarantine state; FORCE RLS, no credential value.

Every tenant table has `org_id`, direct RLS predicates, and composite FKs to existing `organizations`, `projects` where applicable, and destination design tables. Add `schemaDesignEcosystem.ts`; serialized `schema.ts` only re-exports it.

## Provable / callable / visible

- **Provable**: a conformance-accepted external snapshot emits existing `designSystem.candidate.composed`; only a destination-owned validated fork emits `designSystem.release.published` and its existing `design.artifact.published` CAS record. Grant/redeem/quarantined import invents no success event.
- **Callable**: the command route is org-admin/idempotency-key protected. `GET /v1/public/design-system-releases/:publicationId` returns only `DesignPublicationV1`, never a download; scoped bytes require a redeemed grant or destination ownership.
- **Visible**: existing Design Studio gains publication state, grant expiry, attribution/lossiness, quarantine, and fork lineage; public catalog shows only the sanitized projection and renders revoked/unavailable rather than stale previews.

## Fail-closed proof

The invariant is: knowing an ID or CAS digest never lets an org read, bind, download, or mutate another org's private release. `project_design_bindings` stays same-org; redemption atomically verifies token hash, expiry, revocation, count, allowed digest, and destination before a grant; Figma/registry payload stays quarantined until existing adapter conformance/render proof succeeds. Missing system scope, unknown provider, lossy/unlicensed input, or readback mismatch returns loud error/404 and creates no fork, grant, byte download, publication event, or direct repo change. The gravest fail-open is a public/granted URL exposing source artifacts or letting org B bind org A.

Local proof is route/contract tests plus `just affected-typecheck` / `just affected-test`; adversarial GO must try org B's guessed ID/digest before redemption, an expired/revoked token, and malformed/lossy Figma round trip—each proves zero destination rows/bytes/events. `designEcosystemRoutes.test.ts`, `designEcosystem.rls.integration.test.ts`, and `figmaRegistryBridge.conformance.test.ts` drive real `runWithSystemScope`→`runWithOrgScope` redemption, RLS, quarantine, and destination-fork publication.

## Size / migration

Target ~950 changed lines split among contracts, projection/grant store, bridge adapters, routes, and tests (every file <=500); one migration. It serializes on `db/src/schema.ts` and `services/orchestrator/src/mountFeatureRoutes.ts`, extends Studio, and does not touch `screens.ts` or `main.ts`.

## Acceptance

An authorized Figma/registry snapshot receives a receipt yet stays quarantined until conformance; an accepted import/fork is destination-owned, publication-traceable, and ds-5-bindable without a cross-org reference. Public GET is sanitized; org B has zero private rows/exports/bytes before redemption and after expiry/revocation; later project change follows normal MergeAuthority flow. Finish `just fast-check`, `just ci`, and `just smoke`, then independent adversarial GO with cross-org and malformed-import controls.
