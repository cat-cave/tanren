// Coverage for the non-web DemoEngine EXERCISE ARMS (Bug 1, Codex H3 #23): the
// `package`, `download`, and `app_channel` surface arms — each now producing REAL
// per-behavior evidence, never the old "not implemented" throw. Driven over scripted
// probes (no live registry / HTTP / channel) + a recording event store (no Postgres).

import { describe, expect, it } from "vitest";
import { getJobOrgId } from "@tanren/db";
import { DemoEngine, type DemoBehavior } from "../src/engine/demo/demoEngine.js";
import type { DemoWebProbe, BehaviorEvidence } from "../src/engine/demo/demoEvidence.js";
import {
  type DemoPackageProbe,
  exercisePackageBehavior,
  fetchDemoPackageProbe,
  parsePackageCoordinate,
  registryMetadataUrl,
} from "../src/engine/demo/demoPackageArm.js";
import {
  type DemoDownloadProbe,
  exerciseDownloadBehavior,
  fetchDemoDownloadProbe,
  resolveExpectedSha256,
} from "../src/engine/demo/demoDownloadArm.js";
import {
  type DemoAppChannelProbe,
  surfaceDescriptorAppChannelProbe,
  exerciseAppChannelBehavior,
} from "../src/engine/demo/demoAppChannelArm.js";
import type { DemoSurface } from "../src/engine/contracts/deployAdapter.js";
import type { EventStore, AppendEventInput } from "../src/engine/eventStore.js";
import type { EventName } from "../src/engine/events/index.js";
import { createHash } from "node:crypto";

const TARGET = { runId: "run_demo", specId: "spec_demo", projectId: "proj_demo", orgId: "org_demo" };

class RecordingEventStore implements EventStore {
  readonly appends: Array<{ eventType: EventName; payload: Record<string, unknown>; ambientOrgId?: string }> = [];
  // eslint-disable-next-line @typescript-eslint/require-await
  async append<N extends EventName>(input: AppendEventInput<N>): Promise<void> {
    this.appends.push({
      eventType: input.eventType,
      payload: input.payload as Record<string, unknown>,
      ambientOrgId: getJobOrgId(),
    });
  }
}

const stubWebProbe: DemoWebProbe = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async reach(): Promise<number> {
    throw new Error("web probe should not be called on a non-web surface");
  },
};

const behavior = (id: string, title: string, metadata: Record<string, unknown> = {}): DemoBehavior => ({
  behaviorId: id,
  behaviorTitle: title,
  metadata,
});

// Hoisted so oxlint's `unicorn(consistent-function-scoping)` does not flag it as a
// closure recreated per test — this fake never captures test state.
// eslint-disable-next-line @typescript-eslint/require-await
const notFoundFetch: typeof fetch = async () => new Response("nope", { status: 404 });

describe("demoPackageArm — package coordinate registry-metadata resolve", () => {
  it("parses a scoped-npm coordinate — name + version", () => {
    expect(parsePackageCoordinate("@acme/web@1.2.3")).toEqual({ name: "@acme/web", version: "1.2.3" });
    expect(parsePackageCoordinate("acme-web@1.2.3")).toEqual({ name: "acme-web", version: "1.2.3" });
  });

  it("parses a version-less coordinate — name only, empty version", () => {
    expect(parsePackageCoordinate("@acme/web")).toEqual({ name: "@acme/web", version: "" });
    expect(parsePackageCoordinate("acme-web")).toEqual({ name: "acme-web", version: "" });
  });

  it("maps well-known registry names to their documented metadata URLs", () => {
    expect(registryMetadataUrl("npm", "@acme/web@1.2.3")).toBe("https://registry.npmjs.org/%40acme%2Fweb/1.2.3");
    expect(registryMetadataUrl("pypi", "acme_web@1.2.3")).toBe("https://pypi.org/pypi/acme_web/1.2.3/json");
    expect(registryMetadataUrl("crates.io", "acme-web@1.2.3")).toBe("https://crates.io/api/v1/crates/acme-web/1.2.3");
  });

  it("passes an https:// registry base URL through with the coordinate appended", () => {
    expect(registryMetadataUrl("https://registry.example.dev/", "acme@1.0.0")).toBe(
      "https://registry.example.dev/acme/1.0.0",
    );
  });

  it("throws LOUD on an unknown registry — never a silent fabricated URL", () => {
    expect(() => registryMetadataUrl("mystery", "acme@1.0.0")).toThrow(/no known metadata URL convention/u);
  });

  it("records a PASSED evidence for a resolvable coordinate + surfaces a behavior-declared invocation", async () => {
    const events = new RecordingEventStore();
    const probe: DemoPackageProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async resolve({ coordinate, registry }) {
        return { status: 200, url: `https://mock/${registry}/${coordinate}` };
      },
    };
    const engine = new DemoEngine({ events, webProbe: stubWebProbe, packageProbe: probe });
    const surface: DemoSurface = { kind: "package", registry: "npm", coordinate: "@acme/web@1.2.3" };
    const result = await engine.exercise(TARGET, surface, [
      behavior("beh_install", "install the CLI", { invocation: "acme --version" }),
    ]);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
    const evidence = result.evidence[0]!;
    expect(evidence.outcome).toBe("passed");
    expect(evidence.detail).toContain("resolve @acme/web@1.2.3 on npm → HTTP 200");
    expect(evidence.detail).toContain("invocation: acme --version");
    // Summary + evidence events are org-scoped and non-secret.
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "package", behaviorCount: 1, passed: 1, failed: 0 });
  });

  it("records a FAILED evidence for a 404 non-resolvable coordinate (never aborts the demo)", async () => {
    const probe: DemoPackageProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async resolve() {
        return { status: 404, url: "https://mock" };
      },
    };
    const surface: DemoSurface = { kind: "package", registry: "npm", coordinate: "@acme/web@9.9.9" };
    const evidence = await exercisePackageBehavior(probe, surface, behavior("b", "missing"));
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("HTTP 404");
  });

  it("captures a transport failure as FAILED evidence with the error", async () => {
    const probe: DemoPackageProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async resolve() {
        throw new Error("connection refused");
      },
    };
    const surface: DemoSurface = { kind: "package", registry: "npm", coordinate: "@acme/web@1.2.3" };
    const evidence = await exercisePackageBehavior(probe, surface, behavior("b", "unreachable"));
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("unreachable");
    expect(evidence.detail).toContain("connection refused");
  });

  it("production fetchDemoPackageProbe queries the mapped metadata URL", async () => {
    let seenUrl = "";
    const fakeFetch: typeof fetch = async (input) => {
      seenUrl = String(input);
      return new Response("", { status: 200 });
    };
    const probe = fetchDemoPackageProbe(fakeFetch);
    const result = await probe.resolve({ registry: "npm", coordinate: "acme@1.2.3" });
    expect(seenUrl).toBe("https://registry.npmjs.org/acme/1.2.3");
    expect(result.status).toBe(200);
  });
});

describe("demoDownloadArm — HTTP fetch + SHA-256 verification", () => {
  const RAW_URL = "https://releases.example.dev/acme-1.0.0.bin";

  it("passes when the download responds 2xx and no expectation was declared (records observed digest)", async () => {
    const digest = "aa".repeat(32);
    const probe: DemoDownloadProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async fetch() {
        return { status: 200, sha256Hex: digest, sizeBytes: 128 };
      },
    };
    const surface: DemoSurface = { kind: "download", artifactUrl: RAW_URL };
    const evidence = await exerciseDownloadBehavior(probe, surface, behavior("b", "download"));
    expect(evidence.outcome).toBe("passed");
    expect(evidence.detail).toContain(`GET ${RAW_URL} → HTTP 200`);
    expect(evidence.detail).toContain("sha256=aaaaaaaaaaaa…");
    expect(evidence.detail).toContain("size=128B");
  });

  it("passes when the observed SHA-256 matches the behavior's declared expectedSha256", async () => {
    const digest = "bb".repeat(32);
    const probe: DemoDownloadProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async fetch() {
        return { status: 200, sha256Hex: digest, sizeBytes: 42 };
      },
    };
    const surface: DemoSurface = { kind: "download", artifactUrl: RAW_URL };
    const evidence = await exerciseDownloadBehavior(
      probe,
      surface,
      behavior("b", "checksum", { expectedSha256: digest }),
    );
    expect(evidence.outcome).toBe("passed");
    expect(evidence.detail).toContain("SHA-256 matches");
  });

  it("fails on SHA-256 mismatch — the detail names both prefixes, never the full digest", async () => {
    const observed = "cc".repeat(32);
    const expected = "dd".repeat(32);
    const probe: DemoDownloadProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async fetch() {
        return { status: 200, sha256Hex: observed, sizeBytes: 1 };
      },
    };
    const surface: DemoSurface = { kind: "download", artifactUrl: RAW_URL };
    const evidence = await exerciseDownloadBehavior(
      probe,
      surface,
      behavior("b", "mismatch", { expectedSha256: expected }),
    );
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("SHA-256 mismatch");
    expect(evidence.detail).toContain("expected dddddddddddd…");
    expect(evidence.detail).toContain("got cccccccccccc…");
  });

  it("fails a non-2xx download — the detail carries the observed status", async () => {
    const probe: DemoDownloadProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async fetch() {
        return { status: 503, sha256Hex: "", sizeBytes: 0 };
      },
    };
    const surface: DemoSurface = { kind: "download", artifactUrl: RAW_URL };
    const evidence = await exerciseDownloadBehavior(probe, surface, behavior("b", "unavailable"));
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("HTTP 503");
  });

  it("ignores a malformed expectedSha256 (not 64 hex chars) — treats as absent, never a bogus mismatch", () => {
    expect(resolveExpectedSha256({ expectedSha256: "not-a-hash" })).toBe("");
    expect(resolveExpectedSha256({ expectedSha256: "aa".repeat(32) })).toBe("aa".repeat(32));
    // Uppercase hex is normalized to lowercase.
    expect(resolveExpectedSha256({ expectedSha256: "AA".repeat(32) })).toBe("aa".repeat(32));
    expect(resolveExpectedSha256({})).toBe("");
  });

  it("production fetchDemoDownloadProbe streams the body and computes an accurate SHA-256", async () => {
    const body = new TextEncoder().encode("hello world");
    const expected = createHash("sha256").update(body).digest("hex");
    // Wrap the body in a ReadableStream so the probe's stream-hasher path runs.
    const stream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(body);
        controller.close();
      },
    });
    // eslint-disable-next-line @typescript-eslint/require-await
    const fakeFetch: typeof fetch = async () => new Response(stream, { status: 200 });
    const probe = fetchDemoDownloadProbe(fakeFetch);
    const result = await probe.fetch({ url: "https://example.dev/x" });
    expect(result.status).toBe(200);
    expect(result.sha256Hex).toBe(expected);
    expect(result.sizeBytes).toBe(body.byteLength);
  });

  it("production fetchDemoDownloadProbe never consumes the body on non-2xx (returns empty digest)", async () => {
    const probe = fetchDemoDownloadProbe(notFoundFetch);
    const result = await probe.fetch({ url: "https://example.dev/gone" });
    expect(result.status).toBe(404);
    expect(result.sha256Hex).toBe("");
    expect(result.sizeBytes).toBe(0);
  });
});

describe("demoAppChannelArm — presence attestation", () => {
  const SURFACE: DemoSurface = {
    kind: "app_channel",
    platform: "ios",
    track: "testflight",
    buildRef: "build_42",
  };

  it("records a PASSED presence-attested evidence when the probe reports available", async () => {
    const probe: DemoAppChannelProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async presence() {
        return { available: true, state: "available", channelHandle: "https://testflight.apple.com/x" };
      },
    };
    const evidence = await exerciseAppChannelBehavior(probe, SURFACE, behavior("b", "installable"));
    expect(evidence.outcome).toBe("passed");
    expect(evidence.detail).toContain("presence attested on ios/testflight/build_42");
    expect(evidence.detail).toContain("handle: https://testflight.apple.com/x");
  });

  it("records FAILED evidence when the channel reports the build is NOT present", async () => {
    const probe: DemoAppChannelProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async presence() {
        return { available: false, state: "expired", channelHandle: "" };
      },
    };
    const evidence = await exerciseAppChannelBehavior(probe, SURFACE, behavior("b", "expired"));
    expect(evidence.outcome).toBe("failed");
    expect(evidence.detail).toContain("presence NOT attested");
    expect(evidence.detail).toContain("expired");
  });

  it("surfaceDescriptorAppChannelProbe attests presence from a non-empty buildRef", async () => {
    const probe = surfaceDescriptorAppChannelProbe();
    const result = await probe.presence({ platform: "ios", track: "testflight", buildRef: "build_1" });
    expect(result.available).toBe(true);
    expect(result.state).toBe("attested");
  });

  it("surfaceDescriptorAppChannelProbe reports not-available for an empty buildRef (belt-and-braces)", async () => {
    const probe = surfaceDescriptorAppChannelProbe();
    const result = await probe.presence({ platform: "ios", track: "testflight", buildRef: "" });
    expect(result.available).toBe(false);
    expect(result.state).toBe("no_build_ref");
  });
});

describe("DemoEngine — dispatch across ALL four surface kinds (Codex H3 #23)", () => {
  it("routes a package surface to the packageProbe + records demo.completed with kind='package'", async () => {
    const events = new RecordingEventStore();
    const packageProbe: DemoPackageProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async resolve() {
        return { status: 200, url: "https://mock" };
      },
    };
    const engine = new DemoEngine({ events, webProbe: stubWebProbe, packageProbe });
    const surface: DemoSurface = { kind: "package", registry: "npm", coordinate: "@a/b@1.0.0" };
    await engine.exercise(TARGET, surface, [behavior("b", "install")]);
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "package", passed: 1 });
  });

  it("routes a download surface to the downloadProbe + records demo.completed with kind='download'", async () => {
    const events = new RecordingEventStore();
    const downloadProbe: DemoDownloadProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async fetch() {
        return { status: 200, sha256Hex: "aa".repeat(32), sizeBytes: 4 };
      },
    };
    const engine = new DemoEngine({ events, webProbe: stubWebProbe, downloadProbe });
    const surface: DemoSurface = { kind: "download", artifactUrl: "https://example.dev/x.bin" };
    await engine.exercise(TARGET, surface, [behavior("b", "download")]);
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "download", passed: 1 });
  });

  it("routes an app_channel surface to the appChannelProbe + records demo.completed with kind='app_channel'", async () => {
    const events = new RecordingEventStore();
    const appChannelProbe: DemoAppChannelProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async presence() {
        return { available: true, state: "available", channelHandle: "" };
      },
    };
    const engine = new DemoEngine({ events, webProbe: stubWebProbe, appChannelProbe });
    const surface: DemoSurface = {
      kind: "app_channel",
      platform: "android",
      track: "internal",
      buildRef: "b1",
    };
    await engine.exercise(TARGET, surface, [behavior("b", "installable")]);
    const summary = events.appends.find((a) => a.eventType === "demo.completed");
    expect(summary!.payload).toMatchObject({ surfaceKind: "app_channel", passed: 1 });
  });

  it("throws a LOUD DemoProbeMissingError when a surface arm's probe is not wired", async () => {
    const events = new RecordingEventStore();
    // packageProbe intentionally omitted — the engine should reject the exercise.
    const engine = new DemoEngine({ events, webProbe: stubWebProbe });
    const surface: DemoSurface = { kind: "package", registry: "npm", coordinate: "@a/b@1.0.0" };
    await expect(engine.exercise(TARGET, surface, [behavior("b", "install")])).rejects.toThrow(
      /probe for surface kind 'package' is not wired/u,
    );
  });

  // Regression pin for the shape auditors have been diagnosing: any non-secret-looking
  // payload that leaks through the observed detail (a token / bearer / raw response body).
  it("keeps evidence detail non-secret — no token/bearer/response body ever leaks", async () => {
    const events = new RecordingEventStore();
    const packageProbe: DemoPackageProbe = {
      // eslint-disable-next-line @typescript-eslint/require-await
      async resolve() {
        return { status: 200, url: "https://mock" };
      },
    };
    const surface: DemoSurface = { kind: "package", registry: "npm", coordinate: "@a/b@1.0.0" };
    const engine = new DemoEngine({ events, webProbe: stubWebProbe, packageProbe });
    await engine.exercise(TARGET, surface, [behavior("b", "install")]);
    expect(JSON.stringify(events.appends)).not.toMatch(/token|secret|bearer/iu);
  });
});

// Regression pin: BehaviorEvidence's shape is stable across the new arms (the
// demo.evidence.recorded payload schema depends on it).
describe("BehaviorEvidence shape stability across arms", () => {
  it("carries { behaviorId, behaviorTitle, surfaceKind, outcome, detail } for every kind", () => {
    const evidences: BehaviorEvidence[] = [
      { behaviorId: "a", behaviorTitle: "A", surfaceKind: "web_url", outcome: "passed", detail: "" },
      { behaviorId: "b", behaviorTitle: "B", surfaceKind: "package", outcome: "passed", detail: "" },
      { behaviorId: "c", behaviorTitle: "C", surfaceKind: "download", outcome: "passed", detail: "" },
      { behaviorId: "d", behaviorTitle: "D", surfaceKind: "app_channel", outcome: "passed", detail: "" },
    ];
    for (const e of evidences) {
      expect(Object.keys(e).sort()).toEqual(["behaviorId", "behaviorTitle", "detail", "outcome", "surfaceKind"]);
    }
  });
});
