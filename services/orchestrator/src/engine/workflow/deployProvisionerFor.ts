// Shared selector: construct the typed deploy provisioner for a deployRef provider
// kind. Returns the concrete {@link DeployProvisioner} (not the bare port) so the
// caller can use `attachRuntimeEnv` / `deploy`. An unknown provider kind fails LOUD
// — a deployRef pointing at a provider with no deploy provisioner is a
// misconfiguration, never a silent skip. Used by both the runtime-env attach flow
// (P-APP-ENV-2) and the deploy-on-merge trigger.

import type { DeployProvisioner, DeployProvisionerDeps } from "../provisioners/deployProvisioner.js";
import { VercelDeployProvisioner, VERCEL_PROVIDER_KIND } from "../provisioners/vercelDeployProvisioner.js";
import { FlyDeployProvisioner, FLY_PROVIDER_KIND } from "../provisioners/flyDeployProvisioner.js";

export function deployProvisionerFor(providerKind: string, deps: DeployProvisionerDeps): DeployProvisioner {
  switch (providerKind) {
    case VERCEL_PROVIDER_KIND:
      return new VercelDeployProvisioner(deps);
    case FLY_PROVIDER_KIND:
      return new FlyDeployProvisioner(deps);
    default:
      throw new Error(
        `deployProvisionerFor: deployRef provider '${providerKind}' has no deploy provisioner ` +
          `(expected '${VERCEL_PROVIDER_KIND}' or '${FLY_PROVIDER_KIND}')`,
      );
  }
}
