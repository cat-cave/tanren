// Plane-split: behavior tests for the worker's run-state WRITER resolution
// from the environment (`buildRunStateWriterFromEnv` / `remoteWritesEnabled`).
//
// AUDIT FINDING D3/H3 SWEEP: the resolver ALWAYS returns a writer now (the
// pre-sweep "return undefined → silent split-write fallback in the workflow"
// path is the surface the audit findings named — gone). Off-flag returns the
// in-process `DirectRunStateWriter` over the supplied pool (byte-identical to
// the prior direct path); on-flag + endpoint + certs returns an
// `HttpRunStateWriter`. A partial on-flag config still fails LOUDLY (never an
// unauthenticated channel, never a silent revert).

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type pg from "pg";
import { DirectRunStateWriter } from "../src/engine/worker/directRunStateWriter.js";
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

// A stand-in pool — the resolver doesn't read it, it just hands it to the
// `DirectRunStateWriter` constructor on the off-flag path. The HTTP path
// ignores it entirely.
const stubPool = {} as unknown as pg.Pool;

describe("buildRunStateWriterFromEnv (plane-split P3 write seam, audit D3/H3 sweep)", () => {
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

  it("returns a DirectRunStateWriter (in-process DB writes) when the flag is off — REVERSIBLE default", () => {
    // Even with endpoint + certs present, no flag → the in-process path.
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:3110";
    setCertEnv();
    expect(remoteWritesEnabled()).toBe(false);
    expect(buildRunStateWriterFromEnv(stubPool)).toBeInstanceOf(DirectRunStateWriter);
  });

  it("builds an HttpRunStateWriter when the flag + endpoint + certs are all set", () => {
    process.env["TANREN_DATA_PLANE_REMOTE_WRITES"] = "1";
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:3110";
    setCertEnv();
    expect(remoteWritesEnabled()).toBe(true);
    expect(buildRunStateWriterFromEnv(stubPool)).toBeInstanceOf(HttpRunStateWriter);
  });

  it("prefers TANREN_WRITE_ENDPOINT_URL over the claim endpoint for a split topology", () => {
    process.env["TANREN_DATA_PLANE_REMOTE_WRITES"] = "1";
    process.env["TANREN_WRITE_ENDPOINT_URL"] = "https://writes.internal:3120";
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:3110";
    setCertEnv();
    expect(buildRunStateWriterFromEnv(stubPool)).toBeInstanceOf(HttpRunStateWriter);
  });

  it("throws (never silently writes direct) when the flag is on but no endpoint is configured", () => {
    process.env["TANREN_DATA_PLANE_REMOTE_WRITES"] = "1";
    setCertEnv();
    expect(() => buildRunStateWriterFromEnv(stubPool)).toThrow(/write endpoint/u);
  });

  it("throws when the flag is on but the cert env is incomplete", () => {
    process.env["TANREN_DATA_PLANE_REMOTE_WRITES"] = "1";
    process.env["TANREN_CLAIM_ENDPOINT_URL"] = "https://control-plane:3110";
    process.env["TANREN_DATA_PLANE_TLS_CERT"] = join(certDir, "cert.pem");
    process.env["TANREN_DATA_PLANE_TLS_KEY"] = join(certDir, "key.pem");
    // CA missing → loud failure, not an unauthenticated channel.
    expect(() => buildRunStateWriterFromEnv(stubPool)).toThrow(/mTLS cert env/u);
  });
});
