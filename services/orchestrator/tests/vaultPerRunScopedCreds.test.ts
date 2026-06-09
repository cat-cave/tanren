// Managed-hosting dimension D — per-run scoped credentials. Proves the
// de-privilege end to end against a FAKE Vault (real proof is the smoke/e2e):
//   - the real VaultRunTokenMinter writes a policy granting `read` on EXACTLY the
//     run's cred ref data paths (one stanza per ref, never a wildcard) and creates
//     a child token with a short TTL, bounded num_uses, renewable:false, orphan;
//   - the scoped store can read ONLY the run's refs and is DENIED another run's;
//   - the broad token is never presented on the scoped KV reads;
//   - `collectRunCredentialRefPaths` covers the routing authRefs + github + codex
//     refs (and NOT the runner SSH identity);
//   - the workflow mints + emits `credential.scoped_token_minted` (no token value)
//     and routes the run's credential read through the scoped store, not the broad
//     one;
//   - a non-Vault backend (no minter) leaves `secrets` unchanged.
import { describe, expect, it } from "vitest";
import { vcsProviderOver } from "./helpers/vcsProvider.js";
import { VaultRunTokenMinter, buildScopedCredentialAccess } from "../src/engine/contracts/vaultTokenMinterImpl.js";
import { VaultSecretStore } from "../src/engine/contracts/secretStore.js";
import {
  applyScopedRunCredentials,
  buildRunCredentialScoping,
  collectRunCredentialRefPaths,
  resolveScopedRunCredentials,
  resolveScopedRunTokenTtlSeconds,
} from "../src/engine/workflow/plannerRunScopedCreds.js";
import { vaultTokenFetch } from "./conformance/fakes/vaultTokenFetch.js";
import {
  accounting,
  approvingReview,
  context,
  fakeProbe,
  healthyWindow,
  noopMerge,
  completeCheck,
  passingGitHub,
  runPlannerLoopScoped,
  setup,
  twoSubtaskAdapters,
} from "./plannerRun.fixtures.js";

const GH_REF = "credential/github/org/org-acme/bot";
const CODEX_REF = "credential/codex/org/org-acme/default";

describe("VaultRunTokenMinter — policy scoping + token bounds", () => {
  it("writes a read-only policy with one stanza per ref's data path (no wildcard) using the broad token", async () => {
    const vault = vaultTokenFetch();
    const minter = new VaultRunTokenMinter({ addr: "http://vault:8200", token: "BROAD", fetchImpl: vault.fetch });

    const minted = await minter.mintScopedRunToken({
      runId: "run-xyz",
      orgId: "org-acme",
      credentialRefPaths: [GH_REF, CODEX_REF],
      ttlSeconds: 900,
      numUses: 16,
    });

    // The policy grants `read` on EXACTLY the two refs' KV-v2 data paths.
    expect(vault.policyWrites).toHaveLength(1);
    const hcl = vault.policyWrites[0]!.policyHcl;
    expect(hcl).toContain(`path "secret/data/${GH_REF}"`);
    expect(hcl).toContain(`path "secret/data/${CODEX_REF}"`);
    expect(hcl).toContain('capabilities = ["read"]');
    // Never a wildcard / never another capability.
    expect(hcl).not.toContain("*");
    expect(hcl).not.toMatch(/create|update|delete|sudo|list/u);
    expect(minted.refPaths).toEqual([CODEX_REF, GH_REF]);

    // The token was created carrying ONLY that policy, short TTL, bounded uses,
    // non-renewable, orphan (no-parent).
    expect(vault.tokenCreates).toHaveLength(1);
    const create = vault.tokenCreates[0]!;
    expect(create.policies).toEqual([minted.policyName]);
    expect(create.ttl).toBe("900s");
    expect(create.explicitMaxTtl).toBe("900s");
    expect(create.numUses).toBe(16);
    expect(create.renewable).toBe(false);
    expect(create.noParent).toBe(true);

    // The BROAD token was used ONLY for the two admin (policy + create) calls.
    expect(vault.adminTokensSeen).toEqual(["BROAD", "BROAD"]);
  });

  it("the scoped store reads ONLY the run's refs and is DENIED another run's ref", async () => {
    const vault = vaultTokenFetch();
    vault.seed(GH_REF, "ghp_run_token");
    vault.seed("credential/github/org/other-org/bot", "ghp_OTHER");
    const minter = new VaultRunTokenMinter({ addr: "http://vault:8200", token: "BROAD", fetchImpl: vault.fetch });

    const { secrets, scope } = await buildScopedCredentialAccess({
      minter,
      addr: "http://vault:8200",
      fetchImpl: vault.fetch,
      input: { runId: "run-xyz", orgId: "org-acme", credentialRefPaths: [GH_REF], ttlSeconds: 600, numUses: 8 },
    });

    // The run's own ref reads through the scoped token.
    await expect(secrets.get(GH_REF)).resolves.toEqual({ ref: GH_REF, value: "ghp_run_token" });
    expect(vault.authorizedReads).toContain(GH_REF);

    // Another run's/org's ref is DENIED by the scoped policy (real enforcement).
    await expect(secrets.get("credential/github/org/other-org/bot")).rejects.toThrow(/403/u);
    expect(vault.deniedReads).toContain("credential/github/org/other-org/bot");

    // The scope audit material never carries the token value.
    expect(JSON.stringify(scope)).not.toContain("child::");
    expect(JSON.stringify(scope)).not.toContain("BROAD");
  });

  it("the broad token is never presented on the scoped KV reads", async () => {
    const vault = vaultTokenFetch();
    vault.seed(CODEX_REF, "codex-auth");
    const minter = new VaultRunTokenMinter({ addr: "http://vault:8200", token: "BROAD", fetchImpl: vault.fetch });
    const { secrets } = await buildScopedCredentialAccess({
      minter,
      addr: "http://vault:8200",
      fetchImpl: vault.fetch,
      input: { runId: "r", orgId: "org-acme", credentialRefPaths: [CODEX_REF], ttlSeconds: 600, numUses: 8 },
    });
    await secrets.get(CODEX_REF);
    // The broad token appears ONLY on the two admin calls — never on a KV read.
    expect(vault.adminTokensSeen.every((t) => t === "BROAD")).toBe(true);
    expect(vault.adminTokensSeen).toHaveLength(2);
  });
});

describe("collectRunCredentialRefPaths", () => {
  it("covers routing authRefs + github + codex refs, never the runner SSH identity", () => {
    const ctx = context();
    ctx.orgId = "org-acme";
    ctx.defaultLlm = { cli: "codex", model: "default", authRef: CODEX_REF };
    ctx.githubCredentialRef = GH_REF;
    ctx.identitySecretRef = "runner/local-docker/identity";
    ctx.routing = {
      plan: { chain: [{ cli: "codex", model: "m", authRef: CODEX_REF }] },
      write: { chain: [{ cli: "claude", model: "m", authRef: "credential/claude/org/org-acme/default" }] },
      check: { chain: [] },
      audit: { chain: [] },
      demo: { chain: [] },
      forge: { chain: [] },
    };
    const refs = collectRunCredentialRefPaths(ctx);
    expect(refs).toContain(CODEX_REF);
    expect(refs).toContain(GH_REF);
    expect(refs).toContain("credential/claude/org/org-acme/default");
    // The runner SSH identity is read by a different seam (the SSH substrate),
    // never via the run's scoped credential token.
    expect(refs).not.toContain("runner/local-docker/identity");
  });

  it("scopes in the App private-key path when the org uses the App (empty github sentinel)", () => {
    const ctx = context();
    ctx.orgId = "org-acme";
    ctx.defaultLlm = { cli: "codex", model: "default", authRef: CODEX_REF };
    // App-installed org: the static github ref is the empty sentinel; the run mints
    // its installation token by reading the App private-key credential.
    ctx.githubCredentialRef = "";
    ctx.installation = { installationId: "137492334", credentialRef: "credential/github_app/org/org-acme/default" };
    const refs = collectRunCredentialRefPaths(ctx);
    expect(refs).toContain("credential/github_app/org/org-acme/default");
    // The empty sentinel itself is never a path.
    expect(refs).not.toContain("");
  });
});

describe("buildRunCredentialScoping (env → seam)", () => {
  it("builds the scoping seam for the Vault backend from the REQUIRED env", () => {
    const scoping = buildRunCredentialScoping({
      TANREN_SECRET_STORE: "vault",
      VAULT_ADDR: "http://vault.internal:8200",
      VAULT_TOKEN: "broad-live-token",
      VAULT_KV_MOUNT: "kv-prod",
    });
    expect(scoping).toBeDefined();
    expect(scoping?.addr).toBe("http://vault.internal:8200");
    expect(scoping?.mount).toBe("kv-prod");
    expect(scoping?.minter).toBeDefined();
  });

  it("returns undefined for a non-Vault backend (nothing to de-privilege)", () => {
    expect(buildRunCredentialScoping({ TANREN_SECRET_STORE: "memory" })).toBeUndefined();
  });
});

describe("resolveScopedRunCredentials / applyScopedRunCredentials", () => {
  it("returns secrets/input unchanged when no scoping is wired (non-Vault backend)", async () => {
    const { ctx, secrets } = await setup();
    const events: Array<{ eventType: string }> = [];
    const append = async (eventType: string): Promise<void> => {
      events.push({ eventType });
    };
    const input = { secrets, context: ctx } as never;
    const out = await resolveScopedRunCredentials(input, append as never);
    expect(out.secrets).toBe(secrets);
    // applyScopedRunCredentials returns the SAME input object (no rebind) when unscoped.
    expect(await applyScopedRunCredentials(input, append as never)).toBe(input);
    expect(events).toHaveLength(0);
  });
});

describe("runPlannerLoopWorkflow — per-run credential de-privilege wiring", () => {
  it("mints a scoped token, emits the audit event (no token value), and reads the run's github ref via the scoped store", async () => {
    const { ctx, pool, events, allocator, ssh } = await setup();
    ctx.orgId = "org-acme";
    ctx.githubCredentialRef = GH_REF;
    ctx.defaultLlm = { cli: "codex", model: "default", authRef: CODEX_REF };

    // The scoped store + minter share ONE recording Vault transport; the run's
    // github token is seeded there so the clone-token resolution reads it via the
    // SCOPED token. A SEPARATE broad store (different transport) is injected as
    // `input.secrets`; if the de-privilege works it is never used for the read.
    const vault = vaultTokenFetch();
    vault.seed(GH_REF, "ghp_secretToken");
    const minter = new VaultRunTokenMinter({ addr: "http://vault:8200", token: "BROAD", fetchImpl: vault.fetch });

    const broad = vaultTokenFetch();
    broad.seed(GH_REF, "ghp_BROAD_should_not_be_read");
    const broadSecrets = new VaultSecretStore({ addr: "http://vault:8200", token: "BROAD", fetchImpl: broad.fetch });

    const result = await runPlannerLoopScoped({
      pool: pool.asPgPool(),
      eventStore: events,
      allocator,
      ssh,
      secrets: broadSecrets,
      credentialScoping: { minter, addr: "http://vault:8200", fetchImpl: vault.fetch },
      vcsProvider: vcsProviderOver(passingGitHub()),
      context: ctx,
      escapeHatches: { maxWriterIterPerSubtask: 5, maxRetriesPerTransientFailure: 3 },
      timeoutMs: 100,
      maxCiPolls: 1,
      sleep: async () => {},
      buildAdapters: () => twoSubtaskAdapters([completeCheck, completeCheck]),
      buildUsageProbe: () => fakeProbe(healthyWindow(), accounting(0.5)),
      reviewProbe: approvingReview(),
      mergeProbe: noopMerge(),
    });

    expect(result.outcome.kind).toBe("passed");

    // The audit event was emitted with the scope (ref paths + bounds), never the token.
    const minted = events.events.filter((e) => e.eventType === "credential.scoped_token_minted");
    expect(minted).toHaveLength(1);
    const payload = minted[0]!.payload as { refPaths: string[]; ttlSeconds: number; numUses: number };
    expect(payload.refPaths).toContain(GH_REF);
    expect(payload.ttlSeconds).toBeGreaterThan(0);
    expect(payload.numUses).toBeGreaterThan(0);
    // No token value anywhere in the event stream.
    expect(JSON.stringify(events.events)).not.toContain("child::");
    expect(JSON.stringify(events.events)).not.toContain("BROAD");

    // The github ref was read through the SCOPED transport (the clone token).
    expect(vault.authorizedReads).toContain(GH_REF);
    // The BROAD store's transport was NEVER used for a KV read.
    expect(broad.authorizedReads).toHaveLength(0);
  });
});

// The runner ceiling (TANREN_MAX_RUN_HOURS) in seconds — the floor the scoped
// credential token TTL must meet or exceed, or a long run loses its creds mid-run.
const ceilingSeconds = (hours: number) => hours * 3_600;

describe("resolveScopedRunTokenTtlSeconds — TTL covers the runner ceiling (§3.14)", () => {
  it("defaults the TTL to the 6h run ceiling (was 2h — the §3.14 drift)", () => {
    const ttl = resolveScopedRunTokenTtlSeconds({});
    expect(ttl).toBe(ceilingSeconds(6));
    expect(ttl).toBeGreaterThanOrEqual(ceilingSeconds(6));
    // The OLD hardcoded 2h would have lost every cred materialization past 2h.
    expect(ttl).toBeGreaterThan(7_200);
  });

  it("derives the TTL from TANREN_MAX_RUN_HOURS so it can't drift below the ceiling", () => {
    for (const hours of [1, 4, 6, 8, 12]) {
      const ttl = resolveScopedRunTokenTtlSeconds({ TANREN_MAX_RUN_HOURS: String(hours) });
      // The token must outlive the runner: TTL >= the configured ceiling, exactly.
      expect(ttl).toBe(ceilingSeconds(hours));
      expect(ttl).toBeGreaterThanOrEqual(ceilingSeconds(hours));
    }
  });

  it("falls back LOUDLY to the 6h ceiling on a non-positive / garbage override", () => {
    for (const bad of ["0", "-3", "abc", "  "]) {
      const ttl = resolveScopedRunTokenTtlSeconds({ TANREN_MAX_RUN_HOURS: bad });
      // A zero/garbage ceiling must NOT collapse the TTL — it covers the full default.
      expect(ttl).toBe(ceilingSeconds(6));
    }
  });
});
