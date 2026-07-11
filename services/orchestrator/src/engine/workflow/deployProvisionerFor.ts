// Shared selector: construct the typed deploy provisioner for a deployRef provider
// kind. Returns the concrete {@link DeployProvisioner} (not the bare port) so the
// caller can use `attachRuntimeEnv` / `deploy`. An unknown provider kind fails LOUD
// — a deployRef pointing at a provider with no deploy provisioner is a
// misconfiguration, never a silent skip. Used by both the runtime-env attach flow
// and the deploy-on-merge trigger.
//
// UNIFIED REGISTRY (Codex H3 #25): this file NO LONGER carries a hardcoded switch.
// Selection delegates to the shared {@link buildDeployProvisioner} which reads from
// the SAME `PROVISIONER_REGISTRY` that `buildIntegrationProvisioner` uses, so a new
// deploy provider registered THERE is immediately visible HERE (the two seams
// cannot silently diverge — the pre-fix state where `deployProvisionerFor` only
// knew Vercel + Fly while `buildIntegrationProvisioner` also handled Sentry/Slack
// is now structurally impossible).

import type { DeployProvisioner, DeployProvisionerDeps } from "../provisioners/deployProvisioner.js";
import { buildDeployProvisioner } from "../contracts/integrationProvisioner.js";

export function deployProvisionerFor(providerKind: string, deps: DeployProvisionerDeps): DeployProvisioner {
  return buildDeployProvisioner(providerKind, {
    transport: deps.transport,
    secrets: deps.secrets,
    // Fly-only opt-ins flow through — the pre-fix path passed the whole `deps` to
    // `new FlyDeployProvisioner(deps)` directly; the unified registry propagates
    // the same fields so the Fly static-image opt-in + the merge-reflecting image
    // builder still reach the provisioner. Spread only when set (matching the
    // `IntegrationProvisionerDeps` optional-field convention).
    ...(deps.allowFlyStaticDeploy === undefined ? {} : { allowFlyStaticDeploy: deps.allowFlyStaticDeploy }),
    ...(deps.flyImageBuilder === undefined ? {} : { flyImageBuilder: deps.flyImageBuilder }),
  });
}
