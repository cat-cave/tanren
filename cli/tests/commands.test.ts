import { describe, expect, it } from "vitest";

describe("cli package", () => {
  it("has a test harness", () => {
    expect(process.version.startsWith("v")).toBe(true);
  });
});
