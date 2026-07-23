// rv-26.6 — the in-process Playwright runner's fail-loud contract. A real
// browser is NOT required to prove the invariant that matters: an invalid request, a
// browser that cannot launch, or a page that cannot be reached ALL return `{ ok: false }`
// — never a fabricated observation. (A full 100-real-click proof runs in the env-gated
// browserClickDriver.e2e.test.ts on a host that can launch chromium.)
import { describe, expect, it } from "vitest";
import { buildPlaywrightBrowserClickRunner } from "../src/engine/verification/acceptance/index.js";

describe("buildPlaywrightBrowserClickRunner — fail-loud, never fabricate", () => {
  it("rejects an invalid click count before launching anything", async () => {
    const runner = buildPlaywrightBrowserClickRunner();
    const result = await runner.runClicks({ url: "http://127.0.0.1:1/", selector: "#x", clicks: 0 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "ok" : result.kind).toBe("click");
  });

  it("fails loud when the browser cannot launch OR the page cannot be reached — no invented clicks", async () => {
    const runner = buildPlaywrightBrowserClickRunner({ launchArgs: ["--no-sandbox"] });
    // 127.0.0.1:1 is a closed port: on an FHS host chromium launches then navigation fails;
    // on a host without launchable chromium the launch itself fails. Either way ⇒ ok:false.
    const result = await runner.runClicks({ url: "http://127.0.0.1:1/", selector: "#x", clicks: 5 });
    expect(result.ok).toBe(false);
    expect(result.ok ? "ok" : result.kind).not.toBe("ok");
  });
});
