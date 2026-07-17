import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import {
  RepositoryVisibilityEnforcer,
  type RepositoryVisibilityDecision,
  type ReviewerAppIdentity,
} from "./repoVisibility.js";
import { RepositoryVisibilityObservationsStore } from "../repositories/repositoryVisibilityObservations.js";

/** The run-start admission check for a project's declared repository visibility. */
export interface RepositoryVisibilityAdmission {
  admit(input: { orgId: string; projectId: string }): Promise<void>;
}

/** A fresh Reviewer-App observation disagreed with the project's governance declaration. */
export class RepositoryVisibilityAdmissionBlockedError extends Error {
  override readonly name = "RepositoryVisibilityAdmissionBlockedError";

  constructor(input: {
    orgId: string;
    projectId: string;
    decision: Extract<RepositoryVisibilityDecision, { status: "blocked" }>;
  }) {
    const { observation, expectedVisibility } = input.decision;
    super(
      `repository visibility admission blocked for ${input.orgId}/${input.projectId}: ` +
        `declared ${expectedVisibility}, observed ${observation.observedVisibility}`,
    );
  }
}

/**
 * Enforces only an explicitly declared project visibility at run admission. Legacy
 * projects without `projects.repo_visibility` remain outside this predicate; once a
 * declaration exists, the underlying enforcer performs a fresh immutable readback.
 */
export class RepositoryVisibilityRunAdmission implements RepositoryVisibilityAdmission {
  private readonly enforcer: RepositoryVisibilityEnforcer;

  constructor(
    private readonly pool: pg.Pool,
    reviewerApp: ReviewerAppIdentity,
  ) {
    this.enforcer = new RepositoryVisibilityEnforcer(pool, reviewerApp);
  }

  async admit(input: { orgId: string; projectId: string }): Promise<void> {
    const project = await runWithOrgScope(this.pool, input.orgId, (client) =>
      RepositoryVisibilityObservationsStore.getProject(client, input.orgId, input.projectId),
    );
    if (project?.declaredVisibility === null) return;

    const decision = await this.enforcer.observe(input);
    if (decision.status === "blocked") {
      throw new RepositoryVisibilityAdmissionBlockedError({ ...input, decision });
    }
  }
}
