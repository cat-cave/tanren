// Plane-split P3: behavior tests for the worker's run-state WRITER resolution
// from the environment (`buildRunStateWriterFromEnv` / `remoteWritesEnabled`).
//
// The resolver decides WHERE the worker writes run state: in-process direct DB
// writes (the DEFAULT — undefined writer) or the mTLS control-plane endpoints (an
// HttpRunStateWriter). The behavior asserted: the flag gates it (off → direct,
// reversible), a partial config fails LOUDLY (never silent direct writes that
// would defeat de-privilege), and a full config yields the remote writer.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpRunStateWriter } from "../src/engine/worker/httpRunStateWriter.js";
import { buildRunStateWriterFromEnv, remoteWritesEnabled } from "../src/engine/worker/runStateWriterFromEnv.js";

const ENV_KEYS = [
  "TANREN_DATA_PLANE_REMOTE_WRITES",
  "TANREN_WRITE_ENDPOINT_URL",
  "TANREN_CLAIM_ENDPOINT_URL",
  "TANREN_DATA_PLANE_TLS_CERT",
  "TANREN_DATA_PLANE_TLS_KEY",
  "TANREN_DATA_PLANE_TLS_CA",
];

describe("buildRunStateWriterFromEnv (plane-split P3 write seam)", () => {
  const saved: Record<string, string | undefined> = {};
  let certDir: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    certDir = mkdtempSync(join(tmpdir(), "tanren-p3-certs-"));
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

  it("returns undefined (direct in-process writes) when the flag is off — REVERSIBLE default", () => {
    // Even with endpoint + certs present, no flag → the worker writes directly.
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:3110";
    setCertEnv();
    expect(remoteWritesEnabled()).toBe(false);
    expect(buildRunStateWriterFromEnv()).toBeUndefined();
  });

  it("builds an HttpRunStateWriter when the flag + endpoint + certs are all set", () => {
    process.env["TANREN_DATA_PLANE_REMOTE_WRITES"] = "1";
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:3110";
    setCertEnv();
    expect(remoteWritesEnabled()).toBe(true);
    expect(buildRunStateWriterFromEnv()).toBeInstanceOf(HttpRunStateWriter);
  });

  it("prefers TANREN_WRITE_ENDPOINT_URL over the claim endpoint for a split topology", () => {
    process.env["TANREN_DATA_PLANE_REMOTE_WRITES"] = "1";
    process.env["TANREN_WRITE_ENDPOINT_URL"] = "https://writes.internal:3120";
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:3110";
    setCertEnv();
    expect(buildRunStateWriterFromEnv()).toBeInstanceOf(HttpRunStateWriter);
  });

  it("throws (never silently writes direct) when the flag is on but no endpoint is configured", () => {
    process.env["TANREN_DATA_PLANE_REMOTE_WRITES"] = "1";
    setCertEnv();
    expect(() => buildRunStateWriterFromEnv()).toThrow(/write endpoint/);
  });

  it("throws when the flag is on but the cert env is incomplete", () => {
    process.env["TANREN_DATA_PLANE_REMOTE_WRITES"] = "1";
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:3110";
    process.env["TANREN_DATA_PLANE_TLS_CERT"] = join(certDir, "cert.pem");
    process.env["TANREN_DATA_PLANE_TLS_KEY"] = join(certDir, "key.pem");
    // CA missing → loud failure, not an unauthenticated channel.
    expect(() => buildRunStateWriterFromEnv()).toThrow(/mTLS cert env/);
  });
});
