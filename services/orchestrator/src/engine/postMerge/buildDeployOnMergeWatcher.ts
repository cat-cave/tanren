import type pg from "pg";
import type { RunStateWriter } from "../contracts/runStateWriter.js";
import type { SecretStore } from "../contracts/secretStore.js";
import { fetchDeployTransport } from "../provisioners/deployTransport.js";
import type { FlyImageBuilder } from "../provisioners/flyImageBuilder.js";
import { PgReleaseInstancesRepository, type ReleaseInstancesRepository } from "../repositories/index.js";
import { DeployOnMergeWatcher } from "./deployOnMergeShared.js";

export function buildDeployOnMergeWatcher(deps: {
  pool: pg.Pool;
  secrets: SecretStore;
  runStateWriter?: RunStateWriter;
  flyImageBuilder?: FlyImageBuilder;
  releaseInstances?: ReleaseInstancesRepository;
}): DeployOnMergeWatcher {
  return new DeployOnMergeWatcher({
    pool: deps.pool,
    secrets: deps.secrets,
    transport: fetchDeployTransport(),
    ...(deps.runStateWriter !== undefined && { runStateWriter: deps.runStateWriter }),
    ...(deps.flyImageBuilder !== undefined && { flyImageBuilder: deps.flyImageBuilder }),
    releaseInstances: deps.releaseInstances ?? new PgReleaseInstancesRepository(deps.pool),
  });
}
