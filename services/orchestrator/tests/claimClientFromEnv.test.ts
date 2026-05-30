// Plane-split P2: behavior tests for the worker's job-CLAIM client resolution
// from the environment (`buildClaimClientFromEnv` / `dataPlaneMtlsCertPathsFromEnv`).
//
// The resolver decides HOW the worker claims: the direct DB-CAS (default) or the
// mTLS control-plane endpoint. The observable behavior asserted here is the
// returned client's IDENTITY (an HttpJobClaimClient that POSTs to the configured
// endpoint over the mTLS channel) and the loud failure on a partial config
// (endpoint set, certs missing) — never a silent unauthenticated claim.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpJobClaimClient } from "../src/engine/contracts/jobClaim.js";
import { buildClaimClientFromEnv, dataPlaneMtlsCertPathsFromEnv } from "../src/engine/worker/claimClientFromEnv.js";

const ENV_KEYS = [
  "TANREN_CLAIM_ENDPOINT_URL",
  "TANREN_DATA_PLANE_TLS_CERT",
  "TANREN_DATA_PLANE_TLS_KEY",
  "TANREN_DATA_PLANE_TLS_CA",
];

describe("buildClaimClientFromEnv (plane-split P2 claim seam)", () => {
  const saved: Record<string, string | undefined> = {};
  let certDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // Real PEM-ish files on disk so buildNodeMtlsFetch's readFileSync succeeds.
    certDir = mkdtempSync(join(tmpdir(), "tanren-claim-certs-"));
    for (const name of ["cert.pem", "key.pem", "ca.pem"]) {
      writeFileSync(join(certDir, name), `--- ${name} ---`);
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
    rmSync(certDir, { recursive: true, force: true });
  });

  function setCertEnv(): void {
    process.env["TANREN_DATA_PLANE_TLS_CERT"] = join(certDir, "cert.pem");
    process.env["TANREN_DATA_PLANE_TLS_KEY"] = join(certDir, "key.pem");
    process.env["TANREN_DATA_PLANE_TLS_CA"] = join(certDir, "ca.pem");
  }

  it("returns undefined (direct DB-CAS) when no endpoint is configured", () => {
    // The single-process dev path: no endpoint → fall back to the in-process
    // DirectJobClaimClient (undefined signals that to the caller).
    setCertEnv(); // even with certs, no endpoint stays on the direct path
    expect(buildClaimClientFromEnv()).toBeUndefined();
  });

  it("returns undefined when the endpoint URL is set but empty", () => {
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "";
    setCertEnv();
    expect(buildClaimClientFromEnv()).toBeUndefined();
  });

  it("builds an HttpJobClaimClient over the mTLS channel when endpoint + certs are configured", () => {
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:8443";
    setCertEnv();
    const client = buildClaimClientFromEnv();
    expect(client).toBeInstanceOf(HttpJobClaimClient);
  });

  it("throws (never silently claims unauthenticated) when the endpoint is set but cert env is incomplete", () => {
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:8443";
    // Only cert + key, no CA → partial config must fail loudly.
    process.env["TANREN_DATA_PLANE_TLS_CERT"] = join(certDir, "cert.pem");
    process.env["TANREN_DATA_PLANE_TLS_KEY"] = join(certDir, "key.pem");
    expect(() => buildClaimClientFromEnv()).toThrow(/mTLS cert env/u);
  });
});

describe("dataPlaneMtlsCertPathsFromEnv", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  it("returns the three cert paths verbatim when all are set", () => {
    process.env["TANREN_DATA_PLANE_TLS_CERT"] = "/c/cert.pem";
    process.env["TANREN_DATA_PLANE_TLS_KEY"] = "/c/key.pem";
    process.env["TANREN_DATA_PLANE_TLS_CA"] = "/c/ca.pem";
    expect(dataPlaneMtlsCertPathsFromEnv()).toEqual({
      certPath: "/c/cert.pem",
      keyPath: "/c/key.pem",
      caPath: "/c/ca.pem",
    });
  });

  it("returns undefined when ANY one of the three is missing", () => {
    process.env["TANREN_DATA_PLANE_TLS_CERT"] = "/c/cert.pem";
    process.env["TANREN_DATA_PLANE_TLS_KEY"] = "/c/key.pem";
    // CA missing → the whole set is undefined (each path is individually required).
    expect(dataPlaneMtlsCertPathsFromEnv()).toBeUndefined();
    process.env["TANREN_DATA_PLANE_TLS_CA"] = "/c/ca.pem";
    delete process.env["TANREN_DATA_PLANE_TLS_KEY"];
    expect(dataPlaneMtlsCertPathsFromEnv()).toBeUndefined();
    process.env["TANREN_DATA_PLANE_TLS_KEY"] = "/c/key.pem";
    delete process.env["TANREN_DATA_PLANE_TLS_CERT"];
    expect(dataPlaneMtlsCertPathsFromEnv()).toBeUndefined();
  });
});
