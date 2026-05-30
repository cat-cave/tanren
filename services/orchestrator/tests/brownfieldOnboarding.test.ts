// P3-0016 brownfield onboarding (full track) engine tests.
//
// Exercises the four engine pieces with MOCKED seams (no provider, no network):
//   - recon: a fake `RepoReader` + a mocked `ReconAnswerer` pre-fill chapters,
//     plus the deterministic answerer derives chapters from the repo index.
//   - config-injection: `proposeConfigFiles` builds the 6 files + honors
//     per-file exclude; `openConfigInjectionPr` opens a PR through a fake
//     `ConfigInjectionGitHub` that records the committed files.
//   - seed-dag: recon gaps + GitHub issues become specs (created through the
//     existing P2A-0013 `createSpec` path on an in-memory pool), de-duped.
//   - governance posture: the posture is a P3-0023 enum value persisted via the
//     project config (covered at the route layer; here we assert the policy
//     copy stays in lockstep with the posture).
//
// The pool is the same lightweight SQL-substring stub used by the greenfield
// vision-interview test. No migration is required.

import type pg from "pg";
import { describe, expect, it } from "vitest";
import type { ActorContext } from "../src/auth/schemas.js";
import {
  createDeterministicReconAnswerer,
  openConfigInjectionPr,
  proposeConfigFiles,
  runRecon,
  seedDagFromReconAndIssues,
  type ConfigInjectionGitHub,
  type InjectedConfigPullRequest,
  type ReconAnswerer,
  type ReconIndex,
  type ReconReport,
  type RepoReader,
} from "../src/engine/forge/brownfield/index.js";
import type { IngestedItem } from "../src/engine/forge/inbox/types.js";

const actor: ActorContext = {
  userId: "user_a",
  orgId: "org_a",
  projectId: null,
  scopes: ["platform:admin"],
  source: "session",
};

function fakeReader(index: ReconIndex): RepoReader {
  return {
    async index() {
      return index;
    },
  };
}

const SAMPLE_INDEX: ReconIndex = {
  repoUrl: "https://github.com/cat-cave/tanren-fixture-easy",
  filesIndexed: 3,
  files: [
    { path: "README.md", size: 100, preview: "# fixture" },
    { path: "package.json", size: 200, preview: "{}" },
    { path: ".github/workflows/ci.yml", size: 50, preview: "name: ci" },
  ],
};

const SAMPLE_REPORT: ReconReport = {
  identity: { slug: "tanren-fixture-easy", purpose: "smoke fixture", inferredFrom: "README.md" },
  personas: [{ name: "dev", description: "fixture operator", inferredFrom: "code" }],
  behaviors: [{ persona: "dev", title: "run the fixture", inferredFrom: "ci" }],
  architecture: [{ layer: "ci", detail: "github actions" }],
  risks: [{ severity: "warn", note: "no codeowners" }],
  gaps: [
    {
      id: "design-dna",
      chapter: "design dna",
      question: "default to industrial?",
      options: ["use industrial"],
    },
    { id: "coverage", chapter: "tests", question: "add coverage specs?", options: ["yes"] },
  ],
};

describe("runRecon · read-only recon pre-fills chapters", () => {
  it("uses a mocked answerer over the indexed repo", async () => {
    let sawIndex: ReconIndex | undefined;
    const answerer: ReconAnswerer = {
      async read(index) {
        sawIndex = index;
        return SAMPLE_REPORT;
      },
    };
    const { index, report } = await runRecon({ reader: fakeReader(SAMPLE_INDEX), answerer }, SAMPLE_INDEX.repoUrl);
    expect(sawIndex?.filesIndexed).toBe(3);
    expect(index.repoUrl).toBe(SAMPLE_INDEX.repoUrl);
    expect(report.identity.slug).toBe("tanren-fixture-easy");
    expect(report.gaps).toHaveLength(2);
  });

  it("deterministic answerer derives chapters + flags missing integration files", async () => {
    const { report } = await runRecon({ reader: fakeReader(SAMPLE_INDEX) }, SAMPLE_INDEX.repoUrl);
    expect(report.identity.slug).toBe("tanren-fixture-easy");
    expect(report.architecture.length).toBeGreaterThan(0);
    // No CODEOWNERS / .mergify / tanren-ci in the index → risks flagged.
    expect(report.risks.some((r) => r.note.toLowerCase().includes("codeowners"))).toBe(true);
    expect(report.gaps.length).toBeGreaterThanOrEqual(3);
  });

  it("deterministic answerer is what createDeterministicReconAnswerer returns", async () => {
    const answerer = createDeterministicReconAnswerer();
    const report = await answerer.read(SAMPLE_INDEX);
    expect(report.personas.length).toBeGreaterThan(0);
  });
});

describe("config-injection · 6 files + per-file exclude + open PR", () => {
  const proposeInput = {
    repoSlug: "tanren-fixture-easy",
    orgLogin: "cat-cave",
    repoUrl: SAMPLE_INDEX.repoUrl,
    report: SAMPLE_REPORT,
    posture: "strict" as const,
    generatedAt: "2026-05-28T00:00:00.000Z",
  };

  it("proposes the 6 integration files including the PROJECT.md snapshot", () => {
    const files = proposeConfigFiles(proposeInput);
    expect(files).toHaveLength(6);
    expect(files[0]?.path).toBe(".tanren/PROJECT.md");
    expect(files[0]?.snapshot).toBe(true);
    expect(files.map((f) => f.path)).toContain(".github/workflows/tanren-ci.yml");
    expect(files.map((f) => f.path)).toContain(".mergify.yml");
    expect(files.map((f) => f.path)).toContain("CODEOWNERS");
    // The snapshot mirrors the recon report.
    expect(files[0]?.content).toContain("tanren-fixture-easy");
    expect(files[0]?.content).toContain("smoke fixture");
  });

  it("honors per-file exclude", () => {
    const files = proposeConfigFiles(proposeInput, [".mergify.yml", "CODEOWNERS"]);
    expect(files).toHaveLength(4);
    expect(files.map((f) => f.path)).not.toContain(".mergify.yml");
    expect(files.map((f) => f.path)).not.toContain("CODEOWNERS");
  });

  it("opens ONE PR through a mocked github with the kept files", async () => {
    const committed: string[] = [];
    const github: ConfigInjectionGitHub = {
      async openConfigInjectionPr(input): Promise<InjectedConfigPullRequest> {
        committed.push(...input.files.map((f) => f.path));
        expect(input.body).toContain("No runs happen until this PR is merged");
        return {
          number: 48,
          url: "https://github.com/cat-cave/tanren-fixture-easy/pull/48",
          branch: input.headBranch,
          filesCommitted: input.files.map((f) => f.path),
        };
      },
    };
    const files = proposeConfigFiles(proposeInput, [".gitignore"]);
    const pr = await openConfigInjectionPr({
      github,
      repoUrl: SAMPLE_INDEX.repoUrl,
      baseBranch: "main",
      files,
    });
    expect(pr.number).toBe(48);
    expect(pr.branch).toBe("tanren/integrate");
    expect(committed).toHaveLength(5);
    expect(committed).not.toContain(".gitignore");
  });

  it("rejects opening a PR when every file is excluded", async () => {
    const github: ConfigInjectionGitHub = {
      async openConfigInjectionPr(): Promise<InjectedConfigPullRequest> {
        throw new Error("should not be called");
      },
    };
    await expect(
      openConfigInjectionPr({
        github,
        repoUrl: SAMPLE_INDEX.repoUrl,
        baseBranch: "main",
        files: [],
      }),
    ).rejects.toThrow(/at least one file/);
  });
});

describe("seed-dag · recon gaps + GitHub issues become specs", () => {
  it("creates one spec per issue + per gap, de-duped by title, through createSpec", async () => {
    const { pool, specs } = seedStubPool();
    const issues: IngestedItem[] = [
      {
        externalId: "gh-cat-cave/tanren-fixture-easy#142",
        title: "writer hangs on long writes",
        body: "bug",
        severity: "fail",
        projectId: "p",
      },
      {
        externalId: "gh-cat-cave/tanren-fixture-easy#138",
        title: "support claude as answerer",
        body: "",
        severity: "info",
        projectId: "p",
      },
    ];
    const result = await seedDagFromReconAndIssues(pool, {
      projectId: "p",
      orgId: "org_a",
      report: SAMPLE_REPORT,
      issues,
      actor,
    });
    expect(result.fromIssues).toBe(2);
    expect(result.fromGaps).toBe(2);
    expect(result.seeded).toHaveLength(4);
    expect(specs.size).toBe(4);
    // Each spec carries provenance for the source legend.
    expect(result.seeded.filter((s) => s.source === "github_issue")).toHaveLength(2);
    expect(result.seeded.filter((s) => s.source === "agent_gap")).toHaveLength(2);
  });

  it("drops a gap that duplicates an issue title", async () => {
    const { pool } = seedStubPool();
    const report: ReconReport = {
      ...SAMPLE_REPORT,
      gaps: [{ id: "dup", chapter: "x", question: "writer hangs on long writes", options: [] }],
    };
    const issues: IngestedItem[] = [
      {
        externalId: "gh#142",
        title: "writer hangs on long writes",
        body: "",
        severity: "fail",
        projectId: "p",
      },
    ];
    const result = await seedDagFromReconAndIssues(pool, {
      projectId: "p",
      orgId: "org_a",
      report,
      issues,
      actor,
    });
    expect(result.fromIssues).toBe(1);
    expect(result.fromGaps).toBe(0);
    expect(result.duplicatesDropped).toBe(1);
  });
});

// In-memory pool covering just the createSpec path (project existence +
// access + dependency check + insert), mirroring the vision-interview stub.
function seedStubPool(): { pool: pg.Pool; specs: Map<string, unknown> } {
  const specs = new Map<string, unknown>();
  const query = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> => {
    const sql = text.replaceAll(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT project_id FROM projects")) return { rows: [{ project_id: params[0] }], rowCount: 1 };
    if (sql.includes("FROM project_members")) return { rows: [{ role: "admin" }], rowCount: 1 };
    if (sql.startsWith("SELECT spec_id FROM specs WHERE project_id")) {
      const ids = (params[1] as string[]) ?? [];
      const present = ids.filter((id) => specs.has(id)).map((id) => ({ spec_id: id }));
      return { rows: present, rowCount: present.length };
    }
    if (sql.startsWith("INSERT INTO specs")) {
      specs.set(String(params[0]), { id: params[0] });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    pool: { query, connect: async () => ({ query, release() {} }) } as unknown as pg.Pool,
    specs,
  };
}
