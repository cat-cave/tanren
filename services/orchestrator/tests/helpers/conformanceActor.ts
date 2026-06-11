// The well-known Tanren bot actor identity the credential/identity tests pin against
// (the static-credential `GET /user` read returns this login + id, so the resolved
// noreply email is deterministic). Lifted out of the retired `vcsProviderConformance`
// suite (decomposition PR-9) so the surviving identity tests keep a single source.
export const CONFORMANCE_ACTOR_LOGIN = "tanren-bot-user";
export const CONFORMANCE_ACTOR_ID = "424242";
export const CONFORMANCE_ACTOR_NOREPLY_EMAIL = "424242+tanren-bot-user@users.noreply.github.com";
