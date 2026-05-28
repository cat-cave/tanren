import { LocalDevProvider } from "./localDevProvider.js";
import type { IdentityClaims } from "./schemas.js";

/**
 * DEV-ONLY sign-in escape hatch.
 *
 * Synthetic identity minted by `TANREN_DEV_LOGIN=1`. The first
 * `/auth/login?provider=local_dev` handshake runs the SAME P2A-0003 upsert path
 * as github_oauth, creating the `tanren-dev` org (admin) + dev operator user —
 * there is no parallel auth bypass.
 *
 * The org `externalId` is a stable synthetic value. Repo linking is by URL + a
 * stored GitHub credential, independent of this tenant org's GitHub identity, so
 * the synthetic id never needs to match a real GitHub org.
 *
 * This flag must be opt-in and is never set in compose.prod.yml.
 */
export const DEV_LOGIN_IDENTITY: IdentityClaims = {
  providerSubject: "tanren-dev-operator",
  login: "tanren-dev",
  email: "dev@tanren.local",
  displayName: "Tanren Dev Operator",
  orgs: [
    {
      externalId: "tanren-dev-org",
      login: "tanren-dev",
      displayName: "Tanren Dev",
      kind: "github_org"
    }
  ]
};

/** Construct the dev-login identity provider with the synthetic dev identity. */
export function createDevLoginProvider(): LocalDevProvider {
  return new LocalDevProvider({ identity: DEV_LOGIN_IDENTITY });
}
