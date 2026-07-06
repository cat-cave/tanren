// Vercel project-list pager (audit lane C3 F1): the pager MUST list a team with
// >100 projects (the prior `VERCEL_MAX_PROJECT_PAGES = 100` cap was a disguised loop
// cap per the timeout-eradication doctrine — a Vercel team with >100 projects would
// spuriously fail there). The pager now drives `retryUntilConverged` over the
// pagination cursor: cursor advancing = progress; a repeated cursor across attempts =
// a proven fixed point (a stuck provider) → LOUD structured error naming the cursor.
//
// This is a focused unit spec against a hand-rolled `DeployHttpTransport` that
// models cursor pagination (the shared `scriptedDeployTransport` fixture only emits a
// single page). It stays out of the 500-line-capped `deployProvisioner.test.ts`.

import { describe, expect, it } from "vitest";
import { InMemorySecretStore } from "../src/engine/contracts/secretStore.js";
import type { OrgGrant } from "../src/engine/contracts/integrationProvisioner.js";
import type {
  DeployHttpRequest,
  DeployHttpResponse,
  DeployHttpTransport,
} from "../src/engine/provisioners/deployTransport.js";
import { VercelDeployProvisioner } from "../src/engine/provisioners/vercelDeployProvisioner.js";

const TOKEN_REF = "secret://org/deploy-token";
const TOKEN_VALUE = "vercel_super_secret_token";

function secrets(): InMemorySecretStore {
  const store = new InMemorySecretStore();
  void store.put({ ref: TOKEN_REF, value: TOKEN_VALUE });
  return store;
}

const grant: OrgGrant = {
  providerKind: "deploy.vercel",
  credentialRef: TOKEN_REF,
  metadata: { teamId: "team_abc", slug: "acme" },
};

/** Parse the `from` cursor out of a project-list URL (undefined = the first page). */
function parseFrom(url: string): string | undefined {
  const query = url.split("?")[1] ?? "";
  for (const part of query.split("&")) {
    const [key, value] = part.split("=");
    if (key === "from" && value !== undefined) return decodeURIComponent(value);
  }
  return undefined;
}

/**
 * A hand-rolled paginated transport for the project-list endpoint. Every non-list
 * request is not modelled (this fixture is scoped to pagination shape). `nextByFrom`
 * maps the request's `from` cursor to the response's `pagination.next` — control the
 * pager's convergence signal by choosing the mapping (advancing = a fresh cursor per
 * page, stuck = the same cursor echoed forever).
 */
function paginatedListTransport(
  pages: Array<{ ids: string[]; from: string | undefined; next: string | number | null }>,
): { transport: DeployHttpTransport; calls: number } {
  const state = { calls: 0 };
  const transport: DeployHttpTransport = {
    async request(req: DeployHttpRequest): Promise<DeployHttpResponse> {
      state.calls += 1;
      if (req.method !== "GET" || !req.url.includes("/v9/projects")) {
        return { status: 405, ok: false, json: undefined, text: "not modelled" };
      }
      const from = parseFrom(req.url);
      const page = pages.find((candidate) => candidate.from === from);
      if (page === undefined) {
        // Unknown `from` → 404 so a misconfigured test fails LOUD rather than looping.
        return { status: 404, ok: false, json: undefined, text: `no page for from='${from ?? "<start>"}'` };
      }
      return {
        status: 200,
        ok: true,
        json: {
          projects: page.ids.map((id) => ({ id, name: id })),
          pagination: { next: page.next },
        },
        text: "",
      };
    },
  };
  return { transport, calls: state.calls };
}

describe("VercelDeployProvisioner pager (audit C3 F1 — retryUntilConverged over the cursor)", () => {
  it("lists a team with 150 pages of projects (the old MAX_PROJECT_PAGES=100 cap would have spuriously failed here)", async () => {
    // Build 150 pages of one project each. `from` advances `c0 → c1 → … → c149`; the
    // last page returns `next: null` (real end-of-list). Under the old cap this would
    // have thrown after page 100; under the progress-based pager, it fully lists.
    const pageCount = 150;
    const pages = Array.from({ length: pageCount }, (_, i) => {
      const from = i === 0 ? undefined : `c${String(i - 1)}`;
      const next = i === pageCount - 1 ? null : `c${String(i)}`;
      return { ids: [`prj_${String(i)}`], from, next };
    });
    const { transport } = paginatedListTransport(pages);
    // Provisioner needs at least the list flow — `discover()` calls `listApps`.
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    const discovered = await prov.discover(grant);
    expect(discovered).toHaveLength(pageCount);
    expect(discovered.map((r) => r.label)).toEqual(pages.map((p) => p.ids[0]));
  });

  it("terminates on a genuine end-of-list (next=null / next=undefined / next='')", async () => {
    // Three back-to-back scenarios, each covering one of the "terminal cursor" shapes
    // the pager treats as end-of-list. Each independent instance verifies the pager
    // returns without calling more pages than the fixture defines.
    for (const terminal of [null, undefined, ""] as const) {
      const { transport } = paginatedListTransport([{ ids: ["p0"], from: undefined, next: terminal }]);
      const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
      const discovered = await prov.discover(grant);
      expect(discovered).toHaveLength(1);
      expect(discovered[0]?.label).toBe("p0");
    }
  });

  it("throws a STRUCTURED stuck-cursor error when the provider echoes the same `next` twice (proven fixed point)", async () => {
    // The stuck-provider shape: after the first page, EVERY subsequent request returns
    // `next: "cur1"` — the cursor never advances. `retryUntilConverged` sees the same
    // workSignature twice in a row → `reproducedIdenticalWork` = fixed point → the
    // fixed-point rule judgment escalates with the stuck cursor as evidence.
    const pages = [
      { ids: ["p0"], from: undefined, next: "cur1" as string | number | null },
      // Every request from cur1 returns cur1 again — the pathological pager the doctrine
      // is written to catch.
      { ids: ["p1"], from: "cur1", next: "cur1" as string | number | null },
    ];
    const { transport } = paginatedListTransport(pages);
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    await expect(prov.discover(grant)).rejects.toThrow(/cur1/u);
    await expect(prov.discover(grant)).rejects.toThrow(/did not advance|stuck/u);
  });

  it("propagates a non-2xx page fetch as a LOUD failure (never a silent 'ended pagination')", async () => {
    // A 500 mid-pagination must throw the raw provider status — never treated as a
    // terminal empty page (that would silently truncate the list).
    const transport: DeployHttpTransport = {
      async request(): Promise<DeployHttpResponse> {
        return { status: 500, ok: false, json: undefined, text: "internal server error" };
      },
    };
    const prov = new VercelDeployProvisioner({ transport, secrets: secrets() });
    await expect(prov.discover(grant)).rejects.toThrow(/vercel list projects failed: 500/u);
  });
});
