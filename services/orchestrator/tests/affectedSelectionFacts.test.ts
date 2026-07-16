import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { BehaviorRevisionId } from "../src/engine/contracts/behaviorRevision.js";
import {
  contentDigestOf,
  parseDigest,
  type CasArtifactBytes,
  type CasArtifactRef,
  type CasByteStore,
  type Digest,
} from "../src/engine/contracts/cas.js";
import type { BehaviorCoverageEdgeId } from "../src/engine/contracts/runtimeVerification.js";
import type { EventStore } from "../src/engine/eventStore.js";
import type { QueryClient } from "../src/engine/data/orgScopedDb.js";
import {
  AffectedSelectionEventMismatchError,
  AffectedSelectionFactNotFoundError,
  AffectedSelectionFactsStore,
} from "../src/engine/repositories/affectedSelectionFacts.js";
import {
  buildCoverageAuthorityFingerprint,
  selectAffectedBehaviorRevisions,
  type BoundBehaviorCoverageSnapshot,
} from "../src/engine/runtimeVerification/affectedSelection.js";
import {
  AFFECTED_SELECTION_FACT_MEDIA_TYPE,
  affectedSelectionEventPayload,
  appendAffectedSelectionEvent,
  boundCoverageSnapshotsEqual,
  buildAffectedSelectionFact,
  decodeAffectedSelectionFact,
  encodeAffectedSelectionFact,
  persistAffectedSelectionFact,
} from "../src/engine/runtimeVerification/affectedSelectionFacts.js";

const BASE = "0".repeat(40);
const HEAD = "a".repeat(40);
const MEMBER = "b".repeat(64);
const REVISION_DIGEST = parseDigest(`sha256:${"c".repeat(64)}`);
const TARGETS = [{ kind: "source" as const, targetRef: "src/a.ts" }];

function bound(): BoundBehaviorCoverageSnapshot {
  const input = {
    binding: {
      integrationNodeId: "node-a",
      baseSha: BASE,
      preparedHeadSha: HEAD,
      treeHash: "tree-a",
      memberKey: MEMBER,
    },
    snapshot: {
      orgId: "org-a",
      projectId: "project-a",
      behaviors: [
        {
          behaviorRevisionId: "br-a" as BehaviorRevisionId,
          contentDigest: REVISION_DIGEST,
          title: "behavior a",
          edges: [
            {
              id: "edge-a" as BehaviorCoverageEdgeId,
              kind: "source",
              targetRef: "src/a.ts",
            },
          ],
        },
      ],
    },
  };
  return {
    ...input,
    authorityFingerprint: buildCoverageAuthorityFingerprint({ ...input, changedTargets: TARGETS }),
  };
}

class MemoryCas implements CasByteStore {
  readonly rows = new Map<Digest, CasArtifactBytes>();

  async put(input: { orgId: string; bytes: Uint8Array; mediaType: string }): Promise<CasArtifactRef> {
    const digest = contentDigestOf(input.bytes);
    this.rows.set(digest, { digest, bytes: input.bytes, mediaType: input.mediaType });
    return { digest, byteSize: input.bytes.byteLength, mediaType: input.mediaType };
  }

  async get(_orgId: string, digest: Digest): Promise<CasArtifactBytes> {
    const row = this.rows.get(digest);
    if (row === undefined) throw new Error("missing CAS row");
    return row;
  }

  async has(_orgId: string, digest: Digest): Promise<boolean> {
    return this.rows.has(digest);
  }
}

function fact() {
  const input = bound();
  return buildAffectedSelectionFact({
    bound: input,
    selection: selectAffectedBehaviorRevisions({
      bound: input,
      changedTargets: TARGETS,
    }),
  });
}

describe("immutable affected-selection CAS/event fact", () => {
  it("uses the sole CAS digest as analysisId and appends the exact W0 event", async () => {
    const cas = new MemoryCas();
    const selection = await persistAffectedSelectionFact(cas, fact());
    expect(selection.analysisId).toBe(contentDigestOf(encodeAffectedSelectionFact(fact())));
    const artifact = await cas.get("org-a", selection.analysisId);
    expect(artifact.mediaType).toBe(AFFECTED_SELECTION_FACT_MEDIA_TYPE);
    expect(decodeAffectedSelectionFact(artifact.bytes)).toEqual(fact());

    const append = vi.fn<EventStore["append"]>(async () => {});
    await appendAffectedSelectionEvent({ append }, selection, { runId: "run-a", specId: "spec-a" });
    expect(append).toHaveBeenCalledWith({
      orgId: "org-a",
      projectId: "project-a",
      runId: "run-a",
      specId: "spec-a",
      eventType: "behavior.coverage.selection_analyzed",
      payload: affectedSelectionEventPayload(selection),
    });
  });

  it("rejects non-canonical bytes and a selection that no longer derives from the graph", () => {
    const bytes = encodeAffectedSelectionFact(fact());
    const padded = new TextEncoder().encode(`${new TextDecoder().decode(bytes)}\n`);
    expect(() => decodeAffectedSelectionFact(padded)).toThrow("canonical JSON");

    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    const selection = Reflect.get(raw, "selection") as Record<string, unknown>;
    selection["selected"] = [];
    expect(() => decodeAffectedSelectionFact(new TextEncoder().encode(JSON.stringify(raw)))).toThrow("does not derive");
  });

  it("locks Unicode ordering to one locale-independent golden byte digest and decodes it", () => {
    const binding = {
      integrationNodeId: "node-unicode",
      baseSha: BASE,
      preparedHeadSha: "1".repeat(40),
      treeHash: "tree-unicode",
      memberKey: "2".repeat(64),
    };
    const snapshot = {
      orgId: "org-a",
      projectId: "project-a",
      behaviors: [
        {
          behaviorRevisionId: "z" as BehaviorRevisionId,
          contentDigest: parseDigest(`sha256:${"a".repeat(64)}`),
          title: "Z",
          edges: [{ id: "edge-z" as BehaviorCoverageEdgeId, kind: "source" as const, targetRef: "src/z.ts" }],
        },
        {
          behaviorRevisionId: "ä" as BehaviorRevisionId,
          contentDigest: parseDigest(`sha256:${"b".repeat(64)}`),
          title: "Ä",
          edges: [{ id: "edge-ä" as BehaviorCoverageEdgeId, kind: "source" as const, targetRef: "src/ä.ts" }],
        },
      ],
    };
    const changedTargets = [
      { kind: "source" as const, targetRef: "src/ä.ts" },
      { kind: "source" as const, targetRef: "src/z.ts" },
    ];
    const unicodeBound = {
      binding,
      snapshot,
      authorityFingerprint: buildCoverageAuthorityFingerprint({ binding, snapshot, changedTargets }),
    };
    const unicodeFact = buildAffectedSelectionFact({
      bound: unicodeBound,
      selection: selectAffectedBehaviorRevisions({ bound: unicodeBound, changedTargets }),
    });
    const bytes = encodeAffectedSelectionFact(unicodeFact);
    expect(bytes).toHaveLength(1_544);
    expect(contentDigestOf(bytes)).toBe("sha256:d138439ef071f4c934a9a603c5ab6bd4bbd48bee470353a7dc1d6587a4b175ae");
    expect(decodeAffectedSelectionFact(bytes)).toEqual(unicodeFact);
  });

  it("compares strict bound values independent of object key insertion order and fails closed", () => {
    const factShaped = bound();
    const repositoryShaped: BoundBehaviorCoverageSnapshot = {
      binding: factShaped.binding,
      authorityFingerprint: factShaped.authorityFingerprint,
      snapshot: factShaped.snapshot,
    };
    expect(Object.keys(factShaped)).toEqual(["binding", "snapshot", "authorityFingerprint"]);
    expect(Object.keys(repositoryShaped)).toEqual(["binding", "authorityFingerprint", "snapshot"]);
    expect(boundCoverageSnapshotsEqual(factShaped, repositoryShaped)).toBe(true);

    const mutations: BoundBehaviorCoverageSnapshot[] = [
      { ...factShaped, binding: { ...factShaped.binding, baseSha: "9".repeat(40) } },
      { ...factShaped, binding: { ...factShaped.binding, preparedHeadSha: "d".repeat(40) } },
      { ...factShaped, binding: { ...factShaped.binding, treeHash: "tree-mutated" } },
      { ...factShaped, binding: { ...factShaped.binding, memberKey: "e".repeat(64) } },
      {
        ...factShaped,
        snapshot: {
          ...factShaped.snapshot,
          behaviors: [{ ...factShaped.snapshot.behaviors[0]!, contentDigest: parseDigest(`sha256:${"f".repeat(64)}`) }],
        },
      },
      {
        ...factShaped,
        snapshot: {
          ...factShaped.snapshot,
          behaviors: [{ ...factShaped.snapshot.behaviors[0]!, edges: [] }],
        },
      },
      { ...factShaped, snapshot: { ...factShaped.snapshot, behaviors: [] } },
      { ...factShaped, authorityFingerprint: "" },
    ];
    for (const mutation of mutations) expect(boundCoverageSnapshotsEqual(repositoryShaped, mutation)).toBe(false);

    const malformed: unknown[] = [
      { binding: factShaped.binding, snapshot: factShaped.snapshot },
      {
        ...factShaped,
        binding: {
          integrationNodeId: factShaped.binding.integrationNodeId,
          baseSha: factShaped.binding.baseSha,
          preparedHeadSha: factShaped.binding.preparedHeadSha,
          treeHash: factShaped.binding.treeHash,
        },
      },
      { ...factShaped, authorityFingerprint: 1 },
      {
        ...factShaped,
        snapshot: {
          ...factShaped.snapshot,
          behaviors: [{ ...factShaped.snapshot.behaviors[0]!, contentDigest: "not-a-digest" }],
        },
      },
    ];
    for (const value of malformed) expect(boundCoverageSnapshotsEqual(repositoryShaped, value)).toBe(false);

    const extra = { ...repositoryShaped, unexpected: true };
    expect(boundCoverageSnapshotsEqual(extra, extra)).toBe(false);
    const nestedExtra = {
      ...repositoryShaped,
      snapshot: {
        ...repositoryShaped.snapshot,
        behaviors: [
          {
            ...repositoryShaped.snapshot.behaviors[0]!,
            edges: [{ ...repositoryShaped.snapshot.behaviors[0]!.edges[0]!, unexpected: true }],
          },
        ],
      },
    };
    expect(boundCoverageSnapshotsEqual(nestedExtra, nestedExtra)).toBe(false);
  });

  it("requires an exact-scope event before CAS resolution and rejects event/body drift", async () => {
    const cas = new MemoryCas();
    const selection = await persistAffectedSelectionFact(cas, fact());
    const expectedPayload = affectedSelectionEventPayload(selection);
    const get = vi.spyOn(cas, "get");
    const missingClient = {
      query: vi.fn<() => Promise<{ rows: never[]; rowCount: number }>>(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as QueryClient;
    await expect(
      AffectedSelectionFactsStore.read(
        missingClient,
        cas,
        { orgId: "org-b", projectId: "project-a" },
        selection.analysisId,
      ),
    ).rejects.toBeInstanceOf(AffectedSelectionFactNotFoundError);
    expect(get).not.toHaveBeenCalled();

    const drifted = { ...expectedPayload, mode: "expanded_unknown" };
    expect(isDeepStrictEqual(drifted, expectedPayload)).toBe(false);
    const driftClient = {
      query: vi.fn<() => Promise<{ rows: { payload: typeof drifted }[]; rowCount: number }>>(async () => ({
        rows: [{ payload: drifted }],
        rowCount: 1,
      })),
    } as unknown as QueryClient;
    await expect(
      AffectedSelectionFactsStore.read(
        driftClient,
        cas,
        { orgId: "org-a", projectId: "project-a" },
        selection.analysisId,
      ),
    ).rejects.toBeInstanceOf(AffectedSelectionEventMismatchError);
  });

  it("reads latest only from the exact org/project event stream", async () => {
    const cas = new MemoryCas();
    const selection = await persistAffectedSelectionFact(cas, fact());
    const payload = affectedSelectionEventPayload(selection);
    const client = {
      query: vi.fn<
        (
          _sql: string,
          params?: unknown[],
        ) => Promise<{
          rows: { payload: typeof payload; analysis_id: Digest }[];
          rowCount: number;
        }>
      >(async (_sql, params) => {
        expect(params).toEqual(["org-a", "project-a"]);
        return { rows: [{ payload, analysis_id: selection.analysisId }], rowCount: 1 };
      }),
    } as unknown as QueryClient;
    await expect(
      AffectedSelectionFactsStore.readLatest(client, cas, { orgId: "org-a", projectId: "project-a" }),
    ).resolves.toMatchObject({ selection: { analysisId: selection.analysisId } });
  });
});
