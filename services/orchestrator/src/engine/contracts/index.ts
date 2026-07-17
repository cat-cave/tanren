export * from "./allocator.js";
export * from "./costResolver.js";
// "Tanren owns the engine" (tanren-owns-the-engine.md) — the Wave-0 DESIGN-FREEZE
// seam contracts that replace the 25-method GitHub-shaped VcsProvider with four
// purpose-based seams + their supporting pure types. ADDITIVE: nothing is wired
// into the running engine yet (Wave 1 implements them); these are the durable
// CONTRACT surface the refactor is built on, consumed by the conformance suites
// under tests/conformance/{workspaceVcsCore,codeHost,mergeAuthority,visibilityProjection}.
//   - findings/auditPosture     — findings-only audit + the per-project DORA knob.
//   - money                     — branded NonNegativeFinite (unlimited budget = unrepresentable).
//   - integrationNodes          — the ONE run model + memberKey/proofReuseKey.
//   - workspaceVcsCore          — local VCS-core (jj-first; git fallback).
//   - codeHost                  — minimal host (Tanren lands what it authorized).
//   - mergeAuthority            — the guaranteed, fail-closed land decision.
//   - visibilityProjection      — the best-effort PR/check/comment mirror (harden).
//   - engineSeams               — the pluggable IssueSource + IdentityProvider.
export * from "./findings.js";
export * from "./auditPosture.js";
export * from "./money.js";
export * from "./integrationNodes.js";
export * from "./workspaceVcsCore.js";
export * from "./codeHost.js";
export * from "./mergeAuthority.js";
export * from "./visibilityProjection.js";
export * from "./engineSeams.js";
// Integration-provisioning foundation: the IntegrationProvisioner port
// every provider implements (sentry | slack | deploy.* | …), its registry
// (`buildIntegrationProvisioner`), and the pure `resolveSmartDefault` helper. No
// provider impl is wired in this wave — every kind resolves to the hard-throw
// UnconfiguredIntegrationProvisioner. Conformance lives under tests/conformance.
export * from "./integrationProvisioner.js";
export * from "./internalRpc.js";
export * from "./jobClaim.js";
export * from "./jobQueue.js";
// The mTLS channel CONTRACT (transport-light). The Node impl
// (`mtlsChannelNode.ts`) carries the `node:https`/`node:tls` surface and is
// imported directly by the server/boot, not re-exported here.
export * from "./mtlsChannel.js";
// The run-state WRITE seam contract (transport-light). The
// Direct/Http impls live under `engine/worker/**` (they carry the store / Node
// surface), imported directly by the worker/boot — not re-exported here.
export * from "./runStateWriter.js";
export * from "./recoveryPreparation.js";
export * from "./notificationOutbox.js";
export * from "./secretStore.js";
export * from "./gcpSecretManager.js";
export * from "./awsSecretsManager.js";
export * from "./onePassword.js";
export * from "./secretStoreFactory.js";
// Managed-hosting dimension D — the per-run scoped-credential-access seam: mint a
// short-lived Vault child token scoped to ONE run's credential ref paths and read
// the run's credentials through it (the broad VAULT_TOKEN never reaches a runner).
export * from "./vaultTokenMinter.js";
export * from "./vaultTokenMinterImpl.js";
// The EXECUTION-BACKEND SUBSTRATE seams (v21 Track C) — the named boundaries a
// runner backend must satisfy. The SWAPPABLE BOUNDARY is the RunnerHandle (in
// ./allocator.js, opaque) + these seams:
//   - CommandSubstrate — run a command in the runner (SSH is the one impl today).
//   - FileSubstrate    — put/get/writeFile bytes into the runner (file-over-command).
//   - CredentialMaterializer — write a CLI's credentials into a per-run config home.
//   - ReleaseFinalizer — release the runner + record a reconcilable cleanup outcome.
// (UsageMeter — the metering seam — lives next to its impls in engine/usage.)
export * from "./commandSubstrate.js";
export * from "./fileSubstrate.js";
export * from "./credentialMaterializer.js";
export * from "./releaseFinalizer.js";
// The data-access layer seam (Track C): aggregates `engine/repositories/**` into
// a slottable `Repositories` contract with a pg-backed impl, mirroring the
// JobQueue/EventStore/SecretStore pattern. The conformance suite lives under
// tests/conformance/repositories.*.
export * from "./repositories.js";
export * from "./cas.js";
export * from "./behaviorRevision.js";
export * from "./gateProof.js";
export * from "./runtimeVerification.js";
export * from "./authoringKernel.js";
// in-2: typed integration lifecycle documents (requirement / effect / binding).
export * from "./integrationEffect.js";
export * from "./integrationBindingOutput.js";
export * from "./integrationRequirement.js";
export * from "./symptomContract.js";
