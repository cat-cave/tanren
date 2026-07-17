// The live-workspace adapter for the ONE WorkspaceVcsCore integration operation.
// It owns runner allocation/release; the jj core owns cloning, real PR-head assembly,
// conflict recording, clean export, and exact base/head/tree identities.

import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import type {
  WorkspaceHandle,
  WorkspaceIntegrationAssembly,
  WorkspaceIntegrationMember,
} from "../contracts/workspaceVcsCore.js";
import { buildLiveJjWorkspace, type LiveJjWorkspace, type LiveJjWorkspaceDeps } from "../providers/liveJjWorkspace.js";

export { AncestorNotReadyError } from "../contracts/workspaceVcsCore.js";
export type { AncestorSpecPhase } from "../contracts/workspaceVcsCore.js";

/** Backward-compatible name for an ordered real PR-head input to the core. */
export type JjIntegrationMember = WorkspaceIntegrationMember;

/** The jj-local caller's input; the core receives the live workspace path separately. */
export interface JjLocalIntegrationInput {
  baseBranch: string;
  repoUrl: string;
  members: ReadonlyArray<JjIntegrationMember>;
  localRef: string;
}

/** The result retains an optional handle so existing injected test ports stay lightweight. */
export type JjLocalIntegrationResult =
  | (Omit<Extract<WorkspaceIntegrationAssembly, { outcome: "integrated" }>, "workspace"> & {
      workspace?: WorkspaceHandle;
    })
  | Extract<WorkspaceIntegrationAssembly, { outcome: "conflict" }>;

/** Provision one runner, run a continuation against its clean local integration, then release it. */
export async function withJjLocalIntegration<T>(
  workspaceDeps: LiveJjWorkspaceDeps,
  input: JjLocalIntegrationInput,
  onIntegrated: (
    live: LiveJjWorkspace,
    integrated: Extract<JjLocalIntegrationResult, { outcome: "integrated" }>,
  ) => Promise<T>,
): Promise<{ outcome: "integrated"; value: T } | Extract<JjLocalIntegrationResult, { outcome: "conflict" }>> {
  const live = await buildLiveJjWorkspace(workspaceDeps);
  try {
    const integration = await integrateOverWorkspace(live, workspaceDeps.ssh, input);
    if (integration.outcome === "conflict") return integration;
    return { outcome: "integrated", value: await onIntegrated(live, integration) };
  } finally {
    await live.release();
  }
}

/**
 * Assemble over an already allocated runner. The legacy SSH argument remains at the
 * adapter boundary for compatibility; the core carries the same bound substrate.
 */
export async function integrateOverWorkspace(
  live: LiveJjWorkspace,
  _ssh: CommandSubstrate,
  input: JjLocalIntegrationInput,
): Promise<JjLocalIntegrationResult> {
  return live.core.assembleIntegration({ ...input, path: live.workspacePath });
}
