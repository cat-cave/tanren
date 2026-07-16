import { testOrgGrant } from "../helpers/orgGrant.js";
// ManualExternalDeployAdapter conformance: the OPERATOR-CONFIRMATION lifecycle
// (Codex H3 Surface 7 #20 / #21). `deploy()` records a
// `pending_manual_confirmation` attestation in the DURABLE store + emits
// `deploy.pending_manual` (the operator-facing wake); an operator confirms via
// the store's `confirm()` API (which the confirmation route drives); `verify()`
// waits on the persisted confirmation state via `pollUntilTerminal` — a still-
// pending row escalates LOUD (never a silent verified), a confirmed row THEN
// smoke-probes the URL and returns `verified`. `status()` reads the persisted
// lifecycle; `demoSurface()` resolves the surface off the recorded target. Plus
// the loud-fail-on-missing-config behavior. Driven over the in-memory store +
// a scripted probe.

import { describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import type {
  IntegrationOperationTarget,
  IntegrationPrivilegedOperation,
} from "../../src/engine/contracts/integrationAuthority.js";
import type { DeployRef } from "../../src/engine/contracts/deployAdapter.js";
import type { AppendEventInput, EventStore } from "../../src/engine/eventStore.js";
import type { EventName } from "../../src/engine/events/index.js";
import {
  InMemoryManualAttestationStore,
  ManualExternalDeployAdapter,
  MANUAL_EXTERNAL_PROVIDER_KIND,
} from "../../src/engine/deploy/manualExternalDeployAdapter.js";
import { scriptedUrlProbe, sequencedUrlProbe, instantVerifyPollPolicy } from "./fakes/scriptedUrlProbe.js";

const OWNER_SCOPE = { orgId: "org_1", projectId: "proj_1" };
const SOURCE = { repo: "acme/acme-web", ref: "main" };
const DEFAULT_METADATA = { manualExternalUrl: "https://acme-web.example.com" };

const grant = (
  operation: IntegrationPrivilegedOperation,
  target: IntegrationOperationTarget,
  extra: Record<string, unknown> = {},
) =>
  testOrgGrant({
    orgId: OWNER_SCOPE.orgId,
    projectId: OWNER_SCOPE.projectId,
    providerKind: MANUAL_EXTERNAL_PROVIDER_KIND,
    credentialRef: "secret://none/g/1",
    metadata: { ...DEFAULT_METADATA, ...extra },
    capability: "deploy",
    operation,
    target,
  });

const deployGrant = (ref: DeployRef, source = SOURCE, extra: Record<string, unknown> = {}) =>
  grant("deploy", { resourceId: ref.appId, sourceRepo: source.repo, sourceRef: source.ref }, extra);

const deploymentGrant = (
  operation: "verify" | "resolve_demo_surface" | "resolve_artifact_identity",
  ref: DeployRef,
  deploymentId: string,
  extra: Record<string, unknown> = {},
) => grant(operation, { resourceId: ref.appId, deploymentId }, extra);

const ctx = (id: string): ProjectContext => ({ projectId: id, orgId: "org_1", orgSlug: "org-1" });

interface RecordingEvent {
  eventType: string;
  payload: unknown;
  orgId: string;
  projectId?: string;
}

class RecordingEventStore implements EventStore {
  readonly appended: RecordingEvent[] = [];
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appended.push({
      eventType: input.eventType,
      payload: input.payload,
      orgId: input.orgId,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    });
  }
}

function adapter(urlStatus = 200) {
  const probe = scriptedUrlProbe(urlStatus);
  const store = new InMemoryManualAttestationStore();
  const events = new RecordingEventStore();
  const instance = new ManualExternalDeployAdapter({
    attestations: store,
    urlProbe: probe,
    poll: instantVerifyPollPolicy(),
    ownerScope: OWNER_SCOPE,
    events,
  });
  return { instance, probe, store, events };
}

describe("ManualExternalDeployAdapter — attestation lifecycle", () => {
  it("provisionOrBind records the operator's declared target + kind", async () => {
    const { instance } = adapter();
    const artifact = await instance.provisionOrBind(
      await grant("provision", { projectName: "proj_1", orgSlug: "org-1" }),
      ctx("proj_1"),
      { mode: "provision" },
    );
    expect(artifact.deployRef?.provider).toBe(MANUAL_EXTERNAL_PROVIDER_KIND);
    expect(artifact.projectConfig?.["manualExternalUrl"]).toBe("https://acme-web.example.com");
    expect(artifact.projectConfig?.["manualExternalKind"]).toBe("web_url");
  });

  it("deploy records a PENDING-CONFIRMATION attestation (not a rubber-stamped `attested`, Codex H3 #21)", async () => {
    const { instance, store } = adapter();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const source = { ...SOURCE, ref: "deadbeef" };
    const result = await instance.deploy(await deployGrant(ref, source), ref, source);
    expect(result.deploymentId).toBe("manual:proj_1@deadbeef");
    expect(result.url).toBe("https://acme-web.example.com");
    expect(result.state).toBe("pending_manual_confirmation");
    // The DURABLE row landed with the pending lifecycle and no confirmation trail.
    const row = await store.read("manual:proj_1@deadbeef");
    expect(row?.state).toBe("pending_manual_confirmation");
    expect(row?.confirmedAt).toBeNull();
    expect(row?.confirmedBy).toBeNull();
    expect(row?.orgId).toBe(OWNER_SCOPE.orgId);
    expect(row?.projectId).toBe(OWNER_SCOPE.projectId);
  });

  it("deploy emits `deploy.pending_manual` with the confirmation-route link", async () => {
    const { instance, events } = adapter();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const source = { ...SOURCE, ref: "deadbeef" };
    await instance.deploy(await deployGrant(ref, source), ref, source);
    const pending = events.appended.find((e) => e.eventType === "deploy.pending_manual");
    expect(pending).toBeDefined();
    const payload = pending?.payload as Record<string, unknown>;
    expect(payload["provider"]).toBe(MANUAL_EXTERNAL_PROVIDER_KIND);
    expect(payload["deploymentId"]).toBe("manual:proj_1@deadbeef");
    expect(payload["url"]).toBe("https://acme-web.example.com");
    expect(payload["orgId"]).toBe(OWNER_SCOPE.orgId);
    expect(payload["projectId"]).toBe(OWNER_SCOPE.projectId);
    expect(payload["confirmationPath"]).toBe("/orgs/org_1/projects/proj_1/deploys/manual%3Aproj_1%40deadbeef/confirm");
  });

  it("status reads the persisted lifecycle (pending until an operator confirms)", async () => {
    const { instance, store, probe } = adapter();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const { deploymentId } = await instance.deploy(await deployGrant(ref), ref, SOURCE);
    const status = await instance.status(await deploymentGrant("verify", ref, deploymentId), ref, deploymentId);
    expect(status.state).toBe("pending_manual_confirmation");
    expect(status.ready).toBe(false);
    expect(status.url).toBe("https://acme-web.example.com");
    // status does not probe — verify is the confirmation-then-probe step.
    expect(probe.probed).toEqual([]);
    // After a confirm(), status reflects the confirmed lifecycle.
    await store.confirm({ deploymentId, orgId: OWNER_SCOPE.orgId, confirmedBy: "user_ops" });
    const confirmed = await instance.status(await deploymentGrant("verify", ref, deploymentId), ref, deploymentId);
    expect(confirmed.state).toBe("confirmed");
    expect(confirmed.ready).toBe(false);
  });
});

describe("ManualExternalDeployAdapter — verify (confirms operator + smoke-probes)", () => {
  const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };

  it("FAILS LOUD when the operator has NOT confirmed (never a silent verified — Codex H3 #21)", async () => {
    const { instance } = adapter();
    const { deploymentId } = await instance.deploy(await deployGrant(ref), ref, SOURCE);
    // No confirm() ⇒ verify's confirmation-phase poll finds the SAME
    // `pending_manual_confirmation` state repeating (a proven fixed point) →
    // escalates LOUD via pollUntilTerminal's stuck detection.
    await expect(
      instance.verify(() => deploymentGrant("verify", ref, deploymentId), ref, deploymentId),
    ).rejects.toThrow(/is STUCK 'pending_manual_confirmation' — no operator confirmation received/u);
  });

  it("confirms + smoke-probes once the operator confirms", async () => {
    const { instance, store, probe } = adapter(200);
    const { deploymentId } = await instance.deploy(await deployGrant(ref), ref, SOURCE);
    // The operator confirms out-of-band (the confirmation route drives this).
    const flip = await store.confirm({ deploymentId, orgId: OWNER_SCOPE.orgId, confirmedBy: "user_ops" });
    expect(flip?.freshlyConfirmed).toBe(true);
    expect(flip?.record.confirmedBy).toBe("user_ops");
    // verify NOW sees `confirmed` and smoke-probes the URL.
    const verification = await instance.verify(() => deploymentGrant("verify", ref, deploymentId), ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("verified");
    expect(verification.url).toBe("https://acme-web.example.com");
    expect(verification.smokeStatus).toBe(200);
    expect(probe.probed).toEqual(["https://acme-web.example.com"]);
  });

  it("treats a 401/403 attested target as reachable (a gated-but-live deploy)", async () => {
    const { instance, store } = adapter(403);
    const { deploymentId } = await instance.deploy(await deployGrant(ref), ref, SOURCE);
    await store.confirm({ deploymentId, orgId: OWNER_SCOPE.orgId, confirmedBy: "user_ops" });
    const verification = await instance.verify(() => deploymentGrant("verify", ref, deploymentId), ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.smokeStatus).toBe(403);
  });

  it("keeps probing UNBOUNDED past the old maxPolls cap once confirmed", async () => {
    // The attested target answers with DIFFERENT unreachable statuses (each poll a new state =
    // progress) for many polls past the old maxPolls=10 cap, then finally serves 200.
    const advancing = Array.from({ length: 15 }, (_v, i) => 500 + (i % 50));
    const probe = sequencedUrlProbe([...advancing.map((s, i) => s + i), 200]);
    const store = new InMemoryManualAttestationStore();
    const instance = new ManualExternalDeployAdapter({
      attestations: store,
      urlProbe: probe,
      poll: instantVerifyPollPolicy(),
      ownerScope: OWNER_SCOPE,
    });
    const { deploymentId } = await instance.deploy(await deployGrant(ref), ref, SOURCE);
    await store.confirm({ deploymentId, orgId: OWNER_SCOPE.orgId, confirmedBy: "user_ops" });
    const verification = await instance.verify(() => deploymentGrant("verify", ref, deploymentId), ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.smokeStatus).toBe(200);
    expect(verification.pollCount).toBe(16);
  });

  it("escalates LOUD as STUCK (not on a count) when the confirmed target stays unreachable", async () => {
    const { instance, store } = adapter(503);
    const { deploymentId } = await instance.deploy(await deployGrant(ref), ref, SOURCE);
    await store.confirm({ deploymentId, orgId: OWNER_SCOPE.orgId, confirmedBy: "user_ops" });
    await expect(
      instance.verify(() => deploymentGrant("verify", ref, deploymentId), ref, deploymentId),
    ).rejects.toThrow(/is STUCK unreachable \(HTTP 503\)/u);
  });

  it("fails LOUD when verify is called for an unrecorded deployment (deploy not run)", async () => {
    const { instance } = adapter();
    const deploymentId = "manual:proj_1@never";
    await expect(
      instance.verify(() => deploymentGrant("verify", ref, deploymentId), ref, deploymentId),
    ).rejects.toThrow(/no recorded attestation/u);
  });
});

describe("ManualExternalDeployAdapter — restart durability (Codex H3 #20)", () => {
  it("survives a restart: verify() on a fresh adapter sees the STILL-PENDING state from the store", async () => {
    const store = new InMemoryManualAttestationStore();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    // "Pre-restart process": adapter A runs deploy(), landing a pending row.
    const adapterA = new ManualExternalDeployAdapter({
      attestations: store,
      urlProbe: scriptedUrlProbe(200),
      poll: instantVerifyPollPolicy(),
      ownerScope: OWNER_SCOPE,
    });
    const { deploymentId } = await adapterA.deploy(await deployGrant(ref), ref, SOURCE);

    // "RESTART": a brand-new adapter B over the SAME store — the persisted row
    // must be re-readable and verify() must STILL treat it as pending (never a
    // silent verified after a restart). Pre-fix (H3 #20) the row lived in
    // adapter-local Map, so this test would find `no recorded attestation`.
    const adapterB = new ManualExternalDeployAdapter({
      attestations: store,
      urlProbe: scriptedUrlProbe(200),
      poll: instantVerifyPollPolicy(),
      ownerScope: OWNER_SCOPE,
    });
    const status = await adapterB.status(await deploymentGrant("verify", ref, deploymentId), ref, deploymentId);
    expect(status.state).toBe("pending_manual_confirmation");
    // verify still fails LOUD (no operator confirmation across the restart).
    await expect(
      adapterB.verify(() => deploymentGrant("verify", ref, deploymentId), ref, deploymentId),
    ).rejects.toThrow(/is STUCK 'pending_manual_confirmation'/u);
  });

  it("survives a restart: a persisted CONFIRMATION carries verify() → verified on a fresh adapter", async () => {
    const store = new InMemoryManualAttestationStore();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const adapterA = new ManualExternalDeployAdapter({
      attestations: store,
      urlProbe: scriptedUrlProbe(200),
      poll: instantVerifyPollPolicy(),
      ownerScope: OWNER_SCOPE,
    });
    const { deploymentId } = await adapterA.deploy(await deployGrant(ref), ref, SOURCE);
    // Operator confirms (via the route → the store's confirm()) before the restart.
    const first = await store.confirm({ deploymentId, orgId: OWNER_SCOPE.orgId, confirmedBy: "user_ops" });
    expect(first?.freshlyConfirmed).toBe(true);

    // "RESTART": adapter B over the same store — verify() picks up the confirmation
    // + probes the URL + returns `verified`. Persisted confirmation across restart.
    const adapterB = new ManualExternalDeployAdapter({
      attestations: store,
      urlProbe: scriptedUrlProbe(200),
      poll: instantVerifyPollPolicy(),
      ownerScope: OWNER_SCOPE,
    });
    const verification = await adapterB.verify(() => deploymentGrant("verify", ref, deploymentId), ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("verified");
    expect(verification.smokeStatus).toBe(200);
  });

  it("confirm() is IDEMPOTENT — a re-confirm never re-writes the audit trail", async () => {
    const store = new InMemoryManualAttestationStore();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const instance = new ManualExternalDeployAdapter({
      attestations: store,
      urlProbe: scriptedUrlProbe(200),
      poll: instantVerifyPollPolicy(),
      ownerScope: OWNER_SCOPE,
    });
    const { deploymentId } = await instance.deploy(await deployGrant(ref), ref, SOURCE);
    const first = await store.confirm({ deploymentId, orgId: OWNER_SCOPE.orgId, confirmedBy: "user_ops" });
    expect(first?.freshlyConfirmed).toBe(true);
    const initialConfirmedAt = first?.record.confirmedAt;
    const initialConfirmedBy = first?.record.confirmedBy;
    // A second confirm() with a DIFFERENT operator must NOT re-write the trail.
    const second = await store.confirm({ deploymentId, orgId: OWNER_SCOPE.orgId, confirmedBy: "user_lurker" });
    expect(second?.freshlyConfirmed).toBe(false);
    expect(second?.record.confirmedAt?.getTime()).toBe(initialConfirmedAt?.getTime());
    expect(second?.record.confirmedBy).toBe(initialConfirmedBy);
  });

  it("confirm() DENIES a cross-tenant flip (org isolation)", async () => {
    const store = new InMemoryManualAttestationStore();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const instance = new ManualExternalDeployAdapter({
      attestations: store,
      urlProbe: scriptedUrlProbe(200),
      poll: instantVerifyPollPolicy(),
      ownerScope: OWNER_SCOPE,
    });
    const { deploymentId } = await instance.deploy(await deployGrant(ref), ref, SOURCE);
    // A different org tries to confirm — the store denies (undefined).
    const cross = await store.confirm({ deploymentId, orgId: "org_evil", confirmedBy: "user_evil" });
    expect(cross).toBeUndefined();
    // The row is still pending.
    const row = await store.read(deploymentId);
    expect(row?.state).toBe("pending_manual_confirmation");
  });

  it("a lost `deploy.pending_manual` emit does NOT swallow the store write (row is durable)", async () => {
    // If the event emit fails after record() succeeds, the pending row must still
    // exist. record() runs BEFORE emit — a subsequent restart re-reads the row.
    const store = new InMemoryManualAttestationStore();
    const events: EventStore = {
      append: vi.fn<EventStore["append"]>().mockRejectedValue(new Error("events unavailable")),
    };
    const instance = new ManualExternalDeployAdapter({
      attestations: store,
      urlProbe: scriptedUrlProbe(200),
      poll: instantVerifyPollPolicy(),
      ownerScope: OWNER_SCOPE,
      events,
    });
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    await expect(instance.deploy(await deployGrant(ref), ref, SOURCE)).rejects.toThrow(/events unavailable/u);
    const row = await store.read("manual:proj_1@main");
    expect(row?.state).toBe("pending_manual_confirmation");
  });
});

describe("ManualExternalDeployAdapter — demo surface", () => {
  const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };

  it("resolves a web_url surface by default", async () => {
    const { instance } = adapter();
    const { deploymentId } = await instance.deploy(await deployGrant(ref), ref, SOURCE);
    const surface = await instance.demoSurface(
      await deploymentGrant("resolve_demo_surface", ref, deploymentId),
      ref,
      deploymentId,
    );
    expect(surface).toEqual({ kind: "web_url", url: "https://acme-web.example.com" });
  });

  it("resolves a download surface when the operator declared kind 'download'", async () => {
    const { instance } = adapter();
    const metadata = { manualExternalKind: "download", manualExternalUrl: "https://acme.example.com/app.zip" };
    const { deploymentId } = await instance.deploy(await deployGrant(ref, SOURCE, metadata), ref, SOURCE);
    const surface = await instance.demoSurface(
      await deploymentGrant("resolve_demo_surface", ref, deploymentId, metadata),
      ref,
      deploymentId,
    );
    expect(surface).toEqual({ kind: "download", artifactUrl: "https://acme.example.com/app.zip" });
  });
});

describe("ManualExternalDeployAdapter — loud fail on missing config", () => {
  it("throws a typed config error when no target URL is declared", async () => {
    const { instance } = adapter();
    const noUrl = await testOrgGrant({
      orgId: OWNER_SCOPE.orgId,
      projectId: OWNER_SCOPE.projectId,
      providerKind: MANUAL_EXTERNAL_PROVIDER_KIND,
      credentialRef: "secret://none/g/1",
      metadata: {},
      capability: "deploy",
      operation: "provision",
      target: { projectName: "proj_1", orgSlug: "org-1" },
    });
    await expect(instance.provisionOrBind(noUrl, ctx("proj_1"), { mode: "provision" })).rejects.toThrow(
      /required config 'manualExternalUrl' is not set/u,
    );
  });

  it("throws when the declared surface kind is invalid", async () => {
    const { instance } = adapter();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const bad = await deployGrant(ref, SOURCE, { manualExternalKind: "ftp" });
    await expect(instance.deploy(bad, ref, SOURCE)).rejects.toThrow(/required config 'manualExternalKind'/u);
  });
});
