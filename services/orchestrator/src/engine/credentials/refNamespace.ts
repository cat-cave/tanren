// SaaS Tier-A #3: tenant-namespaced Vault refs.
//
// The Vault `ref` is ALWAYS derived server-side from the authenticated actor's
// `{kind, scope, ownerId}` plus a caller-supplied `name`, so the Vault key is
// anchored to the tenant the route already authorized. Refs are shaped:
//
//   credential/<slug>/<scope>/<ownerId>/<name>
//
// where `<scope>` is `org` (the owner is an org id) or `me` (the owner is a
// user id). This mirrors the `CredentialRecord` the registry already stamps —
// derivation just aligns the Vault key with that owner.
//
// There is NO bare-ref backwards-compat path: a caller never gets to pick the
// ref. When the caller supplies a full ref (a value containing `/`), the server
// still derives the canonical ref from `{kind, scope, ownerId, <trailing name>}`
// and accepts the supplied ref ONLY when it is byte-equal to that derivation.
// Any mismatch — different tenant, scope, kind slug, or trailing shape — is a
// hard error. A bare `name` (no `/`) derives the ref directly.

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
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

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
 * Resolve the trailing `name` segment from a caller's `supplied` value. A bare
 * name (`"default"`, no `/`) is returned as-is (trimmed). A full ref
 * (`"credential/<slug>/<scope>/<ownerId>/<name>"`) is split into its trailing
 * segment — but the segment is only trusted insofar as re-deriving the ref from
 * it reproduces the caller's exact bytes; {@link deriveImportRef} enforces that
 * byte-equality. This function NEVER trusts a caller-supplied ref on its own.
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
  // A full ref was supplied: the derived ref must reproduce it byte-for-byte.
  const lastSlash = supplied.lastIndexOf("/");
  const name = supplied.slice(lastSlash + 1);
  const derived = deriveCredentialRef({ kind: args.kind, scope: args.scope, ownerId: args.ownerId, name });
  if (derived !== supplied) {
    throw new Error("credential ref does not belong to the authenticated owner");
  }
  return name;
}

/**
 * The single Tier-A #3 enforcement entrypoint the import route calls. Derives
 * the canonical Vault ref under the authorized `{kind, scope, ownerId}`; a
 * caller-supplied full ref is accepted only when byte-equal to that derivation,
 * else this throws (caught by the route as a 400). There is no bare-ref
 * back-compat: the caller never picks the ref.
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
