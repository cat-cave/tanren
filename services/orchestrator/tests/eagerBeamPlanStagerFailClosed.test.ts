import { describe, expect, it } from "vitest";
import type { CommandResult, CommandSubstrate, RunnerCommand } from "../src/engine/contracts/commandSubstrate.js";
import { EagerBeamPlanStager } from "../src/engine/merge/eagerBeamPlanStager.js";

class EmptyCiConfigSubstrate implements CommandSubstrate {
  public async run(_target: never, _command: RunnerCommand): Promise<CommandResult> {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
}

describe("EAGER plan staging fail closed", () => {
  it("rejects an empty exact member set before it can be frozen or persisted", async () => {
    const stager = new EagerBeamPlanStager({ pool: {} as never, ssh: new EmptyCiConfigSubstrate() });

    await expect(
      stager.stage({
        beamWidth: 1,
        rank: 1,
        orgId: "org_eager",
        projectId: "project_eager",
        frontierRunId: "run_frontier",
        frontierSpecId: "spec_frontier",
        facts: {
          repoUrl: "https://github.com/owner/repo.git",
          baseBranch: "main",
          baseSha: "a".repeat(40),
          members: [],
          memberKey: "b".repeat(64),
          runnerImage: "runner@sha256:test",
          policyVersion: "policy.v1",
          quarantineVersion: "none",
          appEnv: {},
          installation: undefined,
          staticRef: "credential/github/org/org_eager/token",
        },
        gateInput: { target: null as never, workspacePath: "/scratch/eager" },
      }),
    ).rejects.toThrow("requires a frontier member");
  });
});
