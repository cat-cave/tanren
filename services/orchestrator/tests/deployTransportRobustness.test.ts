// §3.9e deploy-path robustness: the production fetch-backed deploy transport + URL
// smoke probe must TIME OUT a hung outbound request (an AbortSignal-bounded fetch) so a
// stuck provider endpoint can never wedge the post-merge deploy path; the Vercel
// `listApps` must FOLLOW pagination so a team with more projects than one page is fully
// listed (else the target app hides behind the page boundary → a spurious deploy
// failure). Driven over an injected fetch — NO live Vercel/Fly/network calls.

import { describe, expect, it } from "vitest";
import { fetchDeployTransport, DEFAULT_DEPLOY_REQUEST_ABORT_MS } from "../src/engine/provisioners/deployTransport.js";
import { fetchUrlReachabilityProbe } from "../src/engine/deploy/buildDeployAdapter.js";
import { VercelDeployProvisioner } from "../src/engine/provisioners/vercelDeployProvisioner.js";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { OrgGrant } from "../src/engine/contracts/integrationProvisioner.js";

// A fetch that NEVER resolves on its own — it only rejects when its AbortSignal fires.
// This proves the transport/probe bounds the request itself (rather than hanging forever).
function hangingFetch(): typeof fetch {
  return ((_url: string | URL | Request, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      }
    })) as unknown as typeof fetch;
}

describe("deploy transport robustness — per-request fetch abort (§3.9e)", () => {
  it("the deploy transport aborts a hung request (it does not hang forever)", async () => {
    // A 5ms per-request abort window so the test resolves instantly; the default is larger.
    const transport = fetchDeployTransport(hangingFetch(), 5);
    await expect(
      transport.request({ method: "GET", url: "https://api.vercel.com/v9/projects", headers: {} }),
    ).rejects.toThrow(/aborted after 5ms/u);
  });

  it("the URL smoke probe aborts a hung GET (it does not hang forever)", async () => {
    const probe = fetchUrlReachabilityProbe(hangingFetch(), 5);
    await expect(probe.probe("https://app.example")).rejects.toThrow(/aborted after 5ms/u);
  });

  it("exposes a non-zero default per-request abort window (a real bound, not unbounded)", () => {
    expect(DEFAULT_DEPLOY_REQUEST_ABORT_MS).toBeGreaterThan(0);
  });
});

describe("Vercel listApps pagination (§3.9e)", () => {
  it("follows pagination.next across pages so a later-page app is found", async () => {
    const TOKEN_REF = "secret://org/deploy-token";
    const store = new InMemorySecretStore();
    void store.put({ ref: TOKEN_REF, value: "vercel_token" });
    const grant: OrgGrant = { providerKind: "deploy.vercel", credentialRef: TOKEN_REF, metadata: {} };

    // Page 1 returns one project + a `next` token; page 2 (fetched via `from=tok2`)
    // returns the TARGET project and terminates pagination (`next: null`).
    const urls: string[] = [];
    const pagedFetch = ((url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      const body = u.includes("from=tok2")
        ? { projects: [{ id: "prj_target", name: "target-app" }], pagination: { next: null } }
        : { projects: [{ id: "prj_1", name: "first-app" }], pagination: { next: "tok2" } };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    }) as unknown as typeof fetch;

    const prov = new VercelDeployProvisioner({ transport: fetchDeployTransport(pagedFetch), secrets: store });
    // `discover` lists all apps via the paginated listApps; the target on page 2 must appear.
    const discovered = await prov.discover(grant);
    expect(discovered.map((r) => r.label)).toContain("target-app");
    // Two pages were fetched (the second via the continuation token).
    expect(urls.some((u) => u.includes("from=tok2"))).toBe(true);
  });
});
