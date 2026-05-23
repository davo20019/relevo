import { describe, expect, it } from "vitest";
import {
  computeColumnWidths,
  tokenizeMarkdown,
  wrapTokens,
  type InlineToken,
} from "../src/ui/markdown.js";

describe("tokenizeMarkdown — block-level", () => {
  it("treats plain text as a paragraph line with one text token", () => {
    const out = tokenizeMarkdown("hello world");
    expect(out).toEqual([
      { kind: "paragraph", tokens: [{ kind: "text", text: "hello world" }] },
    ]);
  });

  it("preserves blank lines as their own block", () => {
    const out = tokenizeMarkdown("a\n\nb");
    expect(out.map((l) => l.kind)).toEqual(["paragraph", "blank", "paragraph"]);
  });

  it("parses headings at levels 1-6", () => {
    for (let level = 1; level <= 6; level++) {
      const hashes = "#".repeat(level);
      const out = tokenizeMarkdown(`${hashes} title`);
      expect(out[0]).toEqual({
        kind: "heading",
        level,
        tokens: [{ kind: "text", text: "title" }],
      });
    }
  });

  it("does not treat seven or more hashes as a heading", () => {
    const out = tokenizeMarkdown("####### still text");
    expect(out[0]!.kind).toBe("paragraph");
  });

  it("parses unordered list items with - and *", () => {
    const out = tokenizeMarkdown("- first\n* second");
    expect(out[0]).toMatchObject({ kind: "listitem", marker: "- " });
    expect(out[1]).toMatchObject({ kind: "listitem", marker: "* " });
  });

  it("parses ordered list items", () => {
    const out = tokenizeMarkdown("1. one\n2. two");
    expect(out[0]).toMatchObject({ kind: "listitem", marker: "1. " });
    expect(out[1]).toMatchObject({ kind: "listitem", marker: "2. " });
  });

  it("parses blockquotes", () => {
    const out = tokenizeMarkdown("> quoted");
    expect(out[0]).toMatchObject({
      kind: "blockquote",
      tokens: [{ kind: "text", text: "quoted" }],
    });
  });

  it("collects a closed fenced code block", () => {
    const out = tokenizeMarkdown("```\nfoo\nbar\n```");
    expect(out).toEqual([{ kind: "codeblock", text: "foo\nbar" }]);
  });

  it("treats an unclosed fenced code block as code through end-of-input", () => {
    const out = tokenizeMarkdown("```\nstreaming\nstill streaming");
    expect(out).toEqual([{ kind: "codeblock", text: "streaming\nstill streaming" }]);
  });

  it("ignores list/heading syntax inside a code block", () => {
    const out = tokenizeMarkdown("```\n# not a heading\n- not a list\n```");
    expect(out).toEqual([{ kind: "codeblock", text: "# not a heading\n- not a list" }]);
  });
});

describe("tokenizeMarkdown — inline", () => {
  it("parses bold with **", () => {
    const out = tokenizeMarkdown("hello **brave** world");
    expect(out[0]).toMatchObject({
      kind: "paragraph",
      tokens: [
        { kind: "text", text: "hello " },
        { kind: "text", text: "brave", bold: true },
        { kind: "text", text: " world" },
      ],
    });
  });

  it("parses italic with single * and _", () => {
    const star = tokenizeMarkdown("*em*");
    expect(star[0]!.kind === "paragraph" && star[0]!.tokens[0]).toMatchObject({
      text: "em",
      italic: true,
    });
    const under = tokenizeMarkdown("_em_");
    expect(under[0]!.kind === "paragraph" && under[0]!.tokens[0]).toMatchObject({
      text: "em",
      italic: true,
    });
  });

  it("parses inline code", () => {
    const out = tokenizeMarkdown("run `npm test` now");
    if (out[0]!.kind !== "paragraph") throw new Error("expected paragraph");
    expect(out[0]!.tokens).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "npm test" },
      { kind: "text", text: " now" },
    ]);
  });

  it("parses links and keeps only the label", () => {
    const out = tokenizeMarkdown("see [docs](https://example.com) for more");
    if (out[0]!.kind !== "paragraph") throw new Error("expected paragraph");
    expect(out[0]!.tokens).toEqual([
      { kind: "text", text: "see " },
      { kind: "link", text: "docs" },
      { kind: "text", text: " for more" },
    ]);
  });

  it("degrades an unclosed ** to literal text", () => {
    const out = tokenizeMarkdown("hello **brave");
    if (out[0]!.kind !== "paragraph") throw new Error("expected paragraph");
    expect(out[0]!.tokens).toEqual([{ kind: "text", text: "hello **brave" }]);
  });

  it("degrades an unclosed inline code backtick to literal text", () => {
    const out = tokenizeMarkdown("run `npm test now");
    if (out[0]!.kind !== "paragraph") throw new Error("expected paragraph");
    expect(out[0]!.tokens).toEqual([{ kind: "text", text: "run `npm test now" }]);
  });

  it("applies inline formatting inside headings and list items", () => {
    const heading = tokenizeMarkdown("## the **bold** truth");
    expect(heading[0]).toMatchObject({
      kind: "heading",
      level: 2,
      tokens: [
        { kind: "text", text: "the " },
        { kind: "text", text: "bold", bold: true },
        { kind: "text", text: " truth" },
      ],
    });
    const list = tokenizeMarkdown("- use `relevo` daily");
    if (list[0]!.kind !== "listitem") throw new Error("expected listitem");
    expect(list[0]!.tokens).toEqual([
      { kind: "text", text: "use " },
      { kind: "code", text: "relevo" },
      { kind: "text", text: " daily" },
    ]);
  });

  it("does not treat * inside a word as italic (avoids snake_case false-positives)", () => {
    const out = tokenizeMarkdown("file_name_here stays whole");
    if (out[0]!.kind !== "paragraph") throw new Error("expected paragraph");
    expect(out[0]!.tokens).toEqual([{ kind: "text", text: "file_name_here stays whole" }]);
  });
});

describe("tokenizeMarkdown — tables", () => {
  it("parses a basic GFM table with leading/trailing pipes", () => {
    const md = [
      "| Capability | Trigger |",
      "|---|---|",
      "| Discover jobs | Cron |",
      "| Score fit | Triage |",
    ].join("\n");
    const out = tokenizeMarkdown(md);
    expect(out).toHaveLength(1);
    const t = out[0]!;
    if (t.kind !== "table") throw new Error("expected table");
    expect(t.header.map((c) => c.map((tok) => tok.text).join(""))).toEqual([
      "Capability",
      "Trigger",
    ]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[1]!.map((c) => c.map((tok) => tok.text).join(""))).toEqual([
      "Score fit",
      "Triage",
    ]);
    expect(t.aligns).toEqual(["left", "left"]);
  });

  it("parses tables without leading/trailing pipes", () => {
    const md = ["a | b", "---|---", "1 | 2"].join("\n");
    const out = tokenizeMarkdown(md);
    expect(out[0]!.kind).toBe("table");
  });

  it("parses alignment markers in the separator row", () => {
    const md = ["| a | b | c |", "|:---|:---:|---:|", "| 1 | 2 | 3 |"].join("\n");
    const out = tokenizeMarkdown(md);
    if (out[0]!.kind !== "table") throw new Error("expected table");
    expect(out[0]!.aligns).toEqual(["left", "center", "right"]);
  });

  it("pads short body rows to header column count", () => {
    const md = ["| a | b | c |", "|---|---|---|", "| 1 | 2 |"].join("\n");
    const out = tokenizeMarkdown(md);
    if (out[0]!.kind !== "table") throw new Error("expected table");
    expect(out[0]!.rows[0]).toHaveLength(3);
    expect(out[0]!.rows[0]![2]).toEqual([]);
  });

  it("applies inline formatting inside table cells", () => {
    const md = ["| name | val |", "|---|---|", "| `foo` | **bold** |"].join("\n");
    const out = tokenizeMarkdown(md);
    if (out[0]!.kind !== "table") throw new Error("expected table");
    expect(out[0]!.rows[0]![0]).toEqual([{ kind: "code", text: "foo" }]);
    expect(out[0]!.rows[0]![1]).toEqual([{ kind: "text", text: "bold", bold: true }]);
  });

  it("does not treat a single pipe-row without separator as a table", () => {
    const md = "| just | one |\nnot a separator";
    const out = tokenizeMarkdown(md);
    expect(out[0]!.kind).toBe("paragraph");
  });
});

describe("wrapTokens", () => {
  const text = (s: string): InlineToken => ({ kind: "text", text: s });

  it("returns one line when content fits", () => {
    const lines = wrapTokens([text("hello world")], 20);
    expect(lines).toHaveLength(1);
  });

  it("wraps on whitespace and drops trailing spaces", () => {
    const lines = wrapTokens([text("hello world foo")], 7);
    expect(lines.map((l) => l.map((t) => t.text).join(""))).toEqual([
      "hello",
      "world",
      "foo",
    ]);
  });

  it("hard-splits a word longer than the width", () => {
    const lines = wrapTokens([text("supercalifragilistic")], 6);
    expect(lines.map((l) => l.map((t) => t.text).join(""))).toEqual([
      "superc",
      "alifra",
      "gilist",
      "ic",
    ]);
  });

  it("preserves token formatting across wraps", () => {
    const tokens: InlineToken[] = [
      { kind: "code", text: "npm install some-package" },
    ];
    const lines = wrapTokens(tokens, 12);
    for (const line of lines) {
      for (const tok of line) {
        expect(tok.kind).toBe("code");
      }
    }
  });
});

describe("computeColumnWidths", () => {
  it("returns natural widths when they already fit", () => {
    expect(computeColumnWidths([10, 8, 5], 100)).toEqual([10, 8, 5]);
  });

  it("returns natural widths when available is undefined", () => {
    expect(computeColumnWidths([10, 8, 5], undefined)).toEqual([10, 8, 5]);
  });

  it("shrinks proportionally when too wide", () => {
    const widths = computeColumnWidths([20, 10, 10], 20);
    expect(widths.reduce((a, b) => a + b, 0)).toBe(20);
    expect(widths[0]).toBeGreaterThanOrEqual(widths[1]!);
  });

  it("enforces a minimum width per column", () => {
    const widths = computeColumnWidths([100, 1, 1], 10);
    for (const w of widths) expect(w).toBeGreaterThanOrEqual(3);
  });
});
