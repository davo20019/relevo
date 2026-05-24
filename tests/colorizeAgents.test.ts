import { describe, expect, it } from "vitest";
import { colorizeAgentMentions } from "../src/ui/colorizeAgents.js";

const colors = { claude: "magenta", codex: "cyan", cursor: "green" };

describe("colorizeAgentMentions", () => {
  it("returns a single plain segment when no mentions are present", () => {
    expect(colorizeAgentMentions("hello world", colors)).toEqual([
      { text: "hello world" },
    ]);
  });

  it("colors the full @name token including the @", () => {
    expect(colorizeAgentMentions("hi @claude!", colors)).toEqual([
      { text: "hi " },
      { text: "@claude", color: "magenta", bold: true },
      { text: "!" },
    ]);
  });

  it("colors only the name after /open, leaving the command flat", () => {
    expect(colorizeAgentMentions("/open claude", colors)).toEqual([
      { text: "/open " },
      { text: "claude", color: "magenta", bold: true },
    ]);
  });

  it("handles multiple mentions in one line", () => {
    expect(
      colorizeAgentMentions("continue: /open claude  ·  /open codex", colors),
    ).toEqual([
      { text: "continue: /open " },
      { text: "claude", color: "magenta", bold: true },
      { text: "  ·  /open " },
      { text: "codex", color: "cyan", bold: true },
    ]);
  });

  it("leaves unknown @agent names uncolored", () => {
    expect(colorizeAgentMentions("@unknown is plain", colors)).toEqual([
      { text: "@unknown is plain" },
    ]);
  });

  it("leaves /open <unknown> uncolored", () => {
    expect(colorizeAgentMentions("/open mystery", colors)).toEqual([
      { text: "/open mystery" },
    ]);
  });

  it("does not match @name fragments inside larger words", () => {
    expect(colorizeAgentMentions("email@claude.com", colors)).toEqual([
      { text: "email@claude.com" },
    ]);
  });

  it("handles mention at very end of string", () => {
    expect(colorizeAgentMentions("ping @cursor", colors)).toEqual([
      { text: "ping " },
      { text: "@cursor", color: "green", bold: true },
    ]);
  });

  it("renders @mentions plain when the agent is not in the live set", () => {
    const live = new Set(["claude"]);
    expect(colorizeAgentMentions("@claude vs @codex", colors, live)).toEqual([
      { text: "@claude", color: "magenta", bold: true },
      { text: " vs @codex" },
    ]);
  });

  it("treats a null live set as 'all live' (backwards compatible)", () => {
    expect(colorizeAgentMentions("@claude", colors, null)).toEqual([
      { text: "@claude", color: "magenta", bold: true },
    ]);
  });
});
