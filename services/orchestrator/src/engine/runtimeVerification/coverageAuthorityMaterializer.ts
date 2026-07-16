import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { RunnerHandle } from "../contracts/allocator.js";
import type { CommandSubstrate } from "../contracts/commandSubstrate.js";
import { memberKey } from "../contracts/integrationNodes.js";
import type { IntegrationNodeUpsert } from "../dag/integrationNodesPg.js";
import { upsertIntegrationNodeOnClient } from "../dag/integrationNodesPg.js";
import { BehaviorCoverageEdgesStore } from "../repositories/behaviorCoverageEdges.js";
import { buildActivityWatchdog } from "../ssh/activityWatchdog.js";
import { quoteSshShellArg } from "../ssh/command.js";
import { runWorkspaceSshCommand } from "../workspace/ssh.js";
import { type AffectedTarget, buildCoverageAuthorityFingerprint, fixedCodeUnitCompare } from "./affectedSelection.js";

const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MAX_SOURCE_TARGET_LENGTH = 4_096;

/** The still-open workspace that owns the exact prepared integration head. */
export interface CoverageAuthorityWorkspace {
  readonly ssh: CommandSubstrate;
  readonly target: RunnerHandle;
  readonly workspacePath: string;
}

/**
 * A ready node without caller-supplied authority fields. The materializer alone derives
 * changed targets, reads the canonical graph, stamps `affected_fingerprint`, and flips ready.
 */
export type CoverageAuthorityReadyNodeInput = Omit<
  IntegrationNodeUpsert,
  "affectedFingerprint" | "headSha" | "status" | "treeHash"
> & {
  readonly headSha: string;
  readonly treeHash: string;
  readonly workspace: CoverageAuthorityWorkspace;
};

export type CoverageAuthorityReadyNodeMaterializer = (input: CoverageAuthorityReadyNodeInput) => Promise<string>;

export class CoverageAuthorityMaterializationError extends Error {
  public override readonly name = "CoverageAuthorityMaterializationError";
}

function requireGitSha(value: string, label: string): void {
  if (!GIT_SHA_PATTERN.test(value)) {
    throw new CoverageAuthorityMaterializationError(`${label} must be an exact 40-hex git object id`);
  }
}

function requireSourcePath(path: string): void {
  const components = path.split("/");
  if (
    path === "" ||
    path.length > MAX_SOURCE_TARGET_LENGTH ||
    path.startsWith("/") ||
    components.some((component) => component === "" || component === "." || component === "..")
  ) {
    throw new CoverageAuthorityMaterializationError(`invalid repository-relative changed source path: ${path}`);
  }
}

/**
 * Derive the authoritative product targets from the exact immutable base→head diff in the
 * same live workspace that prepared the node. No HTTP/client target list enters this path.
 * `--no-renames` deliberately represents a rename as old-path deletion + new-path addition,
 * so neither side's coverage can be omitted. NUL framing preserves every valid path byte that
 * can be represented by the command substrate.
 */
export async function deriveChangedSourceTargets(
  workspace: CoverageAuthorityWorkspace,
  baseSha: string,
  headSha: string,
): Promise<readonly AffectedTarget[]> {
  requireGitSha(baseSha, "coverage authority baseSha");
  requireGitSha(headSha, "coverage authority headSha");
  const result = await runWorkspaceSshCommand(workspace.ssh, workspace.target, {
    label: "coverage authority: derive exact base-to-head source targets",
    cwd: workspace.workspacePath,
    watchdog: buildActivityWatchdog({
      substrate: workspace.ssh,
      target: workspace.target,
      cls: "vcs",
      workspace: workspace.workspacePath,
    }),
    command: `git diff --no-renames --name-only -z ${quoteSshShellArg(baseSha)} ${quoteSshShellArg(headSha)} --`,
  });
  if (result.stdout !== "" && !result.stdout.endsWith("\0")) {
    throw new CoverageAuthorityMaterializationError("git diff target stream was not NUL-terminated");
  }
  const byRef = new Map<string, AffectedTarget>();
  for (const path of result.stdout.split("\0")) {
    if (path === "") continue;
    requireSourcePath(path);
    byRef.set(path, { kind: "source", targetRef: path });
  }
  return [...byRef.values()].sort((left, right) => fixedCodeUnitCompare(left.targetRef, right.targetRef));
}

/** Build the sole Pg-backed ready-node authority producer. */
export function buildCoverageAuthorityReadyNodeMaterializer(pool: pg.Pool): CoverageAuthorityReadyNodeMaterializer {
  return async (input) => {
    requireGitSha(input.baseSha, "coverage authority baseSha");
    requireGitSha(input.headSha, "coverage authority headSha");
    requireGitSha(input.treeHash, "coverage authority treeHash");
    for (const member of input.members) requireGitSha(member.headSha, `coverage authority member ${member.specId}`);

    const changedTargets = await deriveChangedSourceTargets(input.workspace, input.baseSha, input.headSha);
    const { workspace: _workspace, ...node } = input;
    return runWithOrgScope(pool, input.orgId, async (client) => {
      // The intermediate building state and final ready stamp are one transaction, so a
      // graph/read/fingerprint failure rolls back to the previous row instead of exposing a
      // ready node with empty authority. We deliberately take no upgrade-prone table lock:
      // a concurrent graph commit can only make this immutable seal stale, and the selector's
      // exact generation comparison then expands safely instead of authorizing an omission.
      const nodeId = await upsertIntegrationNodeOnClient(client, {
        ...node,
        affectedFingerprint: "",
        status: "building",
      });
      const snapshot = await BehaviorCoverageEdgesStore.readSnapshot(client, {
        orgId: input.orgId,
        projectId: input.projectId,
      });
      const affectedFingerprint = buildCoverageAuthorityFingerprint({
        binding: {
          integrationNodeId: nodeId,
          baseSha: input.baseSha,
          preparedHeadSha: input.headSha,
          treeHash: input.treeHash,
          memberKey: memberKey(
            input.baseSha,
            input.members.map((member) => member.headSha),
          ),
        },
        snapshot,
        changedTargets,
      });
      const readyNodeId = await upsertIntegrationNodeOnClient(client, {
        ...node,
        affectedFingerprint,
        status: "ready",
      });
      if (readyNodeId !== nodeId) {
        throw new CoverageAuthorityMaterializationError(
          "repeat ready materialization changed integration-node identity",
        );
      }
      return nodeId;
    });
  };
}
