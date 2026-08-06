import { describe, expect, it } from "vitest";
import type { RunnerHandle } from "../src/engine/contracts/allocator.js";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { resolveEagerProofArtifacts } from "../src/engine/merge/eagerBeamProofArtifacts.js";
import { EagerBeamPlanStager, eagerProofReuseDigest } from "../src/engine/merge/eagerBeamPlanStager.js";
import { FragmentEvidenceManifestV1Schema } from "../src/engine/templates/fragments/fragmentEvidenceContract.js";
import { LOCAL_HANDLE } from "./conformance/fakes/localCommandSubstrate.js";

const INTEGRATION = { ref: "tanren/eager/run_frontier", headSha: "b".repeat(40), treeHash: "d".repeat(40) };
const EVIDENCE =
  '{"schemaVersion":"fragment_evidence_manifest.v1","fragment":{"id":"test-invite","kind":"test","version":"1"},"evidence":{"schemaVersion":"fragment_evidence.v1","junitReportPath":"reports/junit.xml","testSelector":{"path":".tanren/tests.json","format":"json"},"behaviorManifest":{"path":".tanren/behavior-manifest.json","format":"json"},"contentDigest":"sha256:36cf5e92516ee88d257066aa9b8ad8cffff9a570bdbcfd3a6d8a872abecbf2be"}}';
const PARSED_EVIDENCE = FragmentEvidenceManifestV1Schema.parse(JSON.parse(EVIDENCE));
const INVALID_AUTHORITIES = [
  "fragment_unvalidated",
  "fragment_mismatch",
  "artifact_absent",
  "artifact_wrong_org",
  "artifact_wrong_project",
  "artifact_wrong_media",
] as const;
type AuthorityState = "valid" | (typeof INVALID_AUTHORITIES)[number];
const rows = (...values: unknown[]) => ({ rows: values, rowCount: values.length });
const DESIGN_CONTRACT = { version: 1, domain: "saas-web", identity: "calm", intent: "effortless" };

class ArtifactSubstrate implements CommandSubstrate {
  public identity = INTEGRATION;
  public evidence = EVIDENCE;

  public constructor(
    public manifest = '{"schemaVersion":"fragment_behavior_manifest.v1","behaviors":["invite"]}',
    public manifestExitCode = 0,
  ) {}

  public async run(_target: RunnerHandle, command: RunnerCommand): Promise<CommandResult> {
    if (command.command.startsWith("git rev-parse")) {
      return { exitCode: 0, stdout: `${this.identity.headSha}\n${this.identity.treeHash}\n`, stderr: "" };
    }
    if (command.command.includes("evidence-contract.json")) return { exitCode: 0, stdout: this.evidence, stderr: "" };
    if (command.command.includes("behavior-manifest.json")) {
      return { exitCode: this.manifestExitCode, stdout: this.manifest, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

class ArtifactPool {
  public contract = DESIGN_CONTRACT;
  public contractState: "found" | "absent" | "corrupt" = "found";
  public authority: AuthorityState = "valid";
  public proofEffects = 0;

  public connect = async (): Promise<this> => this;

  public release(): void {}

  public async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("FROM design_contracts")) {
      if (this.contractState === "absent") return rows();
      return rows({
        id: "design_eager",
        org_id: "org_eager",
        project_id: "project_eager",
        version: 1,
        domain: "saas-web",
        contract: this.contractState === "corrupt" ? { broken: true } : this.contract,
      });
    }
    if (sql.includes("FROM fragments")) {
      if (this.authority === "fragment_unvalidated") return rows();
      return rows({
        kind: "test",
        label: this.authority === "fragment_mismatch" ? "other" : "invite",
        version: "1",
        contract: { evidence: PARSED_EVIDENCE.evidence },
      });
    }
    if (sql.includes("FROM verification_artifacts")) {
      if (this.authority.startsWith("artifact_")) return rows();
      return rows({ cas_digest: PARSED_EVIDENCE.evidence.contentDigest, proof_unit_digest: null });
    }
    if (sql.includes("INSERT INTO integration_proof_units") || sql.includes("event_type, payload)"))
      this.proofEffects += 1;
    return { rows: [], rowCount: 1 };
  }
}

class StagerPool extends ArtifactPool {
  private cas: { digest: string; mediaType: string; bytes: Buffer } | undefined;
  public casWrites = 0;

  public override async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    if (sql.includes("INSERT INTO cas_artifacts")) {
      const [_, digest, __, mediaType, bytes] = params;
      if (typeof digest === "string" && typeof mediaType === "string" && Buffer.isBuffer(bytes)) {
        this.cas = { digest, mediaType, bytes };
        this.casWrites += 1;
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT byte_size, media_type, inline_bytes")) {
      const stored = this.cas;
      if (stored === undefined) return rows();
      return rows({ byte_size: stored.bytes.byteLength, media_type: stored.mediaType, inline_bytes: stored.bytes });
    }
    return await super.query(sql, params);
  }
}

function resolve(pool: ArtifactPool, ssh: ArtifactSubstrate) {
  return resolveEagerProofArtifacts({
    pool: pool as never,
    ssh,
    orgId: "org_eager",
    projectId: "project_eager",
    target: LOCAL_HANDLE,
    workspacePath: "/workspace",
    integration: INTEGRATION,
  });
}

describe("EAGER proof artifact bindings", () => {
  it("rejects malformed behavior instead of fabricating a reusable stamp", async () =>
    expect(resolve(new ArtifactPool(), new ArtifactSubstrate("not json"))).rejects.toThrow(
      "behavior-manifest artifact is malformed",
    ));

  it("accepts valid exact-head evidence and behavior JSON padded beyond 64 KiB", async () => {
    const behavior = new ArtifactSubstrate(`${" ".repeat(64 * 1024 + 1)}${new ArtifactSubstrate().manifest}`);
    const evidence = new ArtifactSubstrate();
    evidence.evidence = `${" ".repeat(64 * 1024 + 1)}${EVIDENCE}`;
    for (const ssh of [behavior, evidence]) {
      const pool = new StagerPool();
      await expect(stage(pool, ssh)).resolves.toBeDefined();
      expect(pool.casWrites).toBe(1);
    }
  });

  it("rejects a ref identity mismatch and a non-canonical evidence manifest before CAS staging", async () => {
    const mismatchPool = new StagerPool();
    const mismatchSsh = new ArtifactSubstrate();
    mismatchSsh.identity = { ...INTEGRATION, treeHash: "e".repeat(40) };
    await expect(stage(mismatchPool, mismatchSsh)).rejects.toThrow("does not match the exported ref");
    expect(mismatchPool.casWrites).toBe(0);

    const malformedPool = new StagerPool();
    const malformedSsh = new ArtifactSubstrate();
    malformedSsh.evidence = EVIDENCE.replace(
      '"schemaVersion":"fragment_evidence.v1"',
      '"schemaVersion":"fragment_evidence.v1","extra":true',
    );
    await expect(stage(malformedPool, malformedSsh)).rejects.toThrow("evidence manifest is malformed");
    expect(malformedPool.casWrites).toBe(0);
  });

  it("fails closed when the manifest is absent, the DesignContract is absent, or the DesignContract is corrupt", async () => {
    const absent = new ArtifactPool();
    absent.contractState = "absent";
    await expect(resolve(absent, new ArtifactSubstrate())).rejects.toThrow("DesignContract artifact is unavailable");
    const corrupt = new ArtifactPool();
    corrupt.contractState = "corrupt";
    await expect(resolve(corrupt, new ArtifactSubstrate())).rejects.toThrow("design_contracts row");
  });

  it("production eager staging awaits and binds two proof units to the resolved artifact stamps", async () => {
    const pool = new StagerPool();
    const ssh = new ArtifactSubstrate();
    const staged = await stage(pool, ssh);
    expect(staged.plan.fragmentEvidenceDigest).toBe(
      "sha256:36cf5e92516ee88d257066aa9b8ad8cffff9a570bdbcfd3a6d8a872abecbf2be",
    );
    const evaluation = await evaluate(pool, ssh, staged);
    expect(evaluation.units.map((unit) => [unit.kind, unit.artifactHash]).sort()).toEqual([
      ["eager_behavior_manifest_binding", staged.proofArtifacts.behaviorManifestDigest],
      ["eager_design_contract_binding", staged.proofArtifacts.designContractDigest],
      ["eager_fragment_evidence_binding", staged.proofArtifacts.fragmentEvidenceDigest],
      ["eager_materialized_integration_binding", expect.any(String)],
      ["eager_proof_reuse_binding", eagerProofReuseDigest(staged.proofReuseInput)],
    ]);
    pool.contract = { ...pool.contract, intent: "changed design intent" };
    const changedDesign = await stage(pool, ssh);
    expect(changedDesign.proofArtifacts.designContractDigest).not.toBe(staged.proofArtifacts.designContractDigest);
    ssh.manifest = '{"schemaVersion":"fragment_behavior_manifest.v1","behaviors":["invite","export"]}';
    const changedBehavior = await stage(pool, ssh);
    expect(changedBehavior.proofArtifacts.behaviorManifestDigest).not.toBe(
      changedDesign.proofArtifacts.behaviorManifestDigest,
    );
  });

  it.each(INVALID_AUTHORITIES)(
    "NEGATIVE CONTROL — rejects %s authority before any reusable proof effect",
    async (authority) => {
      const pool = new StagerPool();
      const ssh = new ArtifactSubstrate();
      const staged = await stage(pool, ssh);
      pool.authority = authority;
      await expect(evaluate(pool, ssh, staged)).rejects.toThrow("fragment evidence authority is unavailable");
      expect(pool.proofEffects).toBe(0);
    },
  );

  it.each(["gateConfigHash", "policyVersion", "appEnvHash"] as const)("binds %s into proof reuse", async (field) => {
    const pool = new StagerPool();
    const ssh = new ArtifactSubstrate();
    const staged = await stage(pool, ssh);
    const changed = { ...staged.proofReuseInput, [field]: `changed-${field}` };
    expect(eagerProofReuseDigest(changed)).not.toBe(eagerProofReuseDigest(staged.proofReuseInput));
  });
});

function stage(pool: StagerPool, ssh: ArtifactSubstrate) {
  return new EagerBeamPlanStager({ pool: pool as never, ssh }).stage({
    beamWidth: 1,
    rank: 1,
    orgId: "org_eager",
    projectId: "project_eager",
    frontierRunId: "run_frontier",
    frontierSpecId: "spec_frontier",
    facts: {
      repoUrl: "https://github.com/cat-cave/repo.git",
      baseBranch: "main",
      baseSha: "a".repeat(40),
      members: [
        { specId: "spec_frontier", runId: "run_frontier", branch: "feature/frontier", headSha: "b".repeat(40) },
      ],
      memberKey: "c".repeat(64),
      runnerImage: "runner@sha256:test",
      policyVersion: "1",
      quarantineVersion: "none",
      appEnv: {},
      installation: undefined,
      staticRef: "token",
    },
    gateInput: { target: LOCAL_HANDLE, workspacePath: "/workspace" },
    integration: INTEGRATION,
  });
}

function evaluate(pool: StagerPool, ssh: ArtifactSubstrate, staged: Awaited<ReturnType<typeof stage>>) {
  return new EagerBeamPlanStager({ pool: pool as never, ssh }).evaluateMaterialization({
    orgId: "org_eager",
    projectId: "project_eager",
    nodeId: "node_eager",
    staged,
  });
}
