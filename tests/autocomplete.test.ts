import { describe, expect, it } from "vitest";
import {
  applySuggestion,
  filterSuggestions,
  slashCommandComplete,
  tokenUnderCursor,
} from "../src/ui/autocomplete.js";

describe("tokenUnderCursor", () => {
  it("detects a slash command at the start of a line", () => {
    const t = tokenUnderCursor("/he", 3);
    expect(t).toMatchObject({ kind: "slash", text: "/he" });
  });

  it("does not treat a / mid-prompt as a slash command", () => {
    const t = tokenUnderCursor("path/to/file", 4);
    expect(t).toBeNull();
  });

  it("detects an @ mention anywhere in the line", () => {
    const t = tokenUnderCursor("review @cl", 10);
    expect(t).toMatchObject({ kind: "mention", text: "@cl" });
  });

  it("returns null when the cursor is on whitespace", () => {
    expect(tokenUnderCursor("@claude ", 8)).toBeNull();
  });
});

describe("filterSuggestions", () => {
  const slash = ["/help", "/agents", "/tail"] as const;
  const agents = ["claude", "codex", "cursor"] as const;

  it("prefix-matches slash commands by the typed text", () => {
    const t = tokenUnderCursor("/he", 3)!;
    expect(filterSuggestions(t, slash, agents)).toEqual(["/help"]);
  });

  it("returns the full set when no query is typed yet", () => {
    const t = tokenUnderCursor("/", 1)!;
    expect(filterSuggestions(t, slash, agents)).toContain("/help");
  });

  it("includes @all as a synthetic mention", () => {
    const t = tokenUnderCursor("@", 1)!;
    expect(filterSuggestions(t, slash, agents)).toContain("@all");
  });

  it("substring-matches when no prefix candidate fits", () => {
    const t = tokenUnderCursor("@or", 3)!;
    expect(filterSuggestions(t, slash, agents)).toContain("@cursor");
  });
});

describe("slash-arg detection", () => {
  const slash = ["/agents", "/last", "/open"] as const;
  const agents = ["claude", "codex", "cursor"] as const;

  it("suggests subcommands right after typing a known slash command + space", () => {
    const v = "/agents ";
    const t = tokenUnderCursor(v, v.length)!;
    expect(t.kind).toBe("slash-arg");
    expect(filterSuggestions(t, slash, agents)).toEqual(["enable", "disable"]);
  });

  it("prefix-matches a partially typed subcommand", () => {
    const v = "/agents en";
    const t = tokenUnderCursor(v, v.length)!;
    expect(t).toMatchObject({ kind: "slash-arg", command: "/agents", argIndex: 0 });
    expect(filterSuggestions(t, slash, agents)).toEqual(["enable"]);
  });

  it("suggests agent names at the next positional arg", () => {
    const v = "/agents enable ";
    const t = tokenUnderCursor(v, v.length)!;
    expect(t).toMatchObject({ kind: "slash-arg", argIndex: 1 });
    expect(filterSuggestions(t, slash, agents)).toEqual(["claude", "codex", "cursor"]);
  });

  it("suggests agent names for /open <agent>", () => {
    const v = "/open cl";
    const t = tokenUnderCursor(v, v.length)!;
    expect(t).toMatchObject({ kind: "slash-arg", command: "/open", argIndex: 0 });
    expect(filterSuggestions(t, slash, agents)).toEqual(["claude"]);
  });

  it("returns null when past the schema", () => {
    const v = "/agents enable claude extra";
    const t = tokenUnderCursor(v, v.length)!;
    expect(t).toMatchObject({ kind: "slash-arg", argIndex: 2 });
    expect(filterSuggestions(t, slash, agents)).toEqual([]);
  });

  it("does not fire for unknown slash commands", () => {
    expect(tokenUnderCursor("/totally-fake arg", 17)).toBeNull();
  });

  it("does not fire when the slash command is mid-prompt", () => {
    expect(tokenUnderCursor("hello /agents ena", 17)).toBeNull();
  });

  it("applySuggestion replaces a partial arg in place", () => {
    const v = "/agents en";
    const t = tokenUnderCursor(v, v.length)!;
    const { value, cursor } = applySuggestion(v, t, "enable");
    expect(value).toBe("/agents enable ");
    expect(cursor).toBe(value.length);
  });

  it("applySuggestion inserts at an empty position after a trailing space", () => {
    const v = "/agents enable ";
    const t = tokenUnderCursor(v, v.length)!;
    const { value } = applySuggestion(v, t, "claude");
    expect(value).toBe("/agents enable claude ");
  });
});

describe("slashCommandComplete", () => {
  const agents = ["claude", "codex", "cursor", "opencode", "agy"];

  it("returns true when /agents disable <agent> is fully specified", () => {
    expect(slashCommandComplete("/agents disable opencode", agents)).toBe(true);
    expect(slashCommandComplete("/agents enable @claude", agents)).toBe(true);
  });

  it("returns false for bare /agents or missing agent name", () => {
    expect(slashCommandComplete("/agents", agents)).toBe(false);
    expect(slashCommandComplete("/agents disable", agents)).toBe(false);
    expect(slashCommandComplete("/agents disable ", agents)).toBe(false);
  });

  it("returns false for unknown agent names", () => {
    expect(slashCommandComplete("/agents disable not-an-agent", agents)).toBe(false);
  });
});

describe("applySuggestion", () => {
  it("replaces the token in place and adds a trailing space", () => {
    const t = tokenUnderCursor("/he", 3)!;
    const { value, cursor } = applySuggestion("/he", t, "/help");
    expect(value).toBe("/help ");
    expect(cursor).toBe(value.length);
  });

  it("preserves the rest of the line when accepting mid-prompt", () => {
    const t = tokenUnderCursor("review @cl this", 10)!;
    const { value } = applySuggestion("review @cl this", t, "@claude");
    expect(value).toBe("review @claude this");
  });
});

describe("task subcommand completion", () => {
  it("completes /task rename", () => {
    const tok = tokenUnderCursor("/task ren", 9);
    expect(tok?.kind).toBe("slash-arg");
    const out = filterSuggestions(tok!, ["/task"], []);
    expect(out).toContain("rename");
  });

  it("no longer suggests switch or end", () => {
    const tok = tokenUnderCursor("/task ", 6);
    const out = filterSuggestions(tok!, ["/task"], []);
    expect(out).not.toContain("switch");
    expect(out).not.toContain("end");
  });
});
