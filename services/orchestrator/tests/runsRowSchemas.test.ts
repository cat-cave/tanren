// Trust-at-boundary pg-row schema tests (audit RC-6). Proves the run-detail read
// seam DECODES raw pg rows rather than type-laundering them: a well-formed row
// yields real Date objects, and a malformed row (bad timestamp / missing
// required field) THROWS at the parse boundary instead of laundering garbage
// past `as Date`.

import { describe, expect, it } from "vitest";
import {
  RawCostRowSchema,
  RawEventRowSchema,
  RawRunSummaryRowSchema,
  RawTaskRowSchema,
} from "../src/routes/runs/rowSchemas.js";

describe("run-detail pg-row schemas (RC-6 trust-at-boundary)", () => {
  describe("RawRunSummaryRowSchema", () => {
    it("decodes a well-formed row to real Dates (Date input)", () => {
      const started = new Date("2026-01-01T00:00:00.000Z");
      const ended = new Date("2026-01-01T01:00:00.000Z");
      const decoded = RawRunSummaryRowSchema.parse({
        run_id: "run_1",
        started_at: started,
        ended_at: ended,
      });
      expect(decoded.started_at).toBeInstanceOf(Date);
      expect(decoded.ended_at).toBeInstanceOf(Date);
      expect(decoded.started_at.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      // passthrough keeps the other columns for the contract parse downstream.
      expect((decoded as Record<string, unknown>)["run_id"]).toBe("run_1");
    });

    it("coerces an ISO-string timestamp to a real Date", () => {
      const decoded = RawRunSummaryRowSchema.parse({
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: null,
      });
      expect(decoded.started_at).toBeInstanceOf(Date);
      expect(decoded.ended_at).toBeNull();
    });

    it("keeps a nullable ended_at null", () => {
      const decoded = RawRunSummaryRowSchema.parse({
        started_at: new Date(),
        ended_at: null,
      });
      expect(decoded.ended_at).toBeNull();
    });

    it("THROWS on a malformed started_at timestamp", () => {
      expect(() => RawRunSummaryRowSchema.parse({ started_at: "not-a-date", ended_at: null })).toThrow(/invalid_type/u);
    });

    it("THROWS when the required started_at is missing", () => {
      expect(() => RawRunSummaryRowSchema.parse({ ended_at: null })).toThrow(/invalid_type/u);
    });
  });

  describe("RawTaskRowSchema", () => {
    it("decodes both nullable timestamps", () => {
      const decoded = RawTaskRowSchema.parse({
        started_at: "2026-01-01T00:00:00.000Z",
        ended_at: null,
      });
      expect(decoded.started_at).toBeInstanceOf(Date);
      expect(decoded.ended_at).toBeNull();
    });

    it("THROWS on a malformed started_at", () => {
      expect(() => RawTaskRowSchema.parse({ started_at: "garbage", ended_at: null })).toThrow(/invalid_type/u);
    });
  });

  describe("RawEventRowSchema", () => {
    it("decodes ts to a real Date and accepts a numeric or string id", () => {
      const numeric = RawEventRowSchema.parse({ id: 42, ts: "2026-01-01T00:00:00.000Z" });
      expect(numeric.id).toBe("42");
      expect(numeric.ts).toBeInstanceOf(Date);
      const stringId = RawEventRowSchema.parse({ id: "42", ts: new Date() });
      expect(stringId.id).toBe("42");
    });

    it("THROWS on a malformed ts", () => {
      expect(() => RawEventRowSchema.parse({ id: 1, ts: "nope" })).toThrow(/invalid_/u);
    });

    it("THROWS when id is missing", () => {
      expect(() => RawEventRowSchema.parse({ ts: new Date() })).toThrow(/invalid_/u);
    });
  });

  describe("RawCostRowSchema", () => {
    const baseCost = {
      id: 7,
      recorded_at: "2026-01-01T00:00:00.000Z",
      billing_mode: "per_token" as const,
      cost_basis: "provider_response" as const,
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_creation_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    };

    it("decodes recorded_at, enums, and token counts at the boundary", () => {
      const decoded = RawCostRowSchema.parse({
        ...baseCost,
        input_tokens: "12",
        total_tokens: 12,
      });
      expect(decoded.recorded_at).toBeInstanceOf(Date);
      expect(decoded.id).toBe("7");
      expect(decoded.billing_mode).toBe("per_token");
      expect(decoded.cost_basis).toBe("provider_response");
      expect(decoded.input_tokens).toBe(12);
      expect(decoded.total_tokens).toBe(12);
      expect(decoded.output_tokens).toBe(0);
    });

    it("accepts unattributed billing_mode and cost_basis", () => {
      const decoded = RawCostRowSchema.parse({
        ...baseCost,
        billing_mode: "unattributed",
        cost_basis: "unattributed",
      });
      expect(decoded.billing_mode).toBe("unattributed");
      expect(decoded.cost_basis).toBe("unattributed");
    });

    it("THROWS on a malformed recorded_at", () => {
      expect(() => RawCostRowSchema.parse({ ...baseCost, id: 1, recorded_at: "" })).toThrow(/invalid_/u);
    });

    it("THROWS on an unknown billing_mode", () => {
      expect(() => RawCostRowSchema.parse({ ...baseCost, billing_mode: "metered" })).toThrow(/invalid_/u);
    });

    it("THROWS when a required token column is missing", () => {
      const { total_tokens: _drop, ...withoutTotal } = baseCost;
      expect(() => RawCostRowSchema.parse(withoutTotal)).toThrow(/invalid_/u);
    });
  });
});
