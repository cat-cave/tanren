// The gate closures the §3 batch integration-node drive runs ON the open jj-local
// workspace (tanren-owns-the-engine.md §3b). With jj-local integration the prospective
// merged state is a LOCAL jj bookmark (no `tanren/batch` host ref), so the native gate
// must run on THAT workspace — NOT a separate fresh runner that clones a host ref. These
// closures reuse the SAME gate primitives the fresh-runner gate uses verbatim:
// `resolveGateConfig` (the gateConfigHash source + the proof-reuse key input),
// `seedWorkspaceLocalIgnore` + `ensureWorkspaceDepsInstalled` (the install the brownfield
// re-gate needs), and `runGateForWhen` over the `pre_merge` tiers (the verdict).

import type { BatchCheckVerdict } from "../contracts/batchMergeCoordinator.js";
import type { CiConfigV1 } from "../ci/index.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type { GovernancePosture } from "../config/shared.js";
import type { EventStore } from "../eventStore.js";
import type { LiveJjWorkspace } from "../providers/liveJjWorkspace.js";
import type { EventName, EventPayload } from "../events/index.js";
import {
  DEFAULT_BOOTSTRAP_COMMAND,
  ensureWorkspaceDepsInstalled,
  seedWorkspaceLocalIgnore,
} from "../workspace/index.js";
import {
  advisoryStepNamesForPosture,
  resolveBootstrapCommand,
  resolveGateConfig,
  runGateForWhen,
} from "../workflow/gate/index.js";
import type { ResolveBatchGateConfig, GateBatchWorkspace } from "./batchIntegrationNodeDrive.js";

export interface BatchNodeGateClosureDeps {
  ssh: CommandSubstrate;
  eventStore: EventStore;
  governancePosture: GovernancePosture;
  /** The integration ref the batch verdict reports (the local bookmark name). */
  integrationRef: string;
  projectId: string;
  tailSpecId: string;
  timeoutMs: number;
}

/**
 * The config-resolver closure: read the repo's CI config from the OPEN workspace (the
 * integrated head). Fail-closed — a read failure returns `undefined` (the drive forces a
 * recompute on an unresolvable gateConfigHash, never a stale reuse).
 */
export function batchNodeResolveConfig(deps: BatchNodeGateClosureDeps): ResolveBatchGateConfig {
  return async (live: LiveJjWorkspace): Promise<CiConfigV1 | undefined> => {
    try {
      return await resolveGateConfig({
        ssh: deps.ssh,
        target: live.target,
        workspacePath: live.workspacePath,
        timeoutMs: deps.timeoutMs,
      });
    } catch {
      return undefined;
    }
  };
}

/**
 * The gate closure (RECOMPUTE only): install deps on the integrated workspace, then run
 * the `pre_merge` gate tiers over it. Returns the batch verdict + whether it passed (the
 * recorded proof). A gate that cannot RUN propagates (the caller maps a throw to an
 * infra-error hold — never a false verdict).
 */
export function batchNodeGate(deps: BatchNodeGateClosureDeps): GateBatchWorkspace {
  return async (live: LiveJjWorkspace): Promise<{ verdict: BatchCheckVerdict; passed: boolean }> => {
    await seedWorkspaceLocalIgnore({
      ssh: deps.ssh,
      target: live.target,
      workspacePath: live.workspacePath,
      timeoutMs: deps.timeoutMs,
    });
    const bootstrap = await resolveBootstrapCommand({
      ssh: deps.ssh,
      target: live.target,
      workspacePath: live.workspacePath,
      timeoutMs: deps.timeoutMs,
    });
    await ensureWorkspaceDepsInstalled({
      ssh: deps.ssh,
      target: live.target,
      workspacePath: live.workspacePath,
      command: bootstrap ?? DEFAULT_BOOTSTRAP_COMMAND,
      timeoutMs: deps.timeoutMs,
    });
    const config = await resolveGateConfig({
      ssh: deps.ssh,
      target: live.target,
      workspacePath: live.workspacePath,
      timeoutMs: deps.timeoutMs,
    });
    const outcome = await runGateForWhen({
      ssh: deps.ssh,
      target: live.target,
      workspacePath: live.workspacePath,
      config,
      when: "pre_merge",
      timeoutMs: deps.timeoutMs,
      appendEvent: async <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => {
        await deps.eventStore.append({
          projectId: deps.projectId,
          specId: deps.tailSpecId,
          ...(taskId !== undefined && { taskId }),
          eventType,
          payload,
        });
      },
      advisoryStepNames: advisoryStepNamesForPosture(deps.governancePosture),
    });
    if (outcome.passed) {
      return { verdict: { result: "pass", integrationBranch: deps.integrationRef }, passed: true };
    }
    return {
      verdict: {
        result: "fail",
        message: `batch gate failed on ${deps.integrationRef}: tier ${outcome.failure.tier} step ${outcome.failure.failedStep}`,
      },
      passed: false,
    };
  };
}
