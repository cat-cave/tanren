import { describe, expect, it } from "vitest";
import { setStreamState } from "../src/client/runStream.js";

function rootWithFlag() {
  const flag = {
    textContent: "",
    title: "",
    removeAttribute(name: string) {
      if (name === "title") this.title = "";
    },
  };
  const root = {
    querySelector: (selector: string) => (selector === '[data-rd="live-flag"]' ? flag : null),
  };
  return { root: root as unknown as HTMLElement, flag };
}

describe("run stream client status", () => {
  it("marks the live flag stale or unavailable, then clears it on a valid frame", () => {
    const { root, flag } = rootWithFlag();
    setStreamState(root, "stale", "Malformed frame");
    expect(flag.textContent).toBe("⚠ stream stale");
    expect(flag.title).toBe("Malformed frame");

    setStreamState(root, "unavailable", "Disconnected");
    expect(flag.textContent).toBe("⚠ stream unavailable");
    expect(flag.title).toBe("Disconnected");

    setStreamState(root, "live");
    expect(flag.textContent).toBe("↻ live");
    expect(flag.title).toBe("");
  });
});
