import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  activitySuffix,
  computeLiveMaxLines,
  displayText,
  finalizeLivePreview,
  hiddenLines,
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

  it("splits fresh vs cached tokens so cache reads are visible", () => {
    const r = newRun("a", "cyan", "p");
    // turn 2-style: small new prompt, big cache hit on the system prompt
    r.tokens = { input: 2000, output: 143, cacheRead: 33000, cacheCreate: 0 };
    expect(activitySuffix(r)).toContain("2k + 33k cached in / 143 out");
  });

  it("treats cache writes as fresh since they bill at full price", () => {
    const r = newRun("a", "cyan", "p");
    // turn 1-style: no cache hits yet, system prompt is being written into cache
    r.tokens = { input: 2000, output: 32, cacheRead: 0, cacheCreate: 30000 };
    expect(activitySuffix(r)).toContain("32k in / 32 out");
  });

  it("drops the `+` when there's only cached input", () => {
    const r = newRun("a", "cyan", "p");
    r.tokens = { input: 0, output: 10, cacheRead: 5000, cacheCreate: 0 };
    expect(activitySuffix(r)).toContain("5k cached in / 10 out");
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

describe("computeLiveMaxLines", () => {
  it("scales with terminal height and stays within bounds", () => {
    expect(computeLiveMaxLines(24)).toBe(8);
    expect(computeLiveMaxLines(60)).toBe(20);
    expect(computeLiveMaxLines(120)).toBe(24);
  });
});

describe("live preview cap", () => {
  it("shows only the tail while capped", () => {
    const run = newRun("a", "cyan", "p", 3);
    run.displayChunks = ["one\ntwo\nthree\nfour\nfive"];
    expect(displayText(run)).toBe("three\nfour\nfive");
    expect(hiddenLines(run)).toBe(2);
  });

  it("uncaps structured parsers when finalized", () => {
    const run = newRun("a", "cyan", "p", 3);
    run.displayChunks = ["one\ntwo\nthree\nfour\nfive"];
    finalizeLivePreview(run, "claude-json");
    expect(displayText(run)).toBe("one\ntwo\nthree\nfour\nfive");
    expect(hiddenLines(run)).toBe(0);
  });

  it("keeps agy-text capped after finalize", () => {
    const run = newRun("a", "cyan", "p", 3);
    run.displayChunks = ["one\ntwo\nthree\nfour\nfive"];
    finalizeLivePreview(run, "agy-text");
    expect(displayText(run)).toBe("three\nfour\nfive");
    expect(hiddenLines(run)).toBe(2);
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
