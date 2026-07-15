# ssh-substrate-keygen-flake — CI-gate liveness repair for the host-key verifier test

**Phase**: hardening / CI-gate authenticity repair
**State at admission**: `ssh2@1.17.0` raw `utils.generateKeyPairSync("ed25519")` strips a
leading `0x00` point byte ~0.36% of the time, emitting a malformed 31-byte OpenSSH
public key that fails the `parseKey` → `getPublicSSH` round-trip the test exercises.
Current-main push `29433885055` failed only `services/orchestrator/tests/sshSubstrate.test.ts`
line 131 (the `mismatch` arm drew a bad raw key). This is a flake repair, not a new
consumer node.
**Purpose**: route the two stale raw keygen bypasses inside the host-verifier test
through Tanren's existing bounded keygen authority so the CI gate reflects real
production liveness/authenticity instead of a third-party keygen defect.

## Dependencies

**Hard build dependencies**

- `services/orchestrator/src/engine/ssh/keygen.ts` — `generateEd25519KeyPair`
  (the production keypair generator that validates the `parseKey`→`getPublicSSH`
  round-trip and regenerates on failure up to `KEYGEN_MAX_ATTEMPTS`, so a malformed
  ssh2 key never escapes it). This card consumes the authority; it does NOT modify it.

**Downstream consumers**

- None. The repair is test-local; production SSH surface is unchanged.

## Exclusive ownership

- `docs/roadmap/mission-complete/nodes/cards/ssh-substrate-keygen-flake.md`
- `services/orchestrator/tests/sshSubstrate.test.ts`

No production, API, schema, migration, or shared-nav change. `generateEd25519KeyPair`
is added to the existing `../src/engine/ssh/index.js` import; the two
`utils.generateKeyPairSync("ed25519")` inputs (the matching `hostKey` and the
`otherKey` mismatch) become `generateEd25519KeyPair().publicKey` values. The real
`parseKey → getPublicSSH → SHA-256` construction and the accept-matching /
reject-mismatching assertions are preserved verbatim.

## Shared-resource leases, not owned paths

None. The raw `generateKeyPairSync("ed25519")` call remains confined to
`services/orchestrator/src/engine/ssh/keygen.ts` (the production keygen authority)
and its dedicated `services/orchestrator/tests/sshKeygen.test.ts`. No other tracked
file imports or invokes it.

## Consumes

- `generateEd25519KeyPair()` from `../src/engine/ssh/index.js` (re-exported via
  `services/orchestrator/src/engine/ssh/index.ts` → `./keygen.js`).
- `ssh2`'s `utils.parseKey` / `ParsedKey.getPublicSSH` for the in-test
  fingerprint computation (unchanged).

## Produces

- A test gate proof: `sshSubstrate.test.ts` no longer flakes on the
  `ssh2@1.17.0` leading-zero malformed-public-key defect because both keys it
  generates are already round-trip-validated by the production helper.
- No new production, API, schema, contract, or dashboard surface.

## Negative controls

- The matching-key arm still uses the real `parseKey → getPublicSSH → SHA-256`
  pipeline; no parsing is mocked, weakened, or skipped.
- The mismatching-key arm still asserts `verifier(mismatch) === false`; no
  assertion is relaxed, removed, or retried around the test body.
- No production code is altered; no dependency is bumped; the test is not
  skipped or wrapped in a retry loop.

## Validation

- Focused: `services/orchestrator/tests/sshSubstrate.test.ts` and
  `services/orchestrator/tests/sshKeygen.test.ts`.
- Grep proof: raw `generateKeyPairSync("ed25519")` remains confined to
  `services/orchestrator/src/engine/ssh/keygen.ts` and
  `services/orchestrator/tests/sshKeygen.test.ts`.
- Local stress: ≥30,000 parse round-trips through the production helper leak
  zero malformed keys (untracked one-liner; not committed as a fixture).
- `just affected-typecheck` and `just affected-test`; focused format, lint,
  spelling, architecture, line-cap, and `git diff --check`.

## Callable / visible (honest, not newly claimed)

- Production SSH surface (host-key pinning, fingerprint normalization, the
  connect-establishment bound, the double-`error` teardown guard) remains
  callable/visible through existing `doctor`, `status`, and the compose smoke
  for connectivity — this card adds no new callable or visible surface and
  claims none.

## Serialization

None. No DB migration, no `nav`/`screens.ts`/`main.ts` edit, no shared contract
file is touched by this card.
