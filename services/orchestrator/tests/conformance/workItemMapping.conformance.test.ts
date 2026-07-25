import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  InvalidWorkItemMappingError,
  MalformedProviderWorkItemError,
  UnknownWorkItemMappingVersionError,
  mapProviderWorkItem,
  parseWorkItemMappingProfile,
  verifyLifecycleReadbackConformance,
} from "../../src/engine/forge/workItemMapping.js";

function contract(name: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), "contracts/work-items", name), "utf8")) as unknown;
}

const profile = contract("public-mapping-profile.v1.json");
const corpus = contract("lifecycle-readback-corpus.v1.json");

const githubIssue = {
  action: "closed",
  issue: {
    number: 1268,
    title: "Declarative work-item mapping schema",
    body: "Version the public profile and evidence corpus.",
    updated_at: "rev-close",
    labels: [{ name: "bug" }],
  },
  repository: { owner: { login: "cat-cave" }, name: "fixture" },
};

describe("public work-item mapping profile conformance", () => {
  it("maps provider-shaped input with explicit caller org scope", () => {
    expect(
      mapProviderWorkItem(profile, {
        orgId: "org_conformance",
        sourceId: "source_1268",
        projectId: "project_1268",
        payload: githubIssue,
      }),
    ).toEqual({
      orgId: "org_conformance",
      sourceId: "source_1268",
      projectId: "project_1268",
      externalKey: "gh-cat-cave/fixture#1268",
      providerObjectId: "gh-cat-cave/fixture#1268",
      providerRevision: "rev-close",
      status: "closed",
      severity: "fail",
      title: "Declarative work-item mapping schema",
      body: "Version the public profile and evidence corpus.",
    });
  });

  it("rejects invalid and unknown mapping versions before mapping", () => {
    expect(() =>
      parseWorkItemProfileWithVersion({ ...(profile as Record<string, unknown>), version: "work-item-mapping.v2" }),
    ).toThrow(UnknownWorkItemMappingVersionError);
    expect(() =>
      parseWorkItemProfileWithVersion({ ...(profile as Record<string, unknown>), version: undefined }),
    ).toThrow(UnknownWorkItemMappingVersionError);
    expect(() =>
      parseWorkItemProfileWithVersion({ ...(profile as Record<string, unknown>), orgScope: "provider" }),
    ).toThrow(InvalidWorkItemMappingError);
  });

  it("rejects malformed provider input instead of omitting a partial item", () => {
    expect(() =>
      mapProviderWorkItem(profile, {
        orgId: "org_conformance",
        sourceId: "source_1268",
        payload: { ...githubIssue, issue: { ...githubIssue.issue, updated_at: undefined } },
      }),
    ).toThrow(MalformedProviderWorkItemError);
    expect(() =>
      mapProviderWorkItem(profile, {
        orgId: "org_conformance",
        sourceId: "source_1268",
        payload: { ...githubIssue, issue: { ...githubIssue.issue, labels: [{ nope: "bug" }] } },
      }),
    ).toThrow(MalformedProviderWorkItemError);
  });

  it("verifies the versioned lifecycle/readback corpus with exact multiset semantics", () => {
    const parsed = parseWorkItemProfileWithVersion(profile);
    const actual = (corpus as { cases: unknown[] }).cases;
    expect(verifyLifecycleReadbackConformance(parsed, corpus, actual)).toMatchObject({
      profileVersion: "work-item-mapping.v1",
      orgId: "org_conformance",
      workItemId: "gh-cat-cave/fixture#1268",
      caseCount: 4,
    });
    expect(() => verifyLifecycleReadbackConformance(parsed, corpus, actual.slice(0, -1))).toThrow(
      /incomplete or has extra cases/u,
    );
    const mismatched = actual.map((item) => ({ ...(item as Record<string, unknown>) }));
    (mismatched[1] as Record<string, unknown>).readback = {
      providerRevision: "rev-close",
      effect: "open",
      observation: { state: "closed" },
    };
    expect(() => verifyLifecycleReadbackConformance(parsed, corpus, mismatched)).toThrow(
      /proof does not equal lifecycle effect/u,
    );
    const alteredProfile = structuredClone(profile) as {
      lifecycle: { operations: { close: { readback: { equals: string } } } };
    };
    alteredProfile.lifecycle.operations.close.readback.equals = "open";
    expect(() => verifyLifecycleReadbackConformance(alteredProfile, corpus, actual)).toThrow(
      /readback contract does not prove close/u,
    );
    const profileRecord = profile as { lifecycle: { operations: { open: unknown } } };
    const limitedProfile = {
      ...(profile as Record<string, unknown>),
      lifecycle: { capabilities: ["open"], operations: { open: profileRecord.lifecycle.operations.open } },
    };
    expect(() => verifyLifecycleReadbackConformance(limitedProfile, corpus, actual)).toThrow(
      /operation multiset does not cover profile capabilities/u,
    );
    const trimmedCorpus = {
      ...(corpus as Record<string, unknown>),
      cases: actual.slice(0, -1),
    };
    expect(() => verifyLifecycleReadbackConformance(parsed, trimmedCorpus, trimmedCorpus.cases)).toThrow(
      /operation multiset does not cover profile capabilities/u,
    );
  });
});

function parseWorkItemProfileWithVersion(input: unknown) {
  return parseWorkItemMappingProfile(input);
}
