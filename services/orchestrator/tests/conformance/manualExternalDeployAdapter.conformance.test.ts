// ManualExternalDeployAdapter conformance: the operator-attestation flow. deploy RECORDS
// the operator's declared target (attestation); verify CONFIRMS the attested URL is
// reachable (failing LOUD when it never answers — an unconfirmed attestation is never
// accepted); demoSurface resolves a `web_url` or `download` surface from the attested
// kind; status reads the recorded attestation without confirming. Plus the loud-fail-on-
// missing-target behavior. Driven over the in-memory attestation store + a scripted probe.

import { describe, expect, it } from "vitest";
import type { OrgGrant, ProjectContext } from "../../src/engine/contracts/integrationProvisioner.js";
import type { DeployRef } from "../../src/engine/contracts/deployAdapter.js";
import {
  InMemoryManualAttestationStore,
  ManualExternalDeployAdapter,
  MANUAL_EXTERNAL_PROVIDER_KIND,
} from "../../src/engine/deploy/manualExternalDeployAdapter.js";
import { scriptedUrlProbe, instantVerifyPollPolicy } from "./fakes/scriptedUrlProbe.js";

const grant = (extra: Record<string, unknown> = {}): OrgGrant => ({
  providerKind: MANUAL_EXTERNAL_PROVIDER_KIND,
  credentialRef: "secret://none",
  metadata: { manualExternalUrl: "https://acme-web.example.com", ...extra },
});

const ctx = (id: string): ProjectContext => ({ projectId: id, orgId: "org_1" });

function adapter(urlStatus = 200, maxPolls = 10) {
  const probe = scriptedUrlProbe(urlStatus);
  const instance = new ManualExternalDeployAdapter({
    attestations: new InMemoryManualAttestationStore(),
    urlProbe: probe,
    poll: instantVerifyPollPolicy(maxPolls),
  });
  return { instance, probe };
}

describe("ManualExternalDeployAdapter — attestation lifecycle", () => {
  it("provisionOrBind records the operator's declared target + kind", async () => {
    const { instance } = adapter();
    const artifact = await instance.provisionOrBind(grant(), ctx("proj_1"), { mode: "provision" });
    expect(artifact.deployRef?.provider).toBe(MANUAL_EXTERNAL_PROVIDER_KIND);
    expect(artifact.projectConfig?.["manualExternalUrl"]).toBe("https://acme-web.example.com");
    expect(artifact.projectConfig?.["manualExternalKind"]).toBe("web_url");
  });

  it("deploy records an attestation bound to the merged ref", async () => {
    const { instance } = adapter();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const result = await instance.deploy(grant(), ref, { repo: "acme/acme-web", ref: "deadbeef" });
    expect(result.deploymentId).toBe("manual:proj_1@deadbeef");
    expect(result.url).toBe("https://acme-web.example.com");
    expect(result.state).toBe("attested");
  });

  it("status reads the recorded attestation but does NOT mark it ready (verify confirms)", async () => {
    const { instance, probe } = adapter();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const { deploymentId } = await instance.deploy(grant(), ref, { repo: "acme/acme-web", ref: "main" });
    const status = await instance.status(grant(), ref, deploymentId);
    expect(status.state).toBe("attested");
    expect(status.ready).toBe(false);
    expect(status.url).toBe("https://acme-web.example.com");
    // status does not probe — verify is the confirmation step.
    expect(probe.probed).toEqual([]);
  });
});

describe("ManualExternalDeployAdapter — verify (confirms the attestation)", () => {
  const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };

  it("confirms a reachable attested target", async () => {
    const { instance, probe } = adapter(200);
    const { deploymentId } = await instance.deploy(grant(), ref, { repo: "acme/acme-web", ref: "main" });
    const verification = await instance.verify(grant(), ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.state).toBe("confirmed");
    expect(verification.url).toBe("https://acme-web.example.com");
    expect(verification.smokeStatus).toBe(200);
    expect(probe.probed).toEqual(["https://acme-web.example.com"]);
  });

  it("treats a 401/403 attested target as reachable (a gated-but-live deploy)", async () => {
    const { instance } = adapter(403);
    const { deploymentId } = await instance.deploy(grant(), ref, { repo: "acme/acme-web", ref: "main" });
    const verification = await instance.verify(grant(), ref, deploymentId);
    expect(verification.ready).toBe(true);
    expect(verification.smokeStatus).toBe(403);
  });

  it("fails LOUD when the attested target never becomes reachable", async () => {
    const { instance } = adapter(503, 3);
    const { deploymentId } = await instance.deploy(grant(), ref, { repo: "acme/acme-web", ref: "main" });
    await expect(instance.verify(grant(), ref, deploymentId)).rejects.toThrow(/never became reachable after 3 polls/u);
  });

  it("fails LOUD when verify is called for an unrecorded deployment (deploy not run)", async () => {
    const { instance } = adapter();
    await expect(instance.verify(grant(), ref, "manual:proj_1@never")).rejects.toThrow(/no recorded attestation/u);
  });
});

describe("ManualExternalDeployAdapter — demo surface", () => {
  const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };

  it("resolves a web_url surface by default", async () => {
    const { instance } = adapter();
    const { deploymentId } = await instance.deploy(grant(), ref, { repo: "acme/acme-web", ref: "main" });
    const surface = await instance.demoSurface(grant(), ref, deploymentId);
    expect(surface).toEqual({ kind: "web_url", url: "https://acme-web.example.com" });
  });

  it("resolves a download surface when the operator declared kind 'download'", async () => {
    const { instance } = adapter();
    const g = grant({ manualExternalKind: "download", manualExternalUrl: "https://acme.example.com/app.zip" });
    const { deploymentId } = await instance.deploy(g, ref, { repo: "acme/acme-web", ref: "main" });
    const surface = await instance.demoSurface(g, ref, deploymentId);
    expect(surface).toEqual({ kind: "download", artifactUrl: "https://acme.example.com/app.zip" });
  });
});

describe("ManualExternalDeployAdapter — loud fail on missing config", () => {
  it("throws a typed config error when no target URL is declared", async () => {
    const { instance } = adapter();
    const noUrl: OrgGrant = {
      providerKind: MANUAL_EXTERNAL_PROVIDER_KIND,
      credentialRef: "secret://none",
      metadata: {},
    };
    await expect(instance.provisionOrBind(noUrl, ctx("proj_1"), { mode: "provision" })).rejects.toThrow(
      /required config 'manualExternalUrl' is not set/u,
    );
  });

  it("throws when the declared surface kind is invalid", async () => {
    const { instance } = adapter();
    const ref: DeployRef = { provider: MANUAL_EXTERNAL_PROVIDER_KIND, appId: "proj_1" };
    const bad = grant({ manualExternalKind: "ftp" });
    await expect(instance.deploy(bad, ref, { repo: "acme/acme-web", ref: "main" })).rejects.toThrow(
      /required config 'manualExternalKind'/u,
    );
  });
});
