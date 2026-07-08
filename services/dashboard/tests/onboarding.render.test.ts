// onboarding / credentials / notifications render + flow tests.
// Mirrors the shell.render.test.ts harness: build the dashboard app with a
// stubbed pool + a mocked orchestrator (global fetch), then assert rendered
// HTML and the POST proxy behavior. No live orchestrator / DB.

import type pg from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/main.js";

const ORG = {
  id: "org_acme",
  kind: "github_org",
  login: "cat-cave",
  displayName: "Cat Cave",
  role: "org:admin",
};

interface MockState {
  credentialImports: Array<{ url: string; body: unknown }>;
  targetCreates: unknown[];
  targetUpdates: Array<{ url: string; body: unknown }>;
  projectCreates: unknown[];
  brownfieldLinks: unknown[];
  brownfieldOk: boolean;
}

function stubPool(): pg.Pool {
  return { query: async () => ({ rows: [{ ok: 1 }], rowCount: 1 }) } as unknown as pg.Pool;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

const DOCTOR_OK = {
  ok: true,
  generatedAt: "2026-05-28T00:00:00Z",
  checks: [
    { name: "postgres", status: "ok", detail: "SELECT 1 returned", latencyMs: 2 },
    { name: "vault", status: "ok", detail: "vault status 200", latencyMs: 5 },
  ],
};

const DOCTOR_FAIL = {
  ok: false,
  generatedAt: "2026-05-28T00:00:00Z",
  checks: [
    { name: "postgres", status: "ok", detail: "ok", latencyMs: 2 },
    { name: "vault", status: "fail", detail: "sealed", latencyMs: 5 },
  ],
};

function mockOrchestrator(opts: { doctor?: unknown; matrix?: unknown; deliveries?: unknown } = {}): MockState {
  const state: MockState = {
    credentialImports: [],
    targetCreates: [],
    targetUpdates: [],
    projectCreates: [],
    brownfieldLinks: [],
    brownfieldOk: true,
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const json = jsonResponse;
    if (url.endsWith("/auth/me")) return json({ userId: "u1", csrfToken: "c", expiresAt: "2030-01-01" });
    if (url.endsWith("/orgs")) return json({ orgs: [ORG] });
    if (url.endsWith("/doctor")) return json(opts.doctor ?? DOCTOR_OK);
    if (url.includes("/notifications/matrix")) {
      return json(
        opts.matrix ?? {
          targets: [],
          routes: [],
          events: [{ eventName: "run.failed", defaultSeverity: "fail" }],
        },
      );
    }
    if (url.includes("/notifications/deliveries")) {
      return json({
        deliveries: opts.deliveries ?? [
          {
            id: 1,
            orgId: "org_acme",
            channel: "ntfy",
            status: "sent",
            attempts: 1,
            enqueuedAt: "2026-05-28T14:00:00.000Z",
            sentAt: "2026-05-28T14:00:01.000Z",
            eventName: "run.failed",
            targetId: "target_1",
            severity: "fail",
            title: "Run failed",
            reason: "native gate failed",
            layering: "org",
            target: { id: "target_1", channelKind: "ntfy", label: "ops-alerts" },
          },
        ],
      });
    }
    if (url.includes("/notifications/targets") && method === "PATCH") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      state.targetUpdates.push({ url, body });
      return json({ id: "notif_target_1", weekendMute: true, enabled: true, ...body });
    }
    if (url.includes("/notifications/targets") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      state.targetCreates.push(body);
      return json({ id: "notif_target_1", ...body }, 201);
    }
    if (url.includes("/notifications/routes") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return json({ id: "notif_route_1", ...body }, 201);
    }
    if (url.includes("/credentials") && method === "POST") {
      state.credentialImports.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
      return json({ ref: "credential/x", redacted: true }, 201);
    }
    if (url.includes("/credentials/me")) {
      return json({
        credentials: [
          {
            ref: "credential/codex_chatgpt_auth/me/auth",
            kind: "codex_chatgpt_auth",
            scope: "me",
            ownerId: "u1",
            createdAt: "2026-05-28",
          },
        ],
      });
    }
    if (url.includes("/credentials")) return json({ credentials: [] });
    if (url.match(/\/projects$/u) && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      state.projectCreates.push(body);
      return json({ projectId: "project_easy", ...body }, 201);
    }
    if (url.includes("/projects/") && url.endsWith("/link") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      state.brownfieldLinks.push(body);
      if (!state.brownfieldOk) return json({ error: "repo_not_reachable", message: "cannot see repo" }, 404);
      return json({
        projectId: "project_easy",
        repoUrl: body.repoUrl,
        orgId: "org_acme",
        detectedFiles: [{ path: "CODEOWNERS", present: true, size: 12 }],
        writesPerformed: 0,
      });
    }
    // full-track recon (read-only Answerer pre-fill).
    if (url.endsWith("/recon") && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return json({
        repoUrl: body.repoUrl,
        filesIndexed: 84,
        report: {
          identity: {
            slug: "tanren-fixture-easy",
            purpose: "smoke fixture",
            inferredFrom: "README.md",
          },
          personas: [
            {
              name: "developer · maintainer",
              description: "maintains the codebase",
              inferredFrom: "code",
            },
          ],
          behaviors: [{ persona: "developer · maintainer", title: "build & test", inferredFrom: "ci" }],
          architecture: [{ layer: "ci", detail: "github actions" }],
          risks: [{ severity: "warn", note: "no CODEOWNERS file" }],
          gaps: [
            {
              id: "design-dna",
              chapter: "design dna",
              question: "default to industrial?",
              options: ["use industrial"],
            },
          ],
        },
      });
    }
    if (url.includes("/projects")) return json({ projects: [] });
    if (url.endsWith("/healthz")) return new Response("ok", { status: 200 });
    return new Response("not found", { status: 404 });
  });
  return state;
}

beforeEach(() => {
  delete process.env.TANREN_REQUIRE_AUTH;
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function build() {
  return createApp({ pool: stubPool(), skipMigrate: true });
}

describe("org-setup wizard", () => {
  it("step 1 renders the github scope list + live /doctor stack health", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/onboarding/org?step=1")).text();
    expect(html).toContain("give tanren access");
    expect(html).toContain("what tanren will ask for");
    expect(html).toContain("never · push directly to default branches");
    expect(html).toContain("stack");
    expect(html).toContain("postgres · SELECT 1 returned");
    expect(html).toContain("open github ↗");
  });

  it("step 1 surfaces operator actions when a /doctor check fails", async () => {
    mockOrchestrator({ doctor: DOCTOR_FAIL });
    const app = await build();
    const html = await (await app.request("/onboarding/org?step=1")).text();
    expect(html).toContain("need attention");
    expect(html).toContain("unseal Vault");
  });

  it("step 2 renders the two-column credentials forms (write-only, redaction note)", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/onboarding/org?step=2")).text();
    expect(html).toContain("org · ");
    expect(html).toContain("add api key");
    expect(html).toContain("import codex chatgpt bundle");
    expect(html).toContain('type="password"');
    expect(html).toContain("never re-shown");
  });

  it("step 3 renders the notifications matrix with all channels wired", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/onboarding/org?step=3")).text();
    expect(html).toContain("run.failed");
    expect(html).toContain("all channel kinds dispatch");
    // ntfy is a wired channel
    expect(html).toContain("phase-v0");
  });

  it("step 4 shows local-docker active + cloud allocators as phase-badged stubs", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/onboarding/org?step=4")).text();
    expect(html).toContain("local");
    expect(html).toContain("active default");
    expect(html).toContain("hetzner cloud");
    expect(html).toContain("phase 4+");
    expect(html).toContain("org is forged");
  });
});

describe("notifications matrix", () => {
  it("renders all nine channels with phase badges, all marked wired", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/notifications")).text();
    for (const channel of ["ntfy", "slack", "microsoft teams", "pagerduty", "webhook · custom"]) {
      expect(html).toContain(channel);
    }
    // All channels now dispatch once their credentials are configured.
    expect(html).toContain("all channel kinds dispatch");
    expect(html).not.toContain("configured but not yet wired");
  });

  it("renders recent notification delivery history from the org ledger", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/notifications")).text();
    expect(html).toContain("delivery <em>history</em>");
    expect(html).toContain("Run failed");
    expect(html).toContain("ops-alerts");
    expect(html).toContain("native gate failed");
    expect(html).toContain("sent");
  });

  it("add-target form POST proxies to the orchestrator", async () => {
    const state = mockOrchestrator();
    const app = await build();
    const res = await app.request("/notifications/targets", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "label=alerts&destination=https://ntfy.sh/cat-cave&channelKind=ntfy",
    });
    expect(res.status).toBe(303);
    expect(state.targetCreates).toHaveLength(1);
    expect(state.targetCreates[0]).toMatchObject({
      channelKind: "ntfy",
      destination: "https://ntfy.sh/cat-cave",
      weekendMute: false,
    });
  });

  it("add-target form forwards weekendMute when the checkbox is checked", async () => {
    const state = mockOrchestrator();
    const app = await build();
    const res = await app.request("/notifications/targets", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "label=quiet&destination=https://ntfy.sh/quiet&channelKind=ntfy&weekendMute=true",
    });
    expect(res.status).toBe(303);
    expect(state.targetCreates).toHaveLength(1);
    expect(state.targetCreates[0]).toMatchObject({ weekendMute: true, label: "quiet" });
  });

  it("renders quiet-hours controls and live weekend-mute state per target", async () => {
    mockOrchestrator({
      matrix: {
        targets: [
          {
            id: "target_muted",
            orgId: "org_acme",
            scope: "org",
            userId: null,
            channelKind: "ntfy",
            destination: "https://ntfy.sh/muted",
            label: "ops-muted",
            enabled: true,
            weekendMute: true,
          },
          {
            id: "target_open",
            orgId: "org_acme",
            scope: "org",
            userId: null,
            channelKind: "slack",
            destination: "#ops",
            label: "ops-open",
            enabled: true,
            weekendMute: false,
          },
        ],
        routes: [],
        events: [{ eventName: "run.failed", defaultSeverity: "fail" }],
      },
    });
    const app = await build();
    const html = await (await app.request("/notifications")).text();
    expect(html).toContain('data-notif-quiet-hours="1"');
    expect(html).toContain('name="weekendMute"');
    expect(html).toContain('data-notif-create-weekend-mute="1"');
    expect(html).toContain("1 target mute non-critical delivery on weekends");
    expect(html).toContain("ops-muted");
    expect(html).toContain("ops-open");
    expect(html).toContain("muted weekends");
    expect(html).toContain("delivers weekends");
    expect(html).toContain('action="/notifications/targets/update"');
    expect(html).toContain("unmute weekends");
    expect(html).toContain("mute weekends");
  });

  it("quiet-hours toggle POST proxies PATCH weekendMute to the orchestrator", async () => {
    const state = mockOrchestrator();
    const app = await build();
    const res = await app.request("/notifications/targets/update", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "targetId=target_open&weekendMute=true",
    });
    expect(res.status).toBe(303);
    expect(state.targetUpdates).toHaveLength(1);
    expect(state.targetUpdates[0]?.url).toContain("/notifications/targets/target_open");
    expect(state.targetUpdates[0]?.body).toEqual({ weekendMute: true });
  });
});

describe("credentials", () => {
  it("never renders a credential value after entry", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/onboarding/credentials")).text();
    expect(html).toContain("api keys and");
    expect(html).toContain("write-only");
    expect(html).not.toContain("sk-live");
    // An existing credential row renders its ref + a redaction note, never a value.
    expect(html).toContain("codex chatgpt bundle");
    expect(html).toContain("redacted · never shown");
  });

  it("codex import POST forwards the auth.json write-only to the orchestrator", async () => {
    const state = mockOrchestrator();
    const app = await build();
    const res = await app.request("/onboarding/credentials/dev/codex", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "ref=credential/codex_chatgpt_auth/me/auth&authJson=" + encodeURIComponent('{"token":"x"}'),
    });
    expect(res.status).toBe(303);
    expect(state.credentialImports).toHaveLength(1);
    expect(state.credentialImports[0]?.url).toContain("kind=codex_chatgpt_auth");
  });

  it("renders the github token import form (write-only) in the org column", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/onboarding/credentials")).text();
    expect(html).toContain("import github token");
    expect(html).toContain('action="/onboarding/credentials/github"');
  });

  it("github import POST forwards the token org-scoped + write-only", async () => {
    const state = mockOrchestrator();
    const app = await build();
    const res = await app.request("/onboarding/credentials/github", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "label=tanren-bot&token=ghp_secret",
    });
    expect(res.status).toBe(303);
    expect(state.credentialImports).toHaveLength(1);
    expect(state.credentialImports[0]?.url).toContain("kind=github_token");
    expect(state.credentialImports[0]?.url).toContain("/orgs/org_acme/credentials");
    const body = state.credentialImports[0]?.body as { ref: string; token: string };
    expect(body.ref).toBe("credential/github/org/org_acme/tanren-bot");
    expect(body.token).toBe("ghp_secret");
  });
});

describe("existing-project full track (P3-0016)", () => {
  it("renders the 5-step brownfield shell on the link step", async () => {
    mockOrchestrator();
    const app = await build();
    const html = await (await app.request("/onboarding/existing")).text();
    expect(html).toContain('data-screen="onboarding-existing-full"');
    expect(html).toContain("point at");
    expect(html).toContain("existing project · brownfield");
    expect(html).toContain("never push to main");
  });

  it("link POST creates the project, calls brownfield link, then runs recon → step 2", async () => {
    const state = mockOrchestrator();
    const app = await build();
    const res = await app.request("/onboarding/existing/link", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body:
        "repoUrl=" +
        encodeURIComponent("https://github.com/cat-cave/tanren-fixture-easy") +
        "&name=tanren-fixture-easy",
    });
    const html = await res.text();
    expect(state.projectCreates).toHaveLength(1);
    expect(state.brownfieldLinks).toHaveLength(1);
    // Advances into the recon step with the pre-filled chapters + gaps.
    expect(html).toContain("knows most of it");
    expect(html).toContain("indexed 84 files");
    expect(html).toContain("no CODEOWNERS file");
  });

  it("link POST surfaces a clear error when the repo is not reachable", async () => {
    const state = mockOrchestrator();
    state.brownfieldOk = false;
    const app = await build();
    const res = await app.request("/onboarding/existing/link", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "repoUrl=" + encodeURIComponent("https://github.com/cat-cave/missing") + "&name=missing",
    });
    const html = await res.text();
    expect(html).toContain("cannot see repo");
  });
});
