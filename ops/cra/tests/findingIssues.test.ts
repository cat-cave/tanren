import { describe, expect, it } from "vitest";
import { routeDeferredFindings, type FindingIssueCreate, type FindingIssueGateway } from "../src/findingIssues.js";
import type { NormalizedFinding } from "../src/triage.js";
import { firstSha } from "./helpers.js";

class MemoryIssues implements FindingIssueGateway {
  public readonly created: FindingIssueCreate[] = [];
  public readonly edges: Array<[number, number]> = [];
  private readonly markerIssues = new Map<string, number>();
  private readonly blockers = new Map<number, number[]>();

  public async findByMarker(marker: string) {
    return this.markerIssues.get(marker) ?? null;
  }
  public async create(input: FindingIssueCreate) {
    const number = 1300 + this.created.length;
    this.created.push(input);
    const marker = /CRA-Finding: [^ ]+/u.exec(input.body)?.[0];
    if (marker !== undefined) this.markerIssues.set(marker, number);
    return number;
  }
  public async listBlockedBy(issue: number) {
    return this.blockers.get(issue) ?? [];
  }
  public async issueDatabaseId(issue: number) {
    return issue + 10_000;
  }
  public async addBlockedBy(issue: number, blockerDatabaseId: number) {
    this.edges.push([issue, blockerDatabaseId]);
    this.blockers.set(issue, [...(this.blockers.get(issue) ?? []), blockerDatabaseId - 10_000]);
  }
}

function finding(
  id: string,
  severity: NormalizedFinding["severity"],
  category: NormalizedFinding["category"] = "betterment",
  concerns: NormalizedFinding["concerns"] = "new_work",
): NormalizedFinding {
  return {
    id,
    title: `${id} title`,
    body: `${id} summary`,
    category,
    severity,
    locatable: false,
    path: null,
    line: null,
    side: null,
    evidence: "ops/cra/src/example.ts",
    forced: false,
    concerns,
    fixDirection: `Implement ${id}`,
  };
}

const context = {
  repository: "cat-cave/tanren",
  pr: 1240,
  headSha: firstSha,
  reviewId: 5001,
  bucketLabel: "cra",
  blockedBy: [1200],
};

describe("deferred finding issue routing", () => {
  it("creates one claimable issue per P2/P3 with labels, acceptance, negative control, source, and dependencies", async () => {
    const gateway = new MemoryIssues();
    const result = await routeDeferredFindings(gateway, context, [
      finding("incorrect", "P2", "correctness"),
      finding("ratchet", "P3"),
    ]);
    expect(result.map((issue) => issue.number)).toEqual([1300, 1301]);
    expect(gateway.created[0]?.labels).toEqual(["bug", "cra", "P2"]);
    expect(gateway.created[1]?.labels).toEqual(["enhancement", "cra", "P3"]);
    expect(gateway.created[0]?.body).toContain("## Summary");
    expect(gateway.created[0]?.body).toContain("## Acceptance");
    expect(gateway.created[0]?.body).toContain("Negative control:");
    expect(gateway.created[0]?.body).toContain("cat-cave/tanren#1240");
    expect(gateway.edges).toEqual([
      [1300, 11_200],
      [1301, 11_200],
    ]);
  });

  it("never routes P0/P1 or original-acceptance findings", async () => {
    const gateway = new MemoryIssues();
    await routeDeferredFindings(gateway, context, [
      finding("p0", "P0"),
      finding("p1", "P1"),
      finding("not-new", "P2", "betterment", "acceptance"),
    ]);
    expect(gateway.created).toEqual([]);
  });

  it("deduplicates issues and native dependency edges across retries", async () => {
    const gateway = new MemoryIssues();
    const findings = [finding("stable", "P2")];
    await routeDeferredFindings(gateway, context, findings);
    await routeDeferredFindings(gateway, context, findings);
    expect(gateway.created).toHaveLength(1);
    expect(gateway.edges).toHaveLength(1);
    expect(gateway.created[0]?.body).toContain(`CRA-Finding: cat-cave/tanren#1240/${firstSha}/stable`);
  });
});
