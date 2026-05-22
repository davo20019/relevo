import { describe, expect, it } from "vitest";
import {
  applySuggestion,
  filterSuggestions,
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
