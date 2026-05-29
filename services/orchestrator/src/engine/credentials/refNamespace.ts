// SaaS Tier-A #3: tenant-namespaced Vault refs.
//
// Historically the credential `ref` was fully caller-supplied and the per-kind
// validators only enforced the `credential/<kind>/` prefix. That let an org
// admin write to an arbitrary ref under the namespace — including one that
// belongs to a different tenant (cross-tenant key collision / overwrite).
//
// The import route now DERIVES the Vault ref server-side from the authenticated
// actor's `{kind, scope, ownerId}` plus a caller-supplied `name`, so the Vault
// key is anchored to the tenant the route already authorized. Refs are shaped:
//
//   credential/<slug>/<scope>/<ownerId>/<name>
//
// where `<scope>` is `org` (the owner is an org id) or `me` (the owner is a
// user id). This mirrors the `CredentialRecord` the registry already stamps —
// derivation just aligns the Vault key with that owner.
//
// `enforceRefOwnership` is the read-side guard: when a caller supplies a full
// ref (back-compat), it must resolve to the SAME scope/owner the route
// authorized; a ref whose scope/owner segment names a different tenant is
// rejected. Legacy short refs (`credential/<slug>/<name>`, no scope segment)
// are NOT accepted by the namespaced import route — those only ever flowed in
// through the unauthenticated legacy `/credentials/<slug>/import` endpoints and
// keep resolving unchanged because resolution still uses the prefix-only
// validators. New imports through the org/me routes always get a derived ref.

/** The credential kinds the namespaced import route can derive a ref for. */
export type NamespacedCredentialKind =
  | "codex_chatgpt_auth"
  | "claude_cli_auth"
  | "opencode_cli_auth"
  | "github_token"
  | "github_app"
  | "opaque";

export type CredentialScope = "org" | "me";

/** The Vault path slug used for each kind. Stable; do not renumber. */
const KIND_SLUG: Record<NamespacedCredentialKind, string> = {
  codex_chatgpt_auth: "codex",
  claude_cli_auth: "claude",
  opencode_cli_auth: "opencode",
  github_token: "github",
  github_app: "github_app",
  opaque: "opaque",
};

export interface DeriveRefInput {
  kind: NamespacedCredentialKind;
  scope: CredentialScope;
  ownerId: string;
  /** The trailing, human-chosen segment (e.g. "default", "prod-bot"). */
  name: string;
}

/** A single Vault ref path segment: letters/digits plus `._-`, never empty. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Build the tenant-namespaced Vault ref for a credential the route has already
 * authorized. The `name` is the only caller-influenced part and is validated to
 * a single safe path segment so it cannot smuggle extra `/` segments (which
 * would let a caller climb out of their tenant prefix).
 */
export function deriveCredentialRef(input: DeriveRefInput): string {
  const slug = KIND_SLUG[input.kind];
  if (!SEGMENT.test(input.ownerId)) {
    throw new Error("credential owner id is not a safe ref segment");
  }
  const name = input.name.trim();
  if (!SEGMENT.test(name)) {
    throw new Error("credential name must be a single safe path segment");
  }
  return `credential/${slug}/${input.scope}/${input.ownerId}/${name}`;
}

/**
 * Resolve the trailing `name` segment the caller intends. Accepts either a bare
 * name (`"default"`) or a full ref the caller supplied for back-compat
 * (`"credential/<slug>/<scope>/<ownerId>/<name>"`); in the full-ref case the
 * scope/owner MUST match the authorized actor or this throws. Returns the name
 * to feed into {@link deriveCredentialRef}.
 */
export function resolveCredentialName(args: {
  supplied: string;
  kind: NamespacedCredentialKind;
  scope: CredentialScope;
  ownerId: string;
}): string {
  const supplied = args.supplied.trim();
  if (supplied === "") {
    throw new Error("credential name must not be empty");
  }
  if (!supplied.includes("/")) {
    return supplied;
  }
  // A full ref was supplied: it must name this exact tenant namespace.
  const expectedPrefix = `credential/${KIND_SLUG[args.kind]}/${args.scope}/${args.ownerId}/`;
  if (!supplied.startsWith(expectedPrefix)) {
    throw new Error("credential ref does not belong to the authenticated owner");
  }
  const name = supplied.slice(expectedPrefix.length);
  if (name === "" || name.includes("/")) {
    throw new Error("credential ref must end in a single name segment");
  }
  return name;
}

/**
 * The single Tier-A #3 enforcement entrypoint the import route calls: resolve
 * the caller's `supplied` ref to a tenant-safe name and derive the Vault ref
 * under the authorized `{kind, scope, ownerId}`. Throws (caught by the route as
 * a 400) when the caller's ref names a different tenant or is malformed.
 */
export function deriveImportRef(args: {
  supplied: string;
  kind: NamespacedCredentialKind;
  scope: CredentialScope;
  ownerId: string;
}): string {
  const name = resolveCredentialName(args);
  return deriveCredentialRef({ kind: args.kind, scope: args.scope, ownerId: args.ownerId, name });
}
