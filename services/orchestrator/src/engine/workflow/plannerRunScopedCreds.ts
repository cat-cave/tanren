// plannerRunScopedCreds — the per-run credential de-privilege (managed-hosting
// dimension D). Before the run touches ANY credential, mint a short-lived Vault
// child token scoped to read ONLY this run's credential ref paths, swap the run's
// `secrets` for a SecretStore backed by THAT scoped token, and emit the audit
// record. The broad VAULT_TOKEN is used only by the minter (at the orchestrator
// boot) to create the child — it is never handed to a runner from here.
//
// When no minter is wired (a non-Vault secret-store backend, which has no Vault
// broad token to de-privilege), the run uses `input.secrets` unchanged — that is
// the REAL path for those backends (already tenant-namespaced), not a stub.

import type { SecretStore } from "../contracts/secretStore.js";
import type { ScopedCredentialAccess, VaultTokenMinter } from "../contracts/vaultTokenMinter.js";
import { buildScopedCredentialAccess } from "../contracts/vaultTokenMinterImpl.js";
import {
  buildVaultTokenMinter,
  resolveVaultMountConfig,
  type SecretStoreEnv,
} from "../contracts/secretStoreFactory.js";
import type { EventName, EventPayload } from "../events/index.js";
import type { PlannerRunContext, RunPlannerLoopInput } from "./plannerRun.js";

/**
 * The per-run credential-scoping seam, threaded as ONE optional field through the
 * executor → workflow (Vault backend only). When present, the run mints a scoped
 * child token over `minter` and reads its credentials through a `VaultSecretStore`
 * built at `addr`/`mount`. `fetchImpl` is a test seam (the scoped store reads
 * through the SAME fake transport its minter uses); production omits it.
 */
export interface RunCredentialScoping {
  minter: VaultTokenMinter;
  addr: string;
  mount?: string;
  fetchImpl?: typeof fetch;
  // The scoped-token TTL (seconds), RESOLVED FROM THE INJECTED BOOT ENV at build
  // time (r6 §2) — NOT re-read from the global `process.env` at mint time. Pinning
  // it here means the minted token's lifetime derives from the exact env the worker
  // booted with (`TANREN_MAX_RUN_HOURS`), so a per-boot override can never be lost
  // to a later global-env divergence.
  ttlSeconds: number;
}

/**
 * Build the per-run credential-scoping seam from the environment (the worker boot
 * calls this): the Vault child-token minter (Vault backend only) plus the Vault
 * addr/mount the scoped store reads. Returns `undefined` for a non-Vault backend —
 * that backend has no broad Vault token to de-privilege, so the run path reads its
 * (already tenant-namespaced) store directly. The minter is built from the BROAD
 * VAULT_TOKEN and used ONLY to mint short-lived children; the broad token is never
 * handed to a runner.
 */
export function buildRunCredentialScoping(env: SecretStoreEnv = process.env): RunCredentialScoping | undefined {
  const minter = buildVaultTokenMinter(env);
  if (minter === undefined) {
    return undefined;
  }
  const { addr, mount } = resolveVaultMountConfig(env);
  // r6 §2: resolve the scoped-token TTL FROM THE INJECTED env here (build time),
  // not from the global `process.env` at mint time, so the minted token's lifetime
  // derives from the exact boot env (and a malformed ceiling throws loud at boot).
  const ttlSeconds = resolveScopedRunTokenTtlSeconds(env);
  return { minter, addr, ttlSeconds, ...(mount === undefined ? {} : { mount }) };
}

/**
 * The exact set of credential ref paths a run reads: every routing-chain entry's
 * `authRef` (the codex/claude/opencode materializers read these) PLUS the run's
 * GitHub credential ref (the clone / PR / review / merge stages read this). The
 * scoped policy grants `read` on PRECISELY these — no wildcard, no widening. The
 * runner SSH identity is intentionally NOT here: it is read by the SSH substrate
 * at connect time (a different seam, off the run's credential path), not over the
 * runner with the run's token.
 *
 * Every ref here already embeds the run's org in its path
 * (`credential/<slug>/<scope>/<ownerId>/<name>`), so a run can only ever produce
 * paths for its OWN org's credentials — tenant isolation is structural.
 */
export function collectRunCredentialRefPaths(context: PlannerRunContext): string[] {
  const refs = new Set<string>();
  const routing = context.routing;
  if (routing !== undefined) {
    for (const role of Object.values(routing)) {
      for (const entry of role.chain) {
        if (entry.authRef.trim() !== "") {
          refs.add(entry.authRef.trim());
        }
      }
    }
  }
  // The default-LLM credential ref is the LLM auth the default routing heads its
  // chains with; include it explicitly so a run whose routing was not threaded
  // still scopes the LLM auth path.
  const defaultLlmAuthRef = context.defaultLlm?.authRef;
  if (defaultLlmAuthRef !== undefined && defaultLlmAuthRef.trim() !== "") {
    refs.add(defaultLlmAuthRef.trim());
  }
  // The GitHub credential ref — the clone / PR / review / merge stages read it.
  // A blank ref (public-repo, no static credential, no App) contributes nothing.
  if (context.githubCredentialRef.trim() !== "") {
    refs.add(context.githubCredentialRef.trim());
  }
  // App-installed org: the static github ref is the empty sentinel, but the run
  // MINTS its installation token by reading the App private-key credential — scope
  // THAT path in, else the scoped token gets 403 on the mint (the clone/push/PR/CI
  // stages all need it). Without the App, this contributes nothing.
  const installationRef = context.installation?.credentialRef;
  if (installationRef !== undefined && installationRef.trim() !== "") {
    refs.add(installationRef.trim());
  }
  return [...refs].sort();
}

/**
 * The subset of the run's credential refs that ROTATE and so must be WRITTEN BACK —
 * the scoped policy grants `create`+`update` on these (not just `read`). The ONLY
 * rotating credential today is the BYOK Codex ChatGPT auth bundle: codex refreshes
 * its access/refresh tokens on each call and writes a new `auth.json`; the run
 * persists that fresh bundle (`providers/codex.ts` → `storeCodexAuthBundle`) so the
 * next call/run does not reuse a stale (possibly-revoked) refresh token. Without the
 * write grant that persist-back 403s and the run halts — the exact apex-v33 failure.
 *
 * The signal mirrors codex.ts's own `auth.bundleAuth` write-back condition: a routing
 * entry with `cli === "codex"` whose `authRef` is a `credential/codex/` ref, on a
 * BYOK run (no `endpointBaseUrl`). A MANAGED codex run authenticates with a static
 * api_key (no token rotation, nothing to write back), and a static github token / api
 * key never rotates — so neither is ever writable. Every ref returned here is also in
 * {@link collectRunCredentialRefPaths} (writable is a capability on a ref the run
 * already reads, never a new path), so the policy is never widened beyond the run's
 * own credentials.
 */
export function collectRotatingCredentialRefPaths(context: PlannerRunContext): string[] {
  // Managed mode (an OpenAI-compatible endpoint) is a static api_key — no rotation.
  if (context.endpointBaseUrl !== undefined) {
    return [];
  }
  const refs = new Set<string>();
  const consider = (entry: { cli: string; authRef: string } | undefined): void => {
    if (entry === undefined) {
      return;
    }
    const authRef = entry.authRef.trim();
    if (entry.cli === "codex" && authRef.startsWith("credential/codex/")) {
      refs.add(authRef);
    }
  };
  const routing = context.routing;
  if (routing !== undefined) {
    for (const role of Object.values(routing)) {
      for (const entry of role.chain) {
        consider(entry);
      }
    }
  }
  consider(context.defaultLlm);
  return [...refs].sort();
}

/**
 * The default run-hours ceiling — the SAME value the allocator's abandoned-runner
 * sweeper uses (`TANREN_MAX_RUN_HOURS`, default 6h, in `services/allocator`). Kept
 * in sync structurally: the scoped-token TTL below DERIVES from this ceiling so the
 * token can never expire before the runner it scopes is reaped.
 */
const DEFAULT_MAX_RUN_HOURS = 6;

/**
 * How long a run may hold its scoped credential token. The token must outlive the
 * ENTIRE run: credentials are NOT read once up front — the codex/claude writer AND
 * every Answerer (checker/auditor) re-materialize the per-role auth bundle on each
 * call, so a multi-iteration run (planner reruns × writer iterations × roles) reads
 * its credentials many times over many minutes. The token is non-renewable, so this
 * TTL is the hard ceiling on the whole run's credential lifetime.
 *
 * It is DERIVED FROM THE RUN-HOURS CEILING (`TANREN_MAX_RUN_HOURS`, the same env the
 * allocator's abandoned-runner sweeper uses) so the two CANNOT DRIFT: a token TTL
 * shorter than the runner ceiling means a run crossing the TTL loses every credential
 * materialization (the §3.14 finding — a 2h TTL vs a 6h runner). The TTL is the FULL
 * ceiling (not a fraction) so the token outlives any run the sweeper would still let
 * live.
 *
 * No-silent-fallback (Codex r4 §1), CONSISTENT WITH THE ALLOCATOR SCHEMA: the 6h
 * default applies ONLY when the var is genuinely UNSET/blank. A PRESENT non-positive
 * / non-finite value is a deploy-config PARSE failure and THROWS loud — it must NOT
 * quietly degrade to the default (which the old `log.error + return default` did,
 * letting a typo'd ceiling silently mint a 6h token while the operator believed they
 * set something else). The de-privilege still holds: the token's ACL is scoped to
 * ONLY this run's credential paths.
 */
export function resolveScopedRunTokenTtlSeconds(env: SecretStoreEnv = process.env): number {
  const raw = env["TANREN_MAX_RUN_HOURS"];
  if (raw === undefined || raw === "") {
    return DEFAULT_MAX_RUN_HOURS * 3_600;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `TANREN_MAX_RUN_HOURS='${raw}' is not a positive number of hours. The scoped-credential token TTL derives ` +
        "from this ceiling (it must cover the runner lifetime or a long run loses its credentials mid-run); a " +
        "present-but-malformed value must NOT silently collapse to the default. Unset it to use the 6h default.",
    );
  }
  return Math.ceil(parsed * 3_600);
}
/**
 * Per-credential-ref read budget. Each writer iteration + each Answerer call
 * re-materializes the credential (1-2 Vault reads), so a run with the max escape-hatch
 * iterations reads a single credential dozens of times. Sized well above any real run
 * so use-exhaustion never fails a legitimate run; the token remains path-scoped + TTL-bounded.
 */
export const SCOPED_RUN_TOKEN_USES_PER_REF = 256;

export interface ScopedRunCredentials {
  /** The SecretStore the run's credential reads/materialization MUST use. */
  secrets: SecretStore;
  /** Present only when a scoped child token was minted (Vault backend). */
  scoped?: ScopedCredentialAccess;
}

/**
 * De-privilege the run's credential reads: mint the run's scoped child token
 * (when a Vault minter is wired) and return the `RunPlannerLoopInput` the rest of
 * the workflow must use — `secrets` swapped for the scoped store (every downstream
 * stage reads through `input.secrets`, so this single rebind is the seam). Emits
 * `credential.scoped_token_minted` with the NON-SECRET scope (ref paths + policy
 * name + TTL/uses) — never the token value, never the broad token. When no minter
 * is wired (a non-Vault backend) OR the run reads no Vault credentials, returns
 * `input` unchanged (no event — nothing was scoped).
 */
export async function applyScopedRunCredentials(
  input: RunPlannerLoopInput,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
): Promise<RunPlannerLoopInput> {
  const resolved = await resolveScopedRunCredentials(input, appendEvent);
  return resolved.secrets === input.secrets ? input : { ...input, secrets: resolved.secrets };
}

/**
 * Mint the run's scoped child token (when a minter is wired) and return the
 * SecretStore the run path must use. See {@link applyScopedRunCredentials} for the
 * workflow-facing seam; this lower-level helper is also unit-tested directly.
 */
export async function resolveScopedRunCredentials(
  input: RunPlannerLoopInput,
  appendEvent: <N extends EventName>(eventType: N, payload: EventPayload<N>, taskId?: string) => Promise<void>,
): Promise<ScopedRunCredentials> {
  const scoping = input.credentialScoping;
  const refPaths = scoping === undefined ? [] : collectRunCredentialRefPaths(input.context);
  // No scoping (non-Vault backend) OR no Vault credentials to read on the run path
  // → nothing to scope; use the broad store (which, in the no-cred case, reads
  // nothing). `scoping` is re-narrowed for the type checker.
  if (scoping === undefined || refPaths.length === 0) {
    return { secrets: input.secrets };
  }
  // The rotating subset (the BYOK Codex bundle) the policy must grant WRITE on so the
  // run's post-call auth-bundle persist-back succeeds instead of 403-ing. Always ⊆
  // refPaths (the minter re-asserts that), so the policy is never widened.
  const writableRefPaths = collectRotatingCredentialRefPaths(input.context);
  const scoped = await buildScopedCredentialAccess({
    minter: scoping.minter,
    addr: scoping.addr,
    ...(scoping.mount === undefined ? {} : { mount: scoping.mount }),
    ...(scoping.fetchImpl === undefined ? {} : { fetchImpl: scoping.fetchImpl }),
    input: {
      runId: input.context.runId,
      orgId: input.context.orgId ?? null,
      credentialRefPaths: refPaths,
      writableCredentialRefPaths: writableRefPaths,
      // r6 §2: the TTL pinned at boot from the INJECTED env (on `scoping`), NOT
      // re-read from the global `process.env` here — so the minted token's lifetime
      // is the one the worker booted with.
      ttlSeconds: scoping.ttlSeconds,
      numUses: refPaths.length * SCOPED_RUN_TOKEN_USES_PER_REF,
    },
  });
  // Audit: a scoped token was minted for the run. The payload carries the scope
  // (ref paths the policy covers, the writable subset, + bounds), NEVER the token value.
  await appendEvent("credential.scoped_token_minted", {
    policyName: scoped.scope.policyName,
    refPaths: scoped.scope.refPaths,
    writableRefPaths: scoped.scope.writableRefPaths,
    ttlSeconds: scoped.scope.ttlSeconds,
    numUses: scoped.scope.numUses,
  });
  return { secrets: scoped.secrets, scoped };
}
