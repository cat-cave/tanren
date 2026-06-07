// Harness↔orchestrator protocol — capability model (Track C §4 of
// docs/architecture/portability-and-longevity.md, contract: docs/architecture/
// harness-protocol.md).
//
// Each provider `cli` is a *harness* that maps its CLI to the one versioned
// harness protocol. A harness declares which protocol roles it can serve. The
// single discriminator is `structuredOutput`: a harness that can emit
// schema-constrained JSON (the protocol's structured-output channel) is
// Answerer-eligible AND Writer-eligible; a harness without structured output is
// Writer-only.
//
// This descriptor is the SINGLE SOURCE OF TRUTH the selector consults. Adding a
// future harness (agy or the native Rust harness) is one capability entry here +
// its adapter — the selectable-cli sets and the role-eligibility checks all
// derive from this table, so there is no second place to keep in sync. (aider,
// pi, and reasonix are already wired writer-only; agy is deferred — its headless
// `-p` mode is broken in non-TTY and it has no usable structured output.)

import type { CredentialType } from "../credentials/credentialType.js";

// The protocol version this capability model targets. Bumped only on a
// breaking change to the harness invocation/result contract (see
// docs/architecture/harness-protocol.md §Versioning).
export const HARNESS_PROTOCOL_VERSION = "v1" as const;

// The roles a harness can serve in the protocol. `write` produces a
// diff/commits result; `answer` produces structured JSON matching a role
// schema (and therefore requires structured-output support).
export type HarnessRole = "write" | "answer";

// The provider clis that are real harnesses (the WriterAdapter.cli union minus
// "fake", which is wired directly in tests and never selected through routing).
export type HarnessCli = "codex" | "claude" | "opencode" | "aider" | "pi" | "reasonix";

// A typed capability record per harness cli. `structuredOutput` is the
// load-bearing field: it is exactly equivalent to "answer" being present in
// `roles`. The invariant is asserted by HARNESS_CAPABILITIES construction below
// and pinned by a conformance test.
export interface HarnessCapability {
  readonly cli: HarnessCli;
  // The protocol roles this harness can serve, in declaration order.
  readonly roles: readonly HarnessRole[];
  // Whether the harness supports the protocol's structured-output channel
  // (schema-constrained JSON). True ⟺ the harness is Answerer-eligible.
  readonly structuredOutput: boolean;
  // The credential-types this harness's materializer can actually consume —
  // the third axis (credentialType.ts) the credential model must keep separate
  // from provider and role. This is what makes a routing entry's (cli, authRef)
  // pair VALID: an authRef whose inferred CredentialType is not in this set
  // cannot drive this harness (e.g. a Codex ChatGPT bundle cannot drive aider).
  // MUST match what the harness's materializer accepts today — pinned by the
  // conformance test in tests/harnessCredentialCompat.test.ts.
  readonly acceptedCredentialTypes: readonly CredentialType[];
}

// The capability table. Two capability classes today:
//   - structured-capable (Writer + Answerer): codex, claude
//   - writer-only:                            opencode, aider, pi, reasonix
// aider/pi/reasonix have no schema-constrained answer output channel, so each is
// writer-only (it can edit files but cannot serve the `answer` role). pi
// (`@earendil-works/pi-coding-agent`, per-provider env-key auth) and reasonix
// (DeepSeek-native, DEEPSEEK_API_KEY) join the writer-only class on a spec-based
// contract (live CLI validation deferred, like aider). This MUST reproduce
// today's selection behavior (see the conformance test asserting the derived
// sets equal the historical SELECTABLE_* arrays).
//
// agy is intentionally NOT wired: its headless `-p` mode is broken in non-TTY
// and it exposes no usable structured output — deferred until those are fixed.
//
// `acceptedCredentialTypes` records what each harness's materializer consumes
// TODAY: codex/claude validate their own auth BUNDLE on the BYOK path
// (codexMaterializer/claudeMaterializer); aider/pi/reasonix consume a raw
// `api_key` (per-provider env var); opencode consumes its own bundle. (codex's
// managed mode already consumes a raw OpenRouter key via env, so widening the
// BYOK path to add `api_key` for codex/claude is a follow-up that also adds the
// type here — kept truthful per-step so the matrix never claims a path the
// materializer rejects.)
export const HARNESS_CAPABILITIES: readonly HarnessCapability[] = [
  {
    cli: "codex",
    roles: ["write", "answer"],
    structuredOutput: true,
    acceptedCredentialTypes: ["codex_chatgpt_bundle"],
  },
  { cli: "claude", roles: ["write", "answer"], structuredOutput: true, acceptedCredentialTypes: ["claude_cli_bundle"] },
  { cli: "opencode", roles: ["write"], structuredOutput: false, acceptedCredentialTypes: ["opencode_bundle"] },
  { cli: "aider", roles: ["write"], structuredOutput: false, acceptedCredentialTypes: ["api_key"] },
  { cli: "pi", roles: ["write"], structuredOutput: false, acceptedCredentialTypes: ["api_key"] },
  { cli: "reasonix", roles: ["write"], structuredOutput: false, acceptedCredentialTypes: ["api_key"] },
] as const;

function capabilitiesFor(role: HarnessRole): readonly HarnessCli[] {
  return HARNESS_CAPABILITIES.filter((capability) => capability.roles.includes(role)).map(
    (capability) => capability.cli,
  );
}

// The clis selectable as Writers / Answerers, DERIVED from the capability
// table. These back adapterSelector's SELECTABLE_* exports so there is a single
// source of truth for "which harness can serve which role".
export const WRITER_CAPABLE_CLIS: readonly HarnessCli[] = capabilitiesFor("write");
export const ANSWERER_CAPABLE_CLIS: readonly HarnessCli[] = capabilitiesFor("answer");

// Whether the given cli can serve the given role. The selector uses this to
// reject an unsupported (cli, role) pair before attempting to build an adapter.
export function harnessSupportsRole(cli: string, role: HarnessRole): boolean {
  const capability = HARNESS_CAPABILITIES.find((entry) => entry.cli === cli);
  return capability !== undefined && capability.roles.includes(role);
}

// Whether the given cli's materializer can consume the given credential-type.
// A routing entry's (cli, authRef) pair is only valid when the authRef's
// inferred CredentialType (credentialType.ts) satisfies this — the check that
// stops a stored credential from being routed to a harness that cannot read it
// (the facade bug: a non-Codex key written as the default then run as `codex`).
export function harnessAcceptsCredentialType(cli: string, credentialType: CredentialType): boolean {
  const capability = HARNESS_CAPABILITIES.find((entry) => entry.cli === cli);
  return capability !== undefined && capability.acceptedCredentialTypes.includes(credentialType);
}

// The full-role harnesses (write + answer) — the only clis eligible to back a
// DEFAULT LLM routing entry, since a default must satisfy every role (plan,
// write, check, audit), not just `write`. Today: codex, claude. Derived from the
// table so a new full-role harness is automatically eligible.
export const FULL_ROLE_CLIS: readonly HarnessCli[] = HARNESS_CAPABILITIES.filter(
  (capability) => capability.roles.includes("write") && capability.roles.includes("answer"),
).map((capability) => capability.cli);

// Whether a cli is eligible to back a default LLM routing entry (full-role).
export function harnessCanBeDefault(cli: string): boolean {
  return FULL_ROLE_CLIS.includes(cli as HarnessCli);
}
