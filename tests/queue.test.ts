import { describe, expect, it } from "vitest";
import { classifySubmit, formatQueuePreview } from "../src/queue.js";

describe("classifySubmit", () => {
  it("dispatches normally when not busy", () => {
    expect(classifySubmit("@claude hi", false)).toBe("dispatch");
  });

  it("dispatches a slash command when not busy", () => {
    expect(classifySubmit("/help", false)).toBe("dispatch");
  });

  it("queues a normal prompt when busy", () => {
    expect(classifySubmit("@claude follow-up", true)).toBe("queue");
  });

  it("rejects a slash command when busy", () => {
    expect(classifySubmit("/clear", true)).toBe("reject-slash");
  });

  it("treats leading whitespace before a slash command as still a slash command", () => {
    expect(classifySubmit("   /reset", true)).toBe("reject-slash");
  });

  it("queues whitespace-only as queue (App handles empty-line filter)", () => {
    // The queue layer doesn't second-guess the App-level empty check; both
    // layers gating empty submissions would let the rules drift. Empty lines
    // are filtered upstream before classify is called.
    expect(classifySubmit("   ", true)).toBe("queue");
  });
});

describe("formatQueuePreview", () => {
  it("returns short prompts unchanged", () => {
    expect(formatQueuePreview("hello", 60)).toEqual(["hello"]);
  });

  it("collapses internal whitespace into single spaces", () => {
    expect(formatQueuePreview("hello   world\n\nagain", 60)).toEqual(["hello world again"]);
  });

  it("trims leading and trailing whitespace", () => {
    expect(formatQueuePreview("  hi  ", 60)).toEqual(["hi"]);
  });

  it("wraps prompts onto a second line before truncating", () => {
    expect(formatQueuePreview("one two three four five six seven", 14)).toEqual([
      "one two three",
      "four five six…",
    ]);
  });

  it("splits long words across two lines and ellipsizes overflow", () => {
    expect(formatQueuePreview("abcdefghijklmnop", 6)).toEqual(["abcdef", "ghijk…"]);
  });
});
