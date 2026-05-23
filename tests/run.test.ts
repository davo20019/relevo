import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  activitySuffix,
  idleSeconds,
  lastActivityPreview,
  newRun,
  type AgentRunState,
} from "../src/run.js";

describe("activitySuffix", () => {
  it("is empty when nothing happened", () => {
    const r = newRun("a", "cyan", "p");
    expect(activitySuffix(r)).toBe("");
  });

  it("includes commands, edits, tools, and tokens", () => {
    const r = newRun("a", "cyan", "p");
    r.nCommands = 1;
    r.nEdits = 2;
    r.nTools = 14;
    r.tokens = { input: 1200, output: 350, cacheRead: 0, cacheCreate: 0 };
    const s = activitySuffix(r);
    expect(s).toContain("1 cmd");
    expect(s).toContain("2 edits");
    expect(s).toContain("14 tools");
    expect(s).toMatch(/\bin\b.*\bout\b/);
  });

  it("omits the token slice when totals are zero", () => {
    const r = newRun("a", "cyan", "p");
    r.tokens = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
    expect(activitySuffix(r)).toBe("");
  });
});

describe("lastActivityPreview", () => {
  it("prefers most-specific recent action: command > edit > tool", () => {
    const r = newRun("a", "cyan", "p");
    r.lastTool = "Read src/foo.ts";
    expect(lastActivityPreview(r)).toBe("Read src/foo.ts");
    r.lastEdit = "src/bar.ts";
    expect(lastActivityPreview(r)).toBe("+ edited src/bar.ts");
    r.lastCommand = "npm test";
    expect(lastActivityPreview(r)).toBe("$ npm test");
  });

  it("returns null when nothing has happened", () => {
    expect(lastActivityPreview(newRun("a", "cyan", "p"))).toBeNull();
  });
});

describe("idleSeconds", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is zero when an event just arrived", () => {
    const r = newRun("a", "cyan", "p");
    expect(idleSeconds(r)).toBeLessThan(1);
  });

  it("grows with wall-clock time while running", () => {
    const r = newRun("a", "cyan", "p");
    vi.advanceTimersByTime(45_000);
    expect(idleSeconds(r)).toBeGreaterThanOrEqual(45);
  });

  it("returns zero once the run is no longer running", () => {
    const r: AgentRunState = { ...newRun("a", "cyan", "p"), running: false };
    vi.advanceTimersByTime(120_000);
    expect(idleSeconds(r)).toBe(0);
  });
});
