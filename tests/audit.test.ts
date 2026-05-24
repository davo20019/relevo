import { describe, expect, it } from "vitest";
import { tokenMetrics } from "../src/audit.js";

describe("tokenMetrics", () => {
  it("fresh = input + cacheCreate, cached = cacheRead", () => {
    expect(tokenMetrics({ input: 100, output: 50, cacheRead: 900, cacheCreate: 0 }))
      .toEqual({ fresh: 100, cached: 900, pct: 0.9 });
  });

  it("counts cacheCreate as fresh (model still processes it cold)", () => {
    expect(tokenMetrics({ input: 0, output: 0, cacheRead: 0, cacheCreate: 500 }))
      .toEqual({ fresh: 500, cached: 0, pct: 0 });
  });

  it("pct is null when both fresh and cached are zero", () => {
    expect(tokenMetrics({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }))
      .toEqual({ fresh: 0, cached: 0, pct: null });
  });
});
