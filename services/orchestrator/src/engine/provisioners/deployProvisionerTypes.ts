import type { SecretStore } from "../contracts/secretStore.js";
import type { DeployHttpTransport } from "./deployTransport.js";
import type { FlyImageBuilder } from "./flyImageBuilder.js";

/** Dependencies shared by every direct-provider deploy provisioner. */
export interface DeployProvisionerDeps {
  transport: DeployHttpTransport;
  secrets: SecretStore;
  /** Explicit escape hatch when Fly has no merge-reflecting image builder. */
  allowFlyStaticDeploy?: boolean;
  flyImageBuilder?: FlyImageBuilder;
}

/** One runtime variable whose value flows only into the provider request. */
export interface DeployEnvVar {
  key: string;
  value: string;
}

/** Exact repository revision used to build a deployment. */
export interface DeploySource {
  repo: string;
  ref: string;
}

/** Non-secret result returned when the provider starts a deployment. */
export interface DeployResult {
  deploymentId: string;
  url: string;
  state: string;
}

/** Provider-reported, unbranded artifact identity; the adapter validates it. */
export interface DeployArtifactIdentity {
  artifactDigest: string;
  providerChecksum: string | null;
}

/** One build and its identity, acquired under the same deploy-stage authority. */
export interface DeployArtifactBuild {
  result: DeployResult;
  identity: DeployArtifactIdentity;
}
