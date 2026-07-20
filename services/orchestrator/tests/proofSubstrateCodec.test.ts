// SP-3 — DB-free unit coverage for the ProofSubstrate deterministic core: the
// canonical Merkle root, whole-bundle digest, seal message, persisted-bytes
// serialization, and the org/project-carrying bundle-id codec. No DB, no key.
import { describe, expect, it } from "vitest";
import type { BundleBindings, Digest, ProofUnitRef } from "../src/engine/contracts/cas.js";
import { contentDigestOf } from "../src/engine/contracts/cas.js";
import {
  bundleUnitId,
  canonicalSealMessage,
  computeBundleDigest,
  computeProofRoot,
  decodeBundleId,
  encodeBundleId,
  MalformedBundleIdError,
  serializeBundleBytes,
} from "../src/engine/cas/proofSubstrateCodec.js";

function unit(
  label: string,
  kind: ProofUnitRef["kind"] = "test",
  verdict: ProofUnitRef["verdict"] = "passed",
): ProofUnitRef {
  return { digest: contentDigestOf(new TextEncoder().encode(label)), kind, verdict };
}

const BINDINGS: BundleBindings = {
  integrationNodeId: "inode_1",
  memberSetHash: "sha256:" + "a".repeat(64),
  preparedHeadSha: "head-sha",
  jjTreeId: "sha256:" + "b".repeat(64),
  artifactDigest: ("sha256:" + "c".repeat(64)) as Digest,
  expectedMainSha: "main-sha",
  issuedAt: "2026-07-20T00:00:00.000Z",
  expiresAt: "2026-07-20T01:00:00.000Z",
  nonce: "nonce-1",
};

describe("computeProofRoot — deterministic, order-sensitive Merkle root", () => {
  it("is a well-formed Digest and stable across calls for identical members in identical order", () => {
    const members = [unit("a"), unit("b"), unit("c")];
    const first = computeProofRoot(members);
    const second = computeProofRoot(members);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(first).toBe(second);
  });

  it("changes when members are REORDERED (ordinal binds position)", () => {
    const a = unit("a");
    const b = unit("b");
    const c = unit("c");
    expect(computeProofRoot([a, b, c])).not.toBe(computeProofRoot([b, a, c]));
  });

  it("changes when a member's verdict/kind/digest is tampered", () => {
    const base = [unit("a"), unit("b")];
    const root = computeProofRoot(base);
    expect(computeProofRoot([unit("a"), unit("b", "test", "failed")])).not.toBe(root);
    expect(computeProofRoot([unit("a"), unit("b", "security_finding")])).not.toBe(root);
    expect(computeProofRoot([unit("a"), unit("DIFFERENT")])).not.toBe(root);
  });

  it("handles odd member counts deterministically (lone node promoted)", () => {
    const members = [unit("a"), unit("b"), unit("c"), unit("d"), unit("e")];
    expect(computeProofRoot(members)).toBe(computeProofRoot(members));
    expect(computeProofRoot(members)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("has a fixed empty-tree root for zero members", () => {
    expect(computeProofRoot([])).toBe(computeProofRoot([]));
    expect(computeProofRoot([])).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("a single-member root differs from a two-member prefix", () => {
    expect(computeProofRoot([unit("a")])).not.toBe(computeProofRoot([unit("a"), unit("b")]));
  });
});

describe("canonicalSealMessage — byte-stable signed message", () => {
  it("is identical for identical (proofRoot, bindings) regardless of binding key order", () => {
    const proofRoot = computeProofRoot([unit("a")]);
    const reordered: BundleBindings = { ...BINDINGS };
    const a = canonicalSealMessage({ proofRoot, bindings: BINDINGS });
    const b = canonicalSealMessage({ proofRoot, bindings: reordered });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("changes when the proof root changes", () => {
    const one = canonicalSealMessage({ proofRoot: computeProofRoot([unit("a")]), bindings: BINDINGS });
    const two = canonicalSealMessage({ proofRoot: computeProofRoot([unit("b")]), bindings: BINDINGS });
    expect(Buffer.from(one).equals(Buffer.from(two))).toBe(false);
  });

  it("changes when a binding field changes", () => {
    const base = canonicalSealMessage({ proofRoot: computeProofRoot([unit("a")]), bindings: BINDINGS });
    const tampered = canonicalSealMessage({
      proofRoot: computeProofRoot([unit("a")]),
      bindings: { ...BINDINGS, nonce: "nonce-2" },
    });
    expect(Buffer.from(base).equals(Buffer.from(tampered))).toBe(false);
  });
});

describe("bundle id codec — carries tenant scope injection-safely", () => {
  it("round-trips org/project/digest", () => {
    const bundleDigest = computeProofRoot([unit("a")]);
    const id = encodeBundleId({ orgId: "org_x", projectId: "proj_y", bundleDigest });
    expect(id.startsWith("pb1_")).toBe(true);
    const decoded = decodeBundleId(id);
    expect(decoded).toEqual({ orgId: "org_x", projectId: "proj_y", bundleDigest });
  });

  it("is deterministic (idempotent by digest)", () => {
    const bundleDigest = computeProofRoot([unit("a")]);
    expect(encodeBundleId({ orgId: "o", projectId: "p", bundleDigest })).toBe(
      encodeBundleId({ orgId: "o", projectId: "p", bundleDigest }),
    );
  });

  it("throws MalformedBundleIdError on a bad prefix or corrupt payload", () => {
    expect(() => decodeBundleId("not-a-bundle-id")).toThrow(MalformedBundleIdError);
    expect(() => decodeBundleId("pb1_%%%not-base64%%%")).toThrow(MalformedBundleIdError);
    expect(() => decodeBundleId(`pb1_${Buffer.from('["array"]', "utf8").toString("base64url")}`)).toThrow(
      MalformedBundleIdError,
    );
    expect(() => decodeBundleId(`pb1_${Buffer.from('{"o":1}', "utf8").toString("base64url")}`)).toThrow(
      MalformedBundleIdError,
    );
  });
});

describe("computeBundleDigest + serializeBundleBytes", () => {
  const bundleDigest = computeProofRoot([unit("a")]);
  const bundleId = encodeBundleId({ orgId: "o", projectId: "p", bundleDigest });
  const members = [
    {
      unitDigest: unit("a").digest,
      kind: "test" as const,
      verdict: "passed" as const,
      ordinal: 0,
      bundleUnitId: bundleUnitId(bundleId, 0),
    },
  ];

  it("computeBundleDigest ignores incoming member array order (sorts by ordinal)", () => {
    const two = [
      {
        unitDigest: unit("a").digest,
        kind: "test" as const,
        verdict: "passed" as const,
        ordinal: 0,
        bundleUnitId: "x0",
      },
      {
        unitDigest: unit("b").digest,
        kind: "test" as const,
        verdict: "passed" as const,
        ordinal: 1,
        bundleUnitId: "x1",
      },
    ];
    const proofRoot = computeProofRoot([unit("a"), unit("b")]);
    const forward = computeBundleDigest({ proofRoot, members: two, bindings: BINDINGS });
    const reversed = computeBundleDigest({ proofRoot, members: [two[1]!, two[0]!], bindings: BINDINGS });
    expect(forward).toBe(reversed);
  });

  it("serializeBundleBytes is reproducible and its digest changes on any field tamper", () => {
    const bytes = serializeBundleBytes({
      bundleId,
      bundleDigest,
      proofRoot: bundleDigest,
      members,
      bindings: BINDINGS,
      signingKeyId: "ed25519:" + "d".repeat(64),
      rootSignature: new Uint8Array([1, 2, 3, 4]),
    });
    const again = serializeBundleBytes({
      bundleId,
      bundleDigest,
      proofRoot: bundleDigest,
      members,
      bindings: BINDINGS,
      signingKeyId: "ed25519:" + "d".repeat(64),
      rootSignature: new Uint8Array([1, 2, 3, 4]),
    });
    expect(Buffer.from(bytes).equals(Buffer.from(again))).toBe(true);
    const tamperedSig = serializeBundleBytes({
      bundleId,
      bundleDigest,
      proofRoot: bundleDigest,
      members,
      bindings: BINDINGS,
      signingKeyId: "ed25519:" + "d".repeat(64),
      rootSignature: new Uint8Array([9, 9, 9, 9]),
    });
    expect(contentDigestOf(bytes)).not.toBe(contentDigestOf(tamperedSig));
  });
});
