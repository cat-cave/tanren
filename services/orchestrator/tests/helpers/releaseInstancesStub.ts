import type { ReleaseInstanceRecord } from "../../src/engine/contracts/deployAdapter.js";
import type { ReleaseInstancesRepository } from "../../src/engine/repositories/releaseInstances.js";

const record = {} as ReleaseInstanceRecord;
const noRelease = async (): Promise<ReleaseInstanceRecord | undefined> => {};

/** Explicit lifecycle fixture for adapter conformance tests that do not assert row contents. */
export function releaseInstancesStub(): ReleaseInstancesRepository {
  return {
    create: async () => record,
    getById: noRelease,
    getByDeployment: noRelease,
    listForProject: async () => [],
    transition: async () => record,
    supersedePriorLive: noRelease,
    applyPreview: async () => record,
    promote: async () => record,
    rollback: async () => record,
    teardownPreview: noRelease,
    markLive: async () => record,
  };
}
