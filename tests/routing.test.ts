import { describe, expect, it } from "vitest";
import {
  expandAll,
  isKnownCommand,
  parseAfterCommand,
  parseLine,
  parseMulti,
  prepareDispatchLine,
  requestedPeerAgents,
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

describe("new slash commands", () => {
  it("recognizes /default as a slash command", () => {
    expect(isKnownCommand("/default @claude")).toBe(true);
    expect(smartRoute("/default @claude", ["claude"])).toBe("/default @claude");
  });

  it("recognizes /sync as a slash command", () => {
    expect(isKnownCommand("/sync @claude @codex")).toBe(true);
    expect(smartRoute("/sync @claude @codex", ["claude", "codex"])).toBe(
      "/sync @claude @codex",
    );
  });

  it("recognizes /after as a slash command", () => {
    expect(isKnownCommand("/after @codex: @cursor implement findings")).toBe(true);
  });

  it("recognizes /cancel as a slash command", () => {
    expect(isKnownCommand("/cancel @cursor")).toBe(true);
    expect(isKnownCommand("/cancel cursor")).toBe(true);
  });

  it("parses /after target and body", () => {
    expect(parseAfterCommand("/after @codex: @cursor implement findings"))
      .toEqual({ targetAgent: "codex", body: "@cursor implement findings" });
  });

  it("rejects /after without a colon", () => {
    expect(parseAfterCommand("/after @codex @cursor go")).toBeNull();
  });

  it("rejects /after without a leading @", () => {
    expect(parseAfterCommand("/after codex: @cursor go")).toBeNull();
  });
});

describe("prepareDispatchLine pending-prompt round-trip", () => {
  it("saves untagged input for the next agent selection", () => {
    const state = { pendingPrompt: null as string | null };
    const routed = prepareDispatchLine("review the latest diff", ["claude"], state);
    expect(routed).toBeNull();
    expect(state.pendingPrompt).toBe("review the latest diff");
  });

  it("routes untagged input to the default agent", () => {
    const state = { pendingPrompt: null as string | null };
    const routed = prepareDispatchLine("fix the tests", ["claude", "codex"], state, "claude");
    expect(routed).toBe("@claude fix the tests");
    expect(state.pendingPrompt).toBeNull();
  });

  it("explicit mentions override the default without changing routing prep", () => {
    const state = { pendingPrompt: null as string | null };
    const routed = prepareDispatchLine("@codex ship it", ["claude", "codex"], state, "claude");
    expect(routed).toBe("@codex ship it");
    expect(state.pendingPrompt).toBeNull();
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

  it("parses bang-prefixed input as a local command", () => {
    expect(parseLine("!ls src")).toEqual({ kind: "local", command: "ls src" });
  });

  it("trims whitespace after the bang local-command prefix", () => {
    expect(parseLine("!   pwd")).toEqual({ kind: "local", command: "pwd" });
  });

  it("treats a bare bang as empty local command content", () => {
    expect(parseLine("!")).toEqual({ kind: "local", command: "" });
  });

  // Defense-in-depth: bang input is handled in App.tsx's handleSubmit *before*
  // prepareDispatchLine is called, so this path is not exercised at runtime.
  // The test exists so a future change to dispatch routing cannot silently turn
  // "!ls" into a default-agent prompt or capture it as pendingPrompt.
  it("does not route bang input to a default agent", () => {
    const state = { pendingPrompt: null as string | null };
    expect(prepareDispatchLine("!ls", ["claude"], state, "claude")).toBe("!ls");
    expect(state.pendingPrompt).toBeNull();
  });
});

describe("requestedPeerAgents", () => {
  it("returns no peers for ordinary direct chat", () => {
    expect(requestedPeerAgents("explain streams", "claude", ["claude", "codex"])).toEqual([]);
  });

  it("returns explicitly mentioned peer agents", () => {
    expect(
      requestedPeerAgents("review @codex response and compare @cursor:last", "claude", [
        "claude",
        "codex",
        "cursor",
      ]),
    ).toEqual(["codex", "cursor"]);
  });

  it("does not include the target agent as peer context", () => {
    expect(requestedPeerAgents("continue @claude and review @codex", "claude", ["claude", "codex"])).toEqual([
      "codex",
    ]);
  });

  it("treats @local as a reserved transcript peer", () => {
    expect(requestedPeerAgents("debug @local output", "claude", ["claude", "codex"]))
      .toEqual(["local"]);
  });
});
