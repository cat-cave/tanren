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
// future harness (agy/aider/pi/reasonix, or the native Rust harness) is one
// capability entry here + its adapter — the selectable-cli sets and the
// role-eligibility checks all derive from this table, so there is no second
// place to keep in sync.

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
export type HarnessCli = "codex" | "claude" | "opencode" | "aider";

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
}

// The capability table. Two capability classes today:
//   - structured-capable (Writer + Answerer): codex, claude
//   - writer-only:                            opencode, aider
// aider has no structured-JSON output channel, so it is writer-only (it can
// edit files but cannot serve the `answer` role). This MUST reproduce today's
// selection behavior (see the conformance test asserting the derived sets
// equal the historical SELECTABLE_* arrays).
export const HARNESS_CAPABILITIES: readonly HarnessCapability[] = [
  { cli: "codex", roles: ["write", "answer"], structuredOutput: true },
  { cli: "claude", roles: ["write", "answer"], structuredOutput: true },
  { cli: "opencode", roles: ["write"], structuredOutput: false },
  { cli: "aider", roles: ["write"], structuredOutput: false }
] as const;

function capabilitiesFor(role: HarnessRole): readonly HarnessCli[] {
  return HARNESS_CAPABILITIES.filter((capability) => capability.roles.includes(role)).map((capability) => capability.cli);
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
