// BYOK credential-lifecycle hardening (apex v30). The run lifecycle must drive
// BOTH managed AND BYOK end-to-end: build → task → POST-TASK usage/cost accounting
// → PR-publish/merge. Managed has a platform credential at every site; BYOK has
// NONE for the managed-only steps. This pins the two regressions BYOK exposed:
//   1. the POST-TASK managed real-cost capture is a MANAGED-ONLY step — a BYOK run
//      EXPLICITLY skips it (never an empty platform metering ref pushed through the
//      grammar validator: the v30 `credential ref has an invalid format: ""` crash);
//   2. the App-FIRST GitHub token resolution carries an EMPTY-STRING App sentinel
//      for `githubCredentialRef` — it must collapse to "no static ref" (mint the App
//      token), never `validateGithubCredentialRef("")`.
import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildManagedCapturerForRun } from "../src/engine/workflow/plannerRunUsage.js";
import type { RunPlannerLoopInput } from "../src/engine/workflow/plannerRun.js";
import { normalizeStaticGithubRef } from "../src/engine/credentials/githubToken.js";
import { storeGithubAppCredential } from "../src/engine/credentials/githubApp.js";
import { GithubAppTokenMinter } from "../src/engine/providers/githubAppTokenMinter.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { SecretStore } from "../src/engine/contracts/secretStore.js";

// A minimal RunPlannerLoopInput carrying ONLY the fields buildManagedCapturerForRun
// reads (secrets + context.endpointBaseUrl + context.defaultLlm.authRef).
function capturerInput(opts: {
  endpointBaseUrl?: string;
  defaultLlmAuthRef?: string;
  secrets?: SecretStore;
}): RunPlannerLoopInput {
  return {
    secrets: opts.secrets ?? new InMemorySecretStore(),
    context: {
      ...(opts.endpointBaseUrl !== undefined && { endpointBaseUrl: opts.endpointBaseUrl }),
      ...(opts.defaultLlmAuthRef !== undefined && {
        defaultLlm: { cli: "codex", model: "default", authRef: opts.defaultLlmAuthRef },
      }),
    },
  } as unknown as RunPlannerLoopInput;
}

describe("buildManagedCapturerForRun — BYOK explicit skip vs managed build", () => {
  it("BYOK (no endpoint) EXPLICITLY skips the managed-only metering, never touching a platform ref", async () => {
    // No platform metering credential exists in BYOK — the v30 path is the
    // post-task accounting trying to resolve one. The skip is the discriminated,
    // narrated state; crucially it does NOT throw an empty-ref format error.
    const resolution = await buildManagedCapturerForRun(
      capturerInput({ defaultLlmAuthRef: "credential/codex/org/o1/x" }),
    );
    expect(resolution).toEqual({ capturer: undefined, skipped: "byok_no_platform_metering_ref" });
  });

  it("BYOK skips even when defaultLlm.authRef is the EMPTY App-sentinel-like value (no empty ref pushed through)", async () => {
    // The fatal v30 shape: an empty ref reaching the validator. The BYOK branch
    // returns BEFORE any ref is read, so an empty authRef is harmless here.
    await expect(buildManagedCapturerForRun(capturerInput({ defaultLlmAuthRef: "" }))).resolves.toEqual({
      capturer: undefined,
      skipped: "byok_no_platform_metering_ref",
    });
  });

  it("MANAGED run (endpoint set) builds a capturer from the platform OpenRouter ref — metering still works", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.put({ ref: "credential/openrouter/platform/default", value: "sk-or-platform" });
    const resolution = await buildManagedCapturerForRun(
      capturerInput({
        endpointBaseUrl: "https://openrouter.ai/api/v1",
        defaultLlmAuthRef: "credential/openrouter/platform/default",
        secrets,
      }),
    );
    expect("skipped" in resolution).toBe(false);
    expect(resolution.capturer).toBeTypeOf("function");
  });

  it("MANAGED run with no resolved defaultLlm authRef is a LOUD wiring bug (never a silent skip)", async () => {
    await expect(
      buildManagedCapturerForRun(capturerInput({ endpointBaseUrl: "https://openrouter.ai/api/v1" })),
    ).rejects.toThrow("wiring bug");
  });
});

describe("normalizeStaticGithubRef — App-sentinel empty ref collapses to undefined (v30 publish/merge crash)", () => {
  it("collapses the EMPTY-STRING App sentinel to undefined (no static ref → mint the App token)", () => {
    expect(normalizeStaticGithubRef("")).toBeUndefined();
  });

  it("collapses whitespace-only + undefined to undefined", () => {
    expect(normalizeStaticGithubRef("   ")).toBeUndefined();
    const missing: string | undefined = undefined;
    expect(normalizeStaticGithubRef(missing)).toBeUndefined();
  });

  it('never passes an empty ref to validateGithubCredentialRef (no `invalid format: ""` throw)', () => {
    // The exact v30 crash was validateGithubCredentialRef("") → the format error.
    expect(() => normalizeStaticGithubRef("")).not.toThrow();
  });

  it("grammar-validates a NON-empty static ref as before (a malformed ref still fails loud)", () => {
    expect(normalizeStaticGithubRef("credential/github/org/o1/default")).toBe("credential/github/org/o1/default");
    expect(() => normalizeStaticGithubRef("credential/codex/org/o1/default")).toThrow("credential/github/");
  });
});

describe("GithubAppTokenMinter — empty installation credentialRef fails CLEAR, not as the v30 format error", () => {
  it("an empty App credentialRef throws a named error, never `credential ref has an invalid format`", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const secrets = new InMemorySecretStore();
    await storeGithubAppCredential(secrets, {
      ref: "credential/github_app/org/o1/default",
      appId: "123456",
      privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    });
    const minter = new GithubAppTokenMinter({ secrets });
    await expect(minter.getInstallationToken({ installationId: "987", credentialRef: "" })).rejects.toThrow(
      "no App credential ref configured",
    );
    await expect(minter.getInstallationToken({ installationId: "987", credentialRef: "" })).rejects.not.toThrow(
      "invalid format",
    );
  });
});
