import { describe, expect, it } from "vitest";
import { isFinalStreamState, markStreamUnavailableUnlessFinal, setStreamState } from "../src/client/runStream.js";

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

  it("preserves final stream state when EventSource reports normal terminal close", () => {
    const { root, flag } = rootWithFlag();
    flag.textContent = "● final";
    expect(isFinalStreamState(root)).toBe(true);

    markStreamUnavailableUnlessFinal(root, "Disconnected");
    expect(flag.textContent).toBe("● final");
    expect(flag.title).toBe("");
  });

  it("marks non-final stream state unavailable on EventSource errors", () => {
    const { root, flag } = rootWithFlag();
    markStreamUnavailableUnlessFinal(root, "Disconnected");
    expect(flag.textContent).toBe("⚠ stream unavailable");
    expect(flag.title).toBe("Disconnected");
    expect(isFinalStreamState(root)).toBe(false);
  });

  it("keeps final across later snapshot/cost/status/task live or stale frames", () => {
    const { root, flag } = rootWithFlag();
    setStreamState(root, "final");
    expect(flag.textContent).toBe("● final");

    // Post-terminal grace frames and reconnect noise must not demote final.
    setStreamState(root, "live");
    expect(flag.textContent).toBe("● final");
    setStreamState(root, "stale", "Malformed costs frame from the live stream.");
    expect(flag.textContent).toBe("● final");
    expect(flag.title).toBe("");
    setStreamState(root, "unavailable", "reconnect");
    expect(flag.textContent).toBe("● final");
    markStreamUnavailableUnlessFinal(root, "reconnect after terminal EOF");
    expect(flag.textContent).toBe("● final");
  });

  it("setStreamState(final) is sticky and idempotent", () => {
    const { root, flag } = rootWithFlag();
    setStreamState(root, "live");
    setStreamState(root, "final");
    setStreamState(root, "final");
    expect(isFinalStreamState(root)).toBe(true);
    expect(flag.textContent).toBe("● final");
  });
});
