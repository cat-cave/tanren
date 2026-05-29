# Self-hosting Tanren with Authentik (turnkey OIDC preset)

Tanren ships a generic, standards-compliant OIDC provider (P3-0030) plus an
**Authentik preset** that makes a self-hosted [Authentik](https://goauthentik.io/)
homelab zero-fiddle: set one extra env var and supply issuer + client id/secret,
and Tanren maps Authentik's standard claims (login, email, display name, and
**group membership** -> Tanren orgs) automatically.

This guide is the homelab fast path. For the env reference and the cloudflared /
TLS posture, see [deploy.md](deploy.md). For the auth model itself, see
[auth.md](auth.md).

## What the preset does

`TANREN_OIDC_PRESET=authentik` selects Authentik-correct claim-mapping defaults
so you do **not** have to set the per-claim envs:

| Setting | Preset default | Maps to |
| --- | --- | --- |
| scopes | `openid profile email groups` | userinfo includes the `groups` claim |
| `TANREN_OIDC_SUBJECT_CLAIM` | `sub` | stable Tanren subject |
| `TANREN_OIDC_LOGIN_CLAIM` | `preferred_username` | Tanren login / username |
| `TANREN_OIDC_NAME_CLAIM` | `name` | human display name |
| `TANREN_OIDC_GROUPS_CLAIM` | `groups` | org/group membership (array of strings) -> Tanren orgs, `kind: oidc` |

Every value stays overridable: an explicit `TANREN_OIDC_*` env always wins, the
preset only fills the gaps you leave unset. The generic OIDC provider is
untouched — with no preset selected, behavior is byte-for-byte unchanged.

The preset registers exactly like the generic provider: the `oidc` provider is
added **only** when all three of `TANREN_OIDC_ISSUER`, `TANREN_OIDC_CLIENT_ID`,
and `TANREN_OIDC_CLIENT_SECRET` are set. No DB migration is needed — `oidc` is
already an enumerated provider value.

## 1. Register the Tanren app in Authentik

In the Authentik admin UI, create an **OAuth2/OpenID Provider** and an
**Application** bound to it:

1. **Provider type:** OAuth2/OpenID Provider.
2. **Client type:** Confidential. Authentik generates a **Client ID** and
   **Client Secret** — copy these into `TANREN_OIDC_CLIENT_ID` /
   `TANREN_OIDC_CLIENT_SECRET`.
3. **Redirect URI:** add an exact-match entry:
   `<TANREN_PUBLIC_BASE_URL>/auth/callback?provider=oidc`
   (e.g. `https://tanren.home.lan/auth/callback?provider=oidc`). The
   `?provider=oidc` query string is part of the match.
4. **Scopes:** assign the built-in `openid`, `profile`, and `email` scope
   mappings, **plus a `groups` scope mapping** so the userinfo response carries
   the `groups` claim. Authentik ships a "groups" scope mapping
   (`return [group.name for group in request.user.ak_groups.all()]`); if your
   instance does not, create a scope mapping named `groups` with that
   expression and assign it to the provider. Tanren maps each group name to a
   Tanren org (lowercased login, `kind: oidc`).
5. **Issuer:** Authentik's issuer is the provider's base, e.g.
   `https://authentik.home.lan/application/o/<app-slug>/`. Discovery is served at
   `<issuer>/.well-known/openid-configuration`. Use this as `TANREN_OIDC_ISSUER`.

## 2. Set the env vars

Add to the orchestrator's environment (e.g. your `.env` for compose):

```sh
# Turnkey Authentik preset — fills login/email/name/groups claim mapping + scopes.
TANREN_OIDC_PRESET=authentik
TANREN_OIDC_ISSUER=https://authentik.home.lan/application/o/tanren/
TANREN_OIDC_CLIENT_ID=<client id from Authentik>
TANREN_OIDC_CLIENT_SECRET=<client secret from Authentik>

# The externally reachable https:// URL Tanren is served at. Must match the
# redirect URI host registered above and is used for cookie scoping.
TANREN_PUBLIC_BASE_URL=https://tanren.home.lan
```

You do **not** need to set `TANREN_OIDC_SCOPES` or any `TANREN_OIDC_*_CLAIM`
var — the preset supplies Authentik-correct values. Override one only if your
Authentik deviates from the standard shape.

Restart the orchestrator. `GET /auth/providers` then lists `oidc` alongside
`github_oauth`, and the sign-in page offers Authentik.

## 3. Homelab compose snippet

If Authentik and Tanren run on the same Docker host, put them on a shared
network so the orchestrator resolves Authentik by service name. The
`TANREN_OIDC_ISSUER` must still be the URL **users' browsers** can reach (for the
authorize redirect), so for a LAN deployment use your LAN hostname, not the
internal service name. The example below joins an external `authentik` network so
server-to-server discovery/token/userinfo calls stay on the docker bridge:

```yaml
# Excerpt — merge into compose.prod.yml's orchestrator service.
services:
  orchestrator:
    environment:
      TANREN_OIDC_PRESET: ${TANREN_OIDC_PRESET:-}
      TANREN_OIDC_ISSUER: ${TANREN_OIDC_ISSUER:-}
      TANREN_OIDC_CLIENT_ID: ${TANREN_OIDC_CLIENT_ID:-}
      TANREN_OIDC_CLIENT_SECRET: ${TANREN_OIDC_CLIENT_SECRET:-}
    networks:
      - default
      - authentik   # the external network Authentik publishes on

networks:
  authentik:
    external: true
    name: authentik_default   # match `docker network ls` for your Authentik stack
```

For a pure LAN deployment (no shared docker network), set
`TANREN_OIDC_ISSUER=https://authentik.home.lan/application/o/tanren/` and ensure
the orchestrator container can reach that host (LAN DNS or an `extra_hosts`
entry). Either way, point `TANREN_PUBLIC_BASE_URL` at the https URL your browser
uses so the redirect URI and `Secure` cookies line up.

## Troubleshooting

- **`oidc` not listed in `/auth/providers`** — one of issuer / client id /
  client secret is unset or empty. All three are required to register.
- **Redirect mismatch from Authentik** — the registered redirect URI must be an
  exact match including `?provider=oidc` and the `TANREN_PUBLIC_BASE_URL` host.
- **No orgs / groups missing** — the `groups` scope mapping is not assigned to
  the provider, so userinfo omits `groups`. Assign it, then re-authenticate.
- **Non-standard claim names** — override the specific
  `TANREN_OIDC_*_CLAIM` env; it wins over the preset default.
