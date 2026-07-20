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
  proofUnitContentBytes,
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

describe("canonicalSealMessage — byte-stable signed message over the FULL identity", () => {
  const IDENTITY = {
    orgId: "org_a",
    projectId: "proj_a",
    bundleDigest: computeProofRoot([unit("a")]),
    proofRoot: computeProofRoot([unit("a")]),
    bindings: BINDINGS,
  };

  it("is identical for identical identity regardless of binding key order", () => {
    const a = canonicalSealMessage(IDENTITY);
    const b = canonicalSealMessage({ ...IDENTITY, bindings: { ...BINDINGS } });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("CHANGES when orgId changes (tenant is inside the signed envelope)", () => {
    const base = canonicalSealMessage(IDENTITY);
    const rebound = canonicalSealMessage({ ...IDENTITY, orgId: "org_b" });
    expect(Buffer.from(base).equals(Buffer.from(rebound))).toBe(false);
  });

  it("CHANGES when projectId changes", () => {
    const base = canonicalSealMessage(IDENTITY);
    const rebound = canonicalSealMessage({ ...IDENTITY, projectId: "proj_b" });
    expect(Buffer.from(base).equals(Buffer.from(rebound))).toBe(false);
  });

  it("CHANGES when bundleDigest changes (bundle identity is signed)", () => {
    const base = canonicalSealMessage(IDENTITY);
    const other = canonicalSealMessage({ ...IDENTITY, bundleDigest: computeProofRoot([unit("z")]) });
    expect(Buffer.from(base).equals(Buffer.from(other))).toBe(false);
  });

  it("changes when the proof root changes", () => {
    const base = canonicalSealMessage(IDENTITY);
    const other = canonicalSealMessage({ ...IDENTITY, proofRoot: computeProofRoot([unit("b")]) });
    expect(Buffer.from(base).equals(Buffer.from(other))).toBe(false);
  });

  it("changes when a binding field changes", () => {
    const base = canonicalSealMessage(IDENTITY);
    const tampered = canonicalSealMessage({ ...IDENTITY, bindings: { ...BINDINGS, nonce: "nonce-2" } });
    expect(Buffer.from(base).equals(Buffer.from(tampered))).toBe(false);
  });
});

describe("proofUnitContentBytes — binds kind + verdict + body (audit Finding 3)", () => {
  it("distinct kind OR verdict over the same body yields distinct content digests", () => {
    const body = { subject: "s1" };
    const base = contentDigestOf(proofUnitContentBytes({ kind: "test", verdict: "passed", body }));
    const diffVerdict = contentDigestOf(proofUnitContentBytes({ kind: "test", verdict: "failed", body }));
    const diffKind = contentDigestOf(proofUnitContentBytes({ kind: "security_finding", verdict: "passed", body }));
    expect(base).not.toBe(diffVerdict);
    expect(base).not.toBe(diffKind);
    expect(diffVerdict).not.toBe(diffKind);
  });

  it("identical (kind, verdict, body) is stable", () => {
    const body = { subject: "s1" };
    expect(contentDigestOf(proofUnitContentBytes({ kind: "test", verdict: "passed", body }))).toBe(
      contentDigestOf(proofUnitContentBytes({ kind: "test", verdict: "passed", body })),
    );
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

  it("REJECTS a non-canonical encoding of the same (org, project, digest) (audit Finding 4)", () => {
    const bundleDigest = computeProofRoot([unit("a")]);
    const canonical = encodeBundleId({ orgId: "o", projectId: "p", bundleDigest });
    // Same fields, but unsorted keys / extra whitespace / an extra key — all
    // JSON-parseable to the same context, yet NOT the canonical byte form.
    const unsortedKeys = `pb1_${Buffer.from(`{"p":"p","o":"o","d":${JSON.stringify(bundleDigest)}}`, "utf8").toString("base64url")}`;
    const extraKey = `pb1_${Buffer.from(`{"d":${JSON.stringify(bundleDigest)},"o":"o","p":"p","x":1}`, "utf8").toString("base64url")}`;
    const spaced = `pb1_${Buffer.from(`{ "d": ${JSON.stringify(bundleDigest)}, "o": "o", "p": "p" }`, "utf8").toString("base64url")}`;
    expect(unsortedKeys).not.toBe(canonical);
    expect(() => decodeBundleId(unsortedKeys)).toThrow(MalformedBundleIdError);
    expect(() => decodeBundleId(extraKey)).toThrow(MalformedBundleIdError);
    expect(() => decodeBundleId(spaced)).toThrow(MalformedBundleIdError);
    // The canonical form still decodes.
    expect(decodeBundleId(canonical)).toEqual({ orgId: "o", projectId: "p", bundleDigest });
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
