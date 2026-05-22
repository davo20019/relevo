import { describe, expect, it } from "vitest";
import {
  expandAll,
  parseLine,
  parseMulti,
  prepareDispatchLine,
  smartRoute,
} from "../src/routing.js";

describe("expandAll", () => {
  it("replaces @all with every agent in declaration order", () => {
    expect(expandAll("@all ship it", ["a", "b", "c"])).toBe("@a @b @c ship it");
  });

  it("leaves non-@all lines untouched", () => {
    expect(expandAll("@a do the thing", ["a", "b"])).toBe("@a do the thing");
  });

  it("returns just mentions when @all has no body", () => {
    expect(expandAll("@all", ["a", "b"])).toBe("@a @b");
  });
});

describe("parseMulti", () => {
  it("detects two leading agent mentions", () => {
    const r = parseMulti("@a @b review this", ["a", "b", "c"]);
    expect(r).toEqual({ agents: ["a", "b"], body: "review this" });
  });

  it("requires every prefix mention to be known", () => {
    expect(parseMulti("@a @unknown go", ["a", "b"])).toBeNull();
  });

  it("returns null on a single mention", () => {
    expect(parseMulti("@a go", ["a"])).toBeNull();
  });

  it("accepts 'and' between leading mentions", () => {
    const r = parseMulti("@a and @b hi", ["a", "b"]);
    expect(r).toEqual({ agents: ["a", "b"], body: "hi" });
  });

  it("accepts a comma between leading mentions", () => {
    const r = parseMulti("@a, @b hi", ["a", "b"]);
    expect(r).toEqual({ agents: ["a", "b"], body: "hi" });
  });

  it("accepts '+' between leading mentions with no whitespace", () => {
    const r = parseMulti("@a+@b hi", ["a", "b"]);
    expect(r).toEqual({ agents: ["a", "b"], body: "hi" });
  });

  it("treats 'and' as a connector only when followed by whitespace or @", () => {
    // "android" shouldn't be eaten as connector + suffix.
    expect(parseMulti("@a android @b hi", ["a", "b"])).toBeNull();
  });

  it("does not multi-dispatch when leading text precedes the mentions", () => {
    expect(parseMulti("and @a @b hi", ["a", "b"])).toBeNull();
  });
});

describe("smartRoute", () => {
  it("moves a trailing mention to the front", () => {
    expect(smartRoute("review the diff @a", ["a", "b"])).toBe("@a review the diff");
  });

  it("leaves already-prefixed lines untouched", () => {
    expect(smartRoute("@a do X", ["a"])).toBe("@a do X");
  });

  it("leaves slash commands alone even with @ tokens inside", () => {
    expect(smartRoute("/help @a", ["a"])).toBe("/help @a");
  });
});

describe("prepareDispatchLine pending-prompt round-trip", () => {
  it("saves untagged input for the next agent selection", () => {
    const state = { pendingPrompt: null as string | null };
    const routed = prepareDispatchLine("review the latest diff", ["claude"], state);
    expect(routed).toBeNull();
    expect(state.pendingPrompt).toBe("review the latest diff");
  });

  it("a bare agent mention consumes the saved untagged prompt", () => {
    const state = { pendingPrompt: "review the latest diff" as string | null };
    const routed = prepareDispatchLine("@claude", ["claude"], state);
    expect(routed).toBe("@claude review the latest diff");
    expect(state.pendingPrompt).toBeNull();
  });
});

describe("parseLine", () => {
  it("treats /help as a command", () => {
    expect(parseLine("/help")).toMatchObject({ kind: "command", content: "/help" });
  });

  it("extracts agent + body", () => {
    expect(parseLine("@claude do X")).toMatchObject({
      kind: "agent",
      agent: "claude",
      content: "do X",
    });
  });
});
