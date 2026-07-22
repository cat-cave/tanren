// rv-26.6 — the podman click runner's fail-loud contract, exercised against a
// STUB `podman` executable (no real container/browser needed). It proves the REAL
// production runner code path — execFile, temp-dir params handoff, result.json parse, and
// the EXACT count enforcement — returns a real count on success and FAILS LOUD (never a
// short/fabricated count) on a non-zero exit, a missing result, or a short observed count.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPodmanBrowserClickRunner } from "../src/engine/verification/acceptance/index.js";

// A stub that impersonates `podman run ... -v <hostdir>:/work:Z <mode> node /app/clickDriver.mjs`.
// It reads the mount dir + the `<mode>` (passed in the image slot) and simulates the container.
const STUB = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const vIdx = args.indexOf("-v");
const hostdir = args[vIdx + 1].split(":")[0];
const mode = args[vIdx + 2];
const params = JSON.parse(readFileSync(join(hostdir, "params.json"), "utf8"));
if (mode === "exit_nonzero") process.exit(7);
if (mode === "no_result") process.exit(0);
const observed = mode === "short" ? params.clicks - 1 : params.clicks;
writeFileSync(join(hostdir, "result.json"), JSON.stringify({ observed }));
`;

let dir: string;
let stubPath: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rv266-podman-stub-"));
  stubPath = join(dir, "podman-stub.mjs");
  await writeFile(stubPath, STUB, "utf8");
  await chmod(stubPath, 0o755);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("buildPodmanBrowserClickRunner — real execFile handoff, exact-count fail-closed", () => {
  it("DECISIVE: a container reporting all clicks confirmed ⇒ ok with exactly N observations", async () => {
    const runner = buildPodmanBrowserClickRunner({ podmanBin: stubPath, image: "success" });
    const result = await runner.runClicks({ url: "http://fixture", selector: "#send", clicks: 100 });
    expect(result.ok).toBe(true);
    expect(result.ok ? result.observations.length : -1).toBe(100);
  });

  it("NEGATIVE CONTROL: a non-zero container exit ⇒ ok:false(launch), no fabricated count", async () => {
    const runner = buildPodmanBrowserClickRunner({ podmanBin: stubPath, image: "exit_nonzero" });
    const result = await runner.runClicks({ url: "http://fixture", selector: "#send", clicks: 100 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "ok" : result.kind).toBe("launch");
  });

  it("NEGATIVE CONTROL: exit 0 but NO result.json ⇒ ok:false(click), never a blank pass", async () => {
    const runner = buildPodmanBrowserClickRunner({ podmanBin: stubPath, image: "no_result" });
    const result = await runner.runClicks({ url: "http://fixture", selector: "#send", clicks: 100 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "ok" : result.kind).toBe("click");
  });

  it("NEGATIVE CONTROL: a SHORT observed count ⇒ ok:false, exact-count guard fires", async () => {
    const runner = buildPodmanBrowserClickRunner({ podmanBin: stubPath, image: "short" });
    const result = await runner.runClicks({ url: "http://fixture", selector: "#send", clicks: 100 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.reason).toMatch(/observed 99 clicks but requested 100/u);
  });

  it("NEGATIVE CONTROL: an invalid click count is rejected before any spawn", async () => {
    const runner = buildPodmanBrowserClickRunner({ podmanBin: stubPath, image: "success" });
    const result = await runner.runClicks({ url: "http://fixture", selector: "#send", clicks: 0 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "ok" : result.kind).toBe("click");
  });
});
