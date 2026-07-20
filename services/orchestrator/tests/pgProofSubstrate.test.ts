// SP-3 — DB-free behavioral coverage for PgProofSubstrate: the full
// construct→seal→verify chain and every FAIL-CLOSED arm (tampered member,
// reordered set, wrong root, bad signature, unknown key, missing key), plus
// ingest/persist driven against an in-memory CAS + a recording pool so the SQL
// paths are exercised without a live Postgres.
import { generateKeyPairSync } from "node:crypto";
import type pg from "pg";
import { describe, expect, it } from "vitest";
import type {
  BundleBindings,
  CasArtifactBytes,
  CasArtifactRef,
  CasByteStore,
  Digest,
  ProofBundleSealed,
  ProofUnitDraft,
} from "../src/engine/contracts/cas.js";
import { CasArtifactNotFoundError, contentDigestOf } from "../src/engine/contracts/cas.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import { PgProofSubstrate } from "../src/engine/cas/pgProofSubstrate.js";
import { serializeBundleBytes } from "../src/engine/cas/proofSubstrateCodec.js";

const TEST_REF = "credential/proof-substrate/platform/test-ed25519";
const ORG = "org_sp3";
const PROJECT = "project_sp3";

function testKeyPem(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  return privateKey.export({ type: "pkcs8", format: "pem" }) as string;
}

function secretsWithKey(pem: string): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TEST_REF, value: pem });
  return store;
}

class MemoryCasByteStore implements CasByteStore {
  private readonly store = new Map<string, { bytes: Uint8Array; mediaType: string }>();
  public async put(input: { orgId: string; bytes: Uint8Array; mediaType: string }): Promise<CasArtifactRef> {
    const digest = contentDigestOf(input.bytes);
    const key = `${input.orgId}:${digest}`;
    const existing = this.store.get(key);
    if (existing === undefined) {
      this.store.set(key, { bytes: input.bytes, mediaType: input.mediaType });
      return { digest, byteSize: input.bytes.byteLength, mediaType: input.mediaType };
    }
    return { digest, byteSize: existing.bytes.byteLength, mediaType: existing.mediaType };
  }
  public async get(orgId: string, digest: Digest): Promise<CasArtifactBytes> {
    const found = this.store.get(`${orgId}:${digest}`);
    if (found === undefined) {
      throw new CasArtifactNotFoundError(orgId, digest);
    }
    return { digest, bytes: found.bytes, mediaType: found.mediaType };
  }
  public async has(orgId: string, digest: Digest): Promise<boolean> {
    return this.store.has(`${orgId}:${digest}`);
  }
}

class RecordingClient {
  public readonly queries: { sql: string; params: readonly unknown[] }[] = [];
  public async query(sql: string, params: readonly unknown[] = []): Promise<{ rows: never[]; rowCount: number }> {
    this.queries.push({ sql, params });
    return { rows: [], rowCount: 0 };
  }
  public release(): void {}
}

class RecordingPool {
  public readonly client = new RecordingClient();
  public async connect(): Promise<RecordingClient> {
    return this.client;
  }
}

function bindings(): BundleBindings {
  return {
    integrationNodeId: "inode_1",
    memberSetHash: `sha256:${"a".repeat(64)}`,
    preparedHeadSha: "head-sha",
    jjTreeId: `sha256:${"b".repeat(64)}`,
    artifactDigest: `sha256:${"c".repeat(64)}` as Digest,
    expectedMainSha: "main-sha",
    issuedAt: "2026-07-20T00:00:00.000Z",
    expiresAt: "2026-07-20T01:00:00.000Z",
    nonce: "nonce-1",
  };
}

function draft(subjectId: string, verdict: ProofUnitDraft["verdict"] = "passed"): ProofUnitDraft {
  return { kind: "test", verdict, subjectId, body: { subjectId, verdict } };
}

function build(secrets: InMemorySecretStore): {
  substrate: PgProofSubstrate;
  pool: RecordingPool;
  cas: MemoryCasByteStore;
} {
  const pool = new RecordingPool();
  const cas = new MemoryCasByteStore();
  const substrate = new PgProofSubstrate(pool as unknown as pg.Pool, secrets, {
    casByteStore: cas,
    signingKeyRef: TEST_REF,
  });
  return { substrate, pool, cas };
}

async function constructSealed(
  secrets: InMemorySecretStore,
): Promise<{ substrate: PgProofSubstrate; bundle: ProofBundleSealed; pool: RecordingPool; cas: MemoryCasByteStore }> {
  const { substrate, pool, cas } = build(secrets);
  const members = await substrate.ingestUnits({
    orgId: ORG,
    projectId: PROJECT,
    drafts: [draft("s1"), draft("s2"), draft("s3")],
  });
  const bundle = await substrate.constructBundle({ orgId: ORG, projectId: PROJECT, members, bindings: bindings() });
  return { substrate, bundle, pool, cas };
}

describe("PgProofSubstrate — construct + seal + verify happy path", () => {
  it("ingests, constructs a sealed bundle, and verifies it valid", async () => {
    const { substrate, bundle } = await constructSealed(secretsWithKey(testKeyPem()));
    expect(bundle.bundleId.startsWith("pb1_")).toBe(true);
    expect(bundle.proofRoot).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(bundle.bundleDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(bundle.bytesDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(bundle.signingKeyId).toMatch(/^ed25519:[0-9a-f]{64}$/u);
    expect(bundle.rootSignature.byteLength).toBe(64);
    expect(bundle.members).toHaveLength(3);
    expect(bundle.members.map((m) => m.ordinal)).toEqual([0, 1, 2]);
    const verification = await substrate.verify(bundle);
    expect(verification.valid).toBe(true);
    expect(verification.reason).toBeUndefined();
  });

  it("ingestUnits invokes validateSectionBody BEFORE addressing and a failing draft throws (never ingested)", async () => {
    const { substrate } = build(secretsWithKey(testKeyPem()));
    await expect(
      substrate.ingestUnits({
        orgId: ORG,
        projectId: PROJECT,
        drafts: [draft("ok"), draft("bad")],
        validateSectionBody: (_kind, body) => {
          if ((body as { subjectId: string }).subjectId === "bad") {
            throw new Error("section body rejected");
          }
        },
      }),
    ).rejects.toThrow("section body rejected");
  });
});

describe("PgProofSubstrate — FAIL-CLOSED verify arms", () => {
  it("a TAMPERED member verdict makes verify INVALID (root mismatch)", async () => {
    const { substrate, bundle } = await constructSealed(secretsWithKey(testKeyPem()));
    const tampered: ProofBundleSealed = {
      ...bundle,
      members: bundle.members.map((m, i) => (i === 0 ? { ...m, verdict: "failed" } : m)),
    };
    const result = await substrate.verify(tampered);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/proof root/u);
  });

  it("a REORDERED member set (digests swapped across ordinals) is INVALID", async () => {
    const { substrate, bundle } = await constructSealed(secretsWithKey(testKeyPem()));
    const m0 = bundle.members[0]!;
    const m1 = bundle.members[1]!;
    const swapped = [...bundle.members];
    swapped[0] = { ...m0, unitDigest: m1.unitDigest };
    swapped[1] = { ...m1, unitDigest: m0.unitDigest };
    const result = await substrate.verify({ ...bundle, members: swapped });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/proof root/u);
  });

  it("non-contiguous ordinals are INVALID", async () => {
    const { substrate, bundle } = await constructSealed(secretsWithKey(testKeyPem()));
    const bad = bundle.members.map((m, i) => (i === 2 ? { ...m, ordinal: 5 } : m));
    const result = await substrate.verify({ ...bundle, members: bad });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/ordinal|bundle unit id/u);
  });

  it("a WRONG proof root is INVALID", async () => {
    const { substrate, bundle } = await constructSealed(secretsWithKey(testKeyPem()));
    const result = await substrate.verify({ ...bundle, proofRoot: `sha256:${"f".repeat(64)}` as Digest });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/proof root/u);
  });

  it("a BAD signature (bytes re-derived consistent) fails at the ed25519 check", async () => {
    const { substrate, bundle } = await constructSealed(secretsWithKey(testKeyPem()));
    const forgedSig = new Uint8Array(64).fill(7);
    const reDerived: ProofBundleSealed = { ...bundle, rootSignature: forgedSig };
    const withBytes: ProofBundleSealed = {
      ...reDerived,
      bytesDigest: contentDigestOf(serializeBundleBytes(reDerived)),
    };
    const result = await substrate.verify(withBytes);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signature verification failed/u);
  });

  it("an inconsistent bytesDigest (signature swapped, bytes NOT re-derived) is INVALID at the bytes check", async () => {
    const { substrate, bundle } = await constructSealed(secretsWithKey(testKeyPem()));
    const result = await substrate.verify({ ...bundle, rootSignature: new Uint8Array(64).fill(3) });
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/bytes digest/u);
  });

  it("an UNKNOWN/mismatched signingKeyId (verified under a different platform key) is INVALID", async () => {
    const { bundle } = await constructSealed(secretsWithKey(testKeyPem()));
    // A second substrate configured with a DIFFERENT platform key.
    const other = build(secretsWithKey(testKeyPem()));
    const result = await other.substrate.verify(bundle);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signingKeyId/u);
  });

  it("a MISSING signing key makes verify INVALID (fail-closed, never a false success)", async () => {
    const { bundle } = await constructSealed(secretsWithKey(testKeyPem()));
    const keyless = build(new InMemorySecretStore());
    const result = await keyless.substrate.verify(bundle);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/signing key unavailable/u);
  });
});

describe("PgProofSubstrate — seal/construct guards", () => {
  it("seal THROWS when the signing key is absent (never signs with nothing)", async () => {
    const { substrate } = build(new InMemorySecretStore());
    await expect(
      substrate.seal({ proofRoot: `sha256:${"a".repeat(64)}` as Digest, bindings: bindings() }),
    ).rejects.toMatchObject({ name: "ProofSigningKeyUnavailableError" });
  });

  it("seal THROWS on non-ed25519 key material", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const store = new InMemorySecretStore();
    await store.put({ ref: TEST_REF, value: privateKey.export({ type: "pkcs8", format: "pem" }) as string });
    const { substrate } = build(store);
    await expect(
      substrate.seal({ proofRoot: `sha256:${"a".repeat(64)}` as Digest, bindings: bindings() }),
    ).rejects.toMatchObject({ name: "ProofSigningKeyMalformedError" });
  });

  it("constructBundle rejects an empty member set", async () => {
    const { substrate } = build(secretsWithKey(testKeyPem()));
    await expect(
      substrate.constructBundle({ orgId: ORG, projectId: PROJECT, members: [], bindings: bindings() }),
    ).rejects.toMatchObject({ name: "EmptyProofBundleError" });
  });

  it("constructBundle rejects duplicate member digests", async () => {
    const { substrate } = build(secretsWithKey(testKeyPem()));
    const dup = {
      digest: contentDigestOf(new TextEncoder().encode("dup")) as Digest,
      kind: "test" as const,
      verdict: "passed" as const,
    };
    await expect(
      substrate.constructBundle({ orgId: ORG, projectId: PROJECT, members: [dup, dup], bindings: bindings() }),
    ).rejects.toMatchObject({ name: "DuplicateProofMemberError" });
  });
});

describe("PgProofSubstrate — persist (recording pool)", () => {
  it("persists a verified bundle, writing proof_bundles + proof_bundle_units rows org-scoped", async () => {
    const secrets = secretsWithKey(testKeyPem());
    const { substrate, bundle, pool } = await constructSealed(secrets);
    const ref = await substrate.persistBundle(bundle);
    expect(ref.bundleId).toBe(bundle.bundleId);
    expect(ref.bundleDigest).toBe(bundle.bundleDigest);
    const statements = pool.client.queries.map((q) => q.sql);
    expect(statements.some((s) => s.includes("SET LOCAL app.current_org_id"))).toBe(true);
    expect(statements.some((s) => s.includes("INSERT INTO proof_bundles"))).toBe(true);
    expect(statements.filter((s) => s.includes("INSERT INTO proof_bundle_units"))).toHaveLength(3);
    // The org GUC set matches the org embedded in the bundle id.
    const setLocal = pool.client.queries.find((q) => q.sql.includes("SET LOCAL"));
    expect(setLocal?.sql).toContain(ORG);
  });

  it("REFUSES to persist an unverifiable (tampered) bundle", async () => {
    const secrets = secretsWithKey(testKeyPem());
    const { substrate, bundle } = await constructSealed(secrets);
    const tampered: ProofBundleSealed = { ...bundle, proofRoot: `sha256:${"e".repeat(64)}` as Digest };
    await expect(substrate.persistBundle(tampered)).rejects.toMatchObject({ name: "ProofBundleNotVerifiedError" });
  });
});
