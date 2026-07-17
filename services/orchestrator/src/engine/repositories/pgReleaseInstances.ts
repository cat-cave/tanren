import { runWithOrgScope } from "@tanren/db";
import type pg from "pg";
import {
  ReleaseInstancesStore,
  type CreateReleaseInstanceInput,
  type GetReleaseInstanceByDeploymentInput,
  type MarkLiveReleaseInput,
  type PromoteReleaseInput,
  type ReleaseInstancesRepository,
  type RollbackReleaseInput,
  type SupersedePriorLiveInput,
  type TeardownPreviewInput,
  type TransitionReleaseInstanceInput,
} from "./releaseInstances.js";

export class PgReleaseInstancesRepository implements ReleaseInstancesRepository {
  constructor(private readonly pool: pg.Pool) {}
  create(input: CreateReleaseInstanceInput) {
    return runWithOrgScope(this.pool, input.orgId, (client) => ReleaseInstancesStore.create(client, input));
  }
  getById(orgId: string, releaseInstanceId: string) {
    return runWithOrgScope(this.pool, orgId, (client) =>
      ReleaseInstancesStore.getById(client, orgId, releaseInstanceId),
    );
  }
  getByDeployment(input: GetReleaseInstanceByDeploymentInput) {
    return runWithOrgScope(this.pool, input.orgId, (client) => ReleaseInstancesStore.getByDeployment(client, input));
  }
  listForProject(orgId: string, projectId: string) {
    return runWithOrgScope(this.pool, orgId, (client) =>
      ReleaseInstancesStore.listForProject(client, orgId, projectId),
    );
  }
  transition(input: TransitionReleaseInstanceInput) {
    return runWithOrgScope(this.pool, input.orgId, (client) => ReleaseInstancesStore.transition(client, input));
  }
  supersedePriorLive(input: SupersedePriorLiveInput) {
    return runWithOrgScope(this.pool, input.orgId, (client) => ReleaseInstancesStore.supersedePriorLive(client, input));
  }
  applyPreview(input: CreateReleaseInstanceInput) {
    return runWithOrgScope(this.pool, input.orgId, (client) => ReleaseInstancesStore.applyPreview(client, input));
  }
  promote(input: PromoteReleaseInput) {
    return runWithOrgScope(this.pool, input.orgId, (client) => ReleaseInstancesStore.promote(client, input));
  }
  rollback(input: RollbackReleaseInput) {
    return runWithOrgScope(this.pool, input.orgId, (client) => ReleaseInstancesStore.rollback(client, input));
  }
  teardownPreview(input: TeardownPreviewInput) {
    return runWithOrgScope(this.pool, input.orgId, (client) => ReleaseInstancesStore.teardownPreview(client, input));
  }
  markLive(input: MarkLiveReleaseInput) {
    return runWithOrgScope(this.pool, input.orgId, (client) => ReleaseInstancesStore.markLive(client, input));
  }
}
