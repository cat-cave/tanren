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
// The Vault ref is ALWAYS derived server-side from `{kind, scope, ownerId}` plus
// the caller's `name`. There is no back-compat path that accepts a bare
// caller-supplied ref: if the caller supplies a full ref it must be byte-equal
// to the server-derived ref (so the caller cannot anchor a key to a different
// tenant). Anything else is a hard 400 — never silently accepted.

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
 * Resolve the trailing `name` segment the caller intends. The caller supplies a
 * bare name (`"default"`). If the caller supplies a full ref instead, it MUST be
 * byte-equal to the ref this route would derive for the authorized
 * `{kind, scope, ownerId}` — i.e. it must name this exact tenant namespace AND
 * end in a single safe name segment — otherwise this throws. There is no
 * back-compat path that trusts a caller-supplied ref shape. Returns the name to
 * feed into {@link deriveCredentialRef}.
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
  // A full ref was supplied: accept it ONLY if it is exactly the ref we would
  // derive server-side for this actor. Reject anything else (no silent accept).
  const expectedPrefix = `credential/${KIND_SLUG[args.kind]}/${args.scope}/${args.ownerId}/`;
  if (!supplied.startsWith(expectedPrefix)) {
    throw new Error("credential ref does not belong to the authenticated owner");
  }
  const name = supplied.slice(expectedPrefix.length);
  if (name === "" || name.includes("/")) {
    throw new Error("credential ref must end in a single name segment");
  }
  // Round-trip guard: the derived ref must reproduce the supplied ref byte-for-
  // byte, so a malformed (but prefix-matching) ref cannot slip through.
  const derived = deriveCredentialRef({ kind: args.kind, scope: args.scope, ownerId: args.ownerId, name });
  if (derived !== supplied) {
    throw new Error("credential ref does not match the server-derived ref");
  }
  return name;
}

/**
 * The single Tier-A #3 enforcement entrypoint the import route calls: derive the
 * Vault ref server-side under the authorized `{kind, scope, ownerId}`. A caller
 * who supplies only a bare `name` gets the derived ref; a caller who supplies a
 * full ref has it validated to be byte-equal to that derived ref. Throws (caught
 * by the route as a 400) when the caller's ref names a different tenant or is
 * malformed.
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
