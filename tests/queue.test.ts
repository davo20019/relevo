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
    expect(formatQueuePreview("hello", 60)).toBe("hello");
  });

  it("collapses internal whitespace into single spaces", () => {
    expect(formatQueuePreview("hello   world\n\nagain", 60)).toBe("hello world again");
  });

  it("trims leading and trailing whitespace", () => {
    expect(formatQueuePreview("  hi  ", 60)).toBe("hi");
  });

  it("truncates with an ellipsis when over the limit", () => {
    const input = "a".repeat(100);
    const out = formatQueuePreview(input, 60);
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
    expect(out.slice(0, -1)).toBe("a".repeat(59));
  });

  it("respects a custom max", () => {
    expect(formatQueuePreview("abcdef", 4)).toBe("abc…");
  });
});
