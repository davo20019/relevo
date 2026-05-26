import { describe, expect, it } from "vitest";
import {
  compactDroppedImageInput,
  compactPastedInput,
  deletePastedPlaceholderBackward,
  expandPastedPlaceholders,
  findPlaceholderAtCursor,
  formatRunningInputPlaceholder,
  layoutInputRows,
  pasteInputIsActive,
} from "../src/ui/MultilineInput.js";

describe("compactPastedInput", () => {
  it("replaces long pasted input with a short placeholder", () => {
    const paste = "x".repeat(240);

    const compacted = compactPastedInput(paste, 3);

    expect(compacted).toEqual({
      placeholder: "[Pasted #3, 240 chars]",
      original: paste,
    });
  });

  it("replaces multiline pasted input with a line-count placeholder", () => {
    const paste = "first\nsecond\nthird";

    const compacted = compactPastedInput(paste, 1);

    expect(compacted).toEqual({
      placeholder: "[Pasted #1, 3 lines]",
      original: paste,
    });
  });

  it("keeps short single-line typed input unchanged", () => {
    expect(compactPastedInput("hello", 1)).toBeNull();
  });

  it("does not treat Enter key bytes as pasted text", () => {
    expect(compactPastedInput("\r", 1)).toBeNull();
    expect(compactPastedInput("\n", 1)).toBeNull();
    expect(compactPastedInput("\r\n", 1)).toBeNull();
  });
});

describe("compactDroppedImageInput", () => {
  it("compacts a bare dropped path to a short Image placeholder", () => {
    const compacted = compactDroppedImageInput(
      "/Users/me/Pictures/screenshot.png",
      2,
    );
    expect(compacted).toEqual({
      placeholder: "[Image #2, screenshot.png]",
      original: "/Users/me/Pictures/screenshot.png",
    });
  });

  it("compacts a backslash-escaped path with spaces", () => {
    const compacted = compactDroppedImageInput(
      "/Users/me/My\\ Photos/cat\\ pic.jpeg",
      1,
    );
    expect(compacted).toEqual({
      placeholder: "[Image #1, cat pic.jpeg]",
      original: "/Users/me/My\\ Photos/cat\\ pic.jpeg",
    });
  });

  it("compacts a double-quoted path", () => {
    const compacted = compactDroppedImageInput(
      '"/Users/me/My Photos/cat pic.jpeg"',
      4,
    );
    expect(compacted).toEqual({
      placeholder: "[Image #4, cat pic.jpeg]",
      original: '"/Users/me/My Photos/cat pic.jpeg"',
    });
  });

  it("summarizes when several image paths arrive in one chunk", () => {
    const compacted = compactDroppedImageInput(
      "/tmp/a.png /tmp/b.jpg",
      5,
    );
    expect(compacted).toEqual({
      placeholder: "[Image #5, 2 images]",
      original: "/tmp/a.png /tmp/b.jpg",
    });
  });

  it("returns null when the chunk has no image-shaped path", () => {
    expect(compactDroppedImageInput("hello world", 1)).toBeNull();
  });

  it("does not compact normal pasted text that mentions an image path", () => {
    expect(
      compactDroppedImageInput("Saved screenshot to /tmp/output.png", 1),
    ).toBeNull();
  });

  it("does not compact image URLs as dropped image paths", () => {
    expect(
      compactDroppedImageInput("https://example.com/output.png", 1),
    ).toBeNull();
  });

  it("compacts a file:// URI dropped by some terminals", () => {
    const compacted = compactDroppedImageInput(
      "file:///Users/me/Pictures/screenshot.png",
      3,
    );
    expect(compacted).toEqual({
      placeholder: "[Image #3, screenshot.png]",
      original: "/Users/me/Pictures/screenshot.png",
    });
  });

  it("expands back to the original path on submit", () => {
    const compacted = compactDroppedImageInput(
      "/Users/me/Pictures/screenshot.png",
      2,
    )!;
    const buffer = `look at this [Image #2, screenshot.png] please`;
    const expanded = expandPastedPlaceholders(buffer, [
      [compacted.placeholder, compacted.original],
    ]);
    expect(expanded).toBe(
      "look at this /Users/me/Pictures/screenshot.png please",
    );
  });
});

describe("pasteInputIsActive", () => {
  it("keeps paste and drop input active while a dispatch is busy", () => {
    expect(pasteInputIsActive(true)).toBe(true);
  });

  it("keeps paste and drop input active while idle", () => {
    expect(pasteInputIsActive(false)).toBe(true);
  });
});

describe("formatRunningInputPlaceholder", () => {
  it("tells the user the next prompt will queue while agents are running", () => {
    expect(formatRunningInputPlaceholder(0)).toBe("running · next prompt will queue");
  });
});

describe("layoutInputRows", () => {
  it("keeps the rendered input to a fixed number of visual rows", () => {
    const layout = layoutInputRows("one\ntwo\nthree\nfour", "one\ntwo\nthree\nfour".length, {
      width: 20,
      maxRows: 3,
    });

    expect(layout.rows.map((r) => r.text)).toEqual(["two", "three", "four"]);
    expect(layout.cursorRow).toBe(2);
    expect(layout.cursorCol).toBe(4);
  });

  it("wraps long logical lines before choosing the visible input window", () => {
    const layout = layoutInputRows("abcdefghijkl", "abcdefghijkl".length, {
      width: 5,
      maxRows: 2,
    });

    expect(layout.rows.map((r) => r.text)).toEqual(["fghij", "kl"]);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorCol).toBe(2);
  });

  it("keeps short input to its natural height by default", () => {
    const layout = layoutInputRows("hi", 2, { width: 20, maxRows: 3 });

    expect(layout.rows.map((r) => r.text)).toEqual(["hi"]);
    expect(layout.cursorRow).toBe(0);
    expect(layout.cursorCol).toBe(2);
  });
});

describe("expandPastedPlaceholders", () => {
  it("restores original pasted text before submit", () => {
    const expanded = expandPastedPlaceholders("ask [Pasted #1, 3 lines] now", [
      ["[Pasted #1, 3 lines]", "a\nb\nc"],
    ]);

    expect(expanded).toBe("ask a\nb\nc now");
  });
});

describe("deletePastedPlaceholderBackward", () => {
  it("deletes the entire placeholder when backspacing at its edge", () => {
    const value = "ask [Pasted #1, 240 chars] now";
    const cursor = "ask [Pasted #1, 240 chars]".length;

    expect(
      deletePastedPlaceholderBackward(value, cursor, ["[Pasted #1, 240 chars]"]),
    ).toEqual({
      value: "ask  now",
      cursor: "ask ".length,
      placeholder: "[Pasted #1, 240 chars]",
    });
  });

  it("deletes the entire placeholder when backspacing from inside it", () => {
    const value = "ask [Pasted #1, 240 chars] now";
    const cursor = "ask [Past".length;

    expect(
      deletePastedPlaceholderBackward(value, cursor, ["[Pasted #1, 240 chars]"]),
    ).toEqual({
      value: "ask  now",
      cursor: "ask ".length,
      placeholder: "[Pasted #1, 240 chars]",
    });
  });
});

describe("findPlaceholderAtCursor", () => {
  const placeholder = "[Pasted #1, 240 chars]";
  const value = `ask ${placeholder} now`;
  const start = "ask ".length;
  const end = start + placeholder.length;

  it("returns null at the left edge (cursor just before placeholder)", () => {
    expect(findPlaceholderAtCursor(value, start, [placeholder])).toBeNull();
  });

  it("returns null at the right edge (cursor just after placeholder)", () => {
    expect(findPlaceholderAtCursor(value, end, [placeholder])).toBeNull();
  });

  it("returns the placeholder when the cursor is strictly inside it", () => {
    expect(findPlaceholderAtCursor(value, start + 3, [placeholder])).toEqual({
      start,
      end,
      placeholder,
    });
  });

  it("returns null when no placeholders are tracked", () => {
    expect(findPlaceholderAtCursor(value, start + 3, [])).toBeNull();
  });
});

describe("expandPastedPlaceholders with multiple entries", () => {
  it("restores every placeholder in order", () => {
    const expanded = expandPastedPlaceholders(
      "first [Pasted #1, 2 lines] then [Pasted #2, 250 chars] end",
      [
        ["[Pasted #1, 2 lines]", "a\nb"],
        ["[Pasted #2, 250 chars]", "x".repeat(250)],
      ],
    );

    expect(expanded).toBe(`first a\nb then ${"x".repeat(250)} end`);
  });

  it("leaves the literal placeholder string when the entry has been dropped", () => {
    const expanded = expandPastedPlaceholders("ask [Pasted #1, 2 lines] now", []);
    expect(expanded).toBe("ask [Pasted #1, 2 lines] now");
  });
});
