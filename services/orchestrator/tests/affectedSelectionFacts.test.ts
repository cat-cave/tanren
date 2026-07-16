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
  boundCoverageSnapshotsEqual,
  selectAffectedBehaviorRevisions,
  type BoundBehaviorCoverageSnapshot,
} from "../src/engine/runtimeVerification/affectedSelection.js";
import {
  AFFECTED_SELECTION_FACT_MEDIA_TYPE,
  affectedSelectionEventPayload,
  appendAffectedSelectionEvent,
  buildAffectedSelectionFact,
  decodeAffectedSelectionFact,
  encodeAffectedSelectionFact,
  persistAffectedSelectionFact,
} from "../src/engine/runtimeVerification/affectedSelectionFacts.js";

const HEAD = "a".repeat(40);
const MEMBER = "b".repeat(64);
const REVISION_DIGEST = parseDigest(`sha256:${"c".repeat(64)}`);

function bound(): BoundBehaviorCoverageSnapshot {
  return {
    binding: { integrationNodeId: "node-a", preparedHeadSha: HEAD, treeHash: "tree-a", memberKey: MEMBER },
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
      snapshot: input.snapshot,
      changedTargets: [{ kind: "source", targetRef: "src/a.ts" }],
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

  it("makes head, tree, member, edge, and revision-digest mutations stale", () => {
    const original = bound();
    const mutations: BoundBehaviorCoverageSnapshot[] = [
      { ...original, binding: { ...original.binding, preparedHeadSha: "d".repeat(40) } },
      { ...original, binding: { ...original.binding, treeHash: "tree-mutated" } },
      { ...original, binding: { ...original.binding, memberKey: "e".repeat(64) } },
      {
        ...original,
        snapshot: {
          ...original.snapshot,
          behaviors: [{ ...original.snapshot.behaviors[0]!, contentDigest: parseDigest(`sha256:${"f".repeat(64)}`) }],
        },
      },
      {
        ...original,
        snapshot: {
          ...original.snapshot,
          behaviors: [{ ...original.snapshot.behaviors[0]!, edges: [] }],
        },
      },
      { ...original, snapshot: { ...original.snapshot, behaviors: [] } },
    ];
    for (const mutation of mutations) expect(boundCoverageSnapshotsEqual(original, mutation)).toBe(false);
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
