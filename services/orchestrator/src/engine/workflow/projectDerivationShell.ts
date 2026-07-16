import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import type { ActorContext } from "../../auth/schemas.js";
import {
  buildDerivationOwnership,
  ProjectDerivationConflictError,
  ProjectDerivationStore,
  ProjectStore,
  type DerivationKind,
  type ProjectDerivationRow,
  type ProjectRow,
} from "../repositories/projects.js";
import { createProjectOnClient, type CreateProjectInput, type ProjectContract } from "./projectCreate.js";
import type { ProjectConfigWriteProof } from "./projectConfigWriteGuards.js";

export interface DerivationRepositoryBinding {
  mode: "managed" | "explicit";
  fullName: string;
  repoUrl: string;
  requestedDefaultBranch: string;
  ownershipMarker: string;
}

export interface DerivationShellIdentity {
  kind: DerivationKind;
  orgId: string;
  projectName: string;
  repoUrl: string;
  idempotencyFingerprint: string;
}

export async function loadExactDerivationShell(
  pool: pg.Pool,
  identity: DerivationShellIdentity,
): Promise<{ project: ProjectRow; operation: ProjectDerivationRow } | undefined> {
  return runWithOrgScope(pool, identity.orgId, async (client) => {
    const operation = await ProjectDerivationStore.findByFingerprint(
      pool,
      identity.orgId,
      identity.idempotencyFingerprint,
    );
    const projects = await ProjectStore.listByRepoUrl(client, identity.orgId, identity.repoUrl, { kind: "operator" });
    if (operation === undefined) {
      if (projects.length > 0) {
        throw new ProjectDerivationConflictError(projects[0]!.projectId, "binding_mismatch");
      }
      return operation;
    }
    if (projects.length !== 1 || projects[0]?.projectId !== operation.projectId) {
      throw new ProjectDerivationConflictError(operation.projectId, "binding_mismatch");
    }
    const project = projects[0];
    if (project.name !== identity.projectName || project.lifecycle === "archived") {
      throw new ProjectDerivationConflictError(operation.projectId, "binding_mismatch");
    }
    const decoded = ProjectDerivationStore.decode(operation, {
      kind: identity.kind,
      orgId: identity.orgId,
      projectId: project.projectId,
      repoUrl: identity.repoUrl,
      idempotencyFingerprint: identity.idempotencyFingerprint,
    });
    if (project.defaultBranch !== decoded.ownership.repository.requestedDefaultBranch) {
      throw new ProjectDerivationConflictError(operation.projectId, "binding_mismatch");
    }
    return { project, operation };
  });
}

export async function createDerivationShell(
  pool: pg.Pool,
  input: {
    identity: DerivationShellIdentity;
    actor: ActorContext;
    project: CreateProjectInput;
    configWriteProof: ProjectConfigWriteProof;
    repository: DerivationRepositoryBinding;
    sanitizedInput: Record<string, unknown>;
  },
): Promise<{ project: ProjectContract; operation: ProjectDerivationRow }> {
  return runWithOrgScope(pool, input.identity.orgId, async (client) => {
    const project = await createProjectOnClient(client, input.project, input.actor, {
      configWriteProof: input.configWriteProof,
      initialLifecycle: "deriving",
    });
    const ownershipReceipt = buildDerivationOwnership({
      kind: input.repository.mode,
      orgId: input.identity.orgId,
      projectId: project.projectId,
      repoUrl: input.repository.repoUrl,
      idempotencyFingerprint: input.identity.idempotencyFingerprint,
      ownershipMarker: input.repository.ownershipMarker,
      fullName: input.repository.fullName,
      requestedDefaultBranch: input.repository.requestedDefaultBranch,
    });
    const operation = await ProjectDerivationStore.beginOnClient(client, {
      orgId: input.identity.orgId,
      projectId: project.projectId,
      idempotencyFingerprint: input.identity.idempotencyFingerprint,
      sanitizedInput: input.sanitizedInput,
      ownershipReceipt,
    });
    return { project, operation };
  });
}
