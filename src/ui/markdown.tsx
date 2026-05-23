import { Fragment, type ReactNode } from "react";
import { Text } from "ink";

export type InlineToken =
  | { kind: "text"; text: string; bold?: boolean; italic?: boolean }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string };

export type TableAlign = "left" | "right" | "center";

export type Line =
  | { kind: "paragraph"; tokens: InlineToken[] }
  | { kind: "heading"; level: number; tokens: InlineToken[] }
  | { kind: "listitem"; marker: string; tokens: InlineToken[] }
  | { kind: "blockquote"; tokens: InlineToken[] }
  | { kind: "codeblock"; text: string }
  | { kind: "table"; header: InlineToken[][]; rows: InlineToken[][][]; aligns: TableAlign[] }
  | { kind: "blank" };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const UNORDERED_RE = /^([-*])\s+(.*)$/;
const ORDERED_RE = /^(\d+\.)\s+(.*)$/;
const BLOCKQUOTE_RE = /^>\s?(.*)$/;
const FENCE_RE = /^```/;

function parseTableRow(line: string): string[] | null {
  let s = line.trim();
  if (!s.includes("|")) return null;
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  if (!cells || cells.length < 2) return false;
  return cells.every((c) => /^:?-+:?$/.test(c));
}

function parseAlignments(line: string, n: number): TableAlign[] {
  const cells = parseTableRow(line) ?? [];
  const out: TableAlign[] = [];
  for (let i = 0; i < n; i++) {
    const c = (cells[i] ?? "").trim();
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    out.push(left && right ? "center" : right ? "right" : "left");
  }
  return out;
}

export function tokenizeMarkdown(text: string): Line[] {
  const lines = text.split("\n");
  const out: Line[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (FENCE_RE.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i]!)) {
        buf.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;
      out.push({ kind: "codeblock", text: buf.join("\n") });
      continue;
    }
    if (line === "") {
      out.push({ kind: "blank" });
      i++;
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      out.push({
        kind: "heading",
        level: heading[1]!.length,
        tokens: tokenizeInline(heading[2]!),
      });
      i++;
      continue;
    }
    const unordered = line.match(UNORDERED_RE);
    if (unordered) {
      out.push({
        kind: "listitem",
        marker: `${unordered[1]} `,
        tokens: tokenizeInline(unordered[2]!),
      });
      i++;
      continue;
    }
    const ordered = line.match(ORDERED_RE);
    if (ordered) {
      out.push({
        kind: "listitem",
        marker: `${ordered[1]} `,
        tokens: tokenizeInline(ordered[2]!),
      });
      i++;
      continue;
    }
    const quote = line.match(BLOCKQUOTE_RE);
    if (quote) {
      out.push({ kind: "blockquote", tokens: tokenizeInline(quote[1]!) });
      i++;
      continue;
    }
    // Table: a row line followed by a separator line `|---|---|`.
    if (i + 1 < lines.length) {
      const headerCells = parseTableRow(line);
      if (
        headerCells &&
        headerCells.length >= 2 &&
        isTableSeparator(lines[i + 1]!)
      ) {
        const ncols = headerCells.length;
        const aligns = parseAlignments(lines[i + 1]!, ncols);
        const rows: InlineToken[][][] = [];
        let j = i + 2;
        while (j < lines.length) {
          const r = parseTableRow(lines[j]!);
          if (!r) break;
          const padded: string[] = [];
          for (let k = 0; k < ncols; k++) padded.push(r[k] ?? "");
          rows.push(padded.map(tokenizeInline));
          j++;
        }
        out.push({
          kind: "table",
          header: headerCells.map(tokenizeInline),
          rows,
          aligns,
        });
        i = j;
        continue;
      }
    }
    out.push({ kind: "paragraph", tokens: tokenizeInline(line) });
    i++;
  }
  return out;
}

// Inline scanner — walks left-to-right, greedily matching the earliest token.
// Unclosed markers degrade to literal text so streaming partial output
// (e.g. a `**bold` whose closing `**` hasn't arrived yet) stays readable.
export function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) {
      tokens.push({ kind: "text", text: buf });
      buf = "";
    }
  };
  const isWordChar = (c: string | undefined) => !!c && /[A-Za-z0-9_]/.test(c);

  while (i < text.length) {
    const c = text[i]!;

    if (c === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i) {
        flush();
        tokens.push({ kind: "code", text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (c === "[") {
      const labelEnd = text.indexOf("]", i + 1);
      if (labelEnd > i && text[labelEnd + 1] === "(") {
        const urlEnd = text.indexOf(")", labelEnd + 2);
        if (urlEnd > labelEnd) {
          flush();
          tokens.push({ kind: "link", text: text.slice(i + 1, labelEnd) });
          i = urlEnd + 1;
          continue;
        }
      }
    }

    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const marker = c + c;
      const end = text.indexOf(marker, i + 2);
      if (end > i + 1) {
        flush();
        const inner = text.slice(i + 2, end);
        for (const t of tokenizeInline(inner)) {
          if (t.kind === "text") tokens.push({ ...t, bold: true });
          else tokens.push(t);
        }
        i = end + 2;
        continue;
      }
    }

    if (c === "*" || c === "_") {
      const before = i > 0 ? text[i - 1] : undefined;
      if (!isWordChar(before)) {
        let end = -1;
        for (let j = i + 1; j < text.length; j++) {
          if (text[j] === c && !isWordChar(text[j + 1])) {
            end = j;
            break;
          }
        }
        if (end > i) {
          flush();
          tokens.push({ kind: "text", text: text.slice(i + 1, end), italic: true });
          i = end + 1;
          continue;
        }
      }
    }

    buf += c;
    i++;
  }
  flush();
  return tokens;
}

const HEADING_COLOR = "cyan";
const CODE_COLOR = "yellow";
const LINK_COLOR = "cyan";
const MARKER_COLOR = "cyan";
const TABLE_BORDER_COLOR = "cyan";

export function renderMarkdown(text: string, width?: number): ReactNode {
  const lines = tokenizeMarkdown(text);
  return (
    <Text>
      {lines.map((line, idx) => {
        const nl = idx < lines.length - 1 ? "\n" : "";
        return (
          <Fragment key={idx}>
            {renderLine(line, width)}
            {nl}
          </Fragment>
        );
      })}
    </Text>
  );
}

function renderLine(line: Line, width?: number): ReactNode {
  switch (line.kind) {
    case "blank":
      return null;
    case "heading":
      return (
        <Text color={HEADING_COLOR} bold>
          {renderInline(line.tokens)}
        </Text>
      );
    case "listitem":
      return (
        <Text>
          <Text color={MARKER_COLOR}>{line.marker}</Text>
          {renderInline(line.tokens)}
        </Text>
      );
    case "blockquote":
      return (
        <Text dimColor italic>
          {"│ "}
          {renderInline(line.tokens)}
        </Text>
      );
    case "codeblock":
      return <Text color={CODE_COLOR}>{line.text}</Text>;
    case "table":
      return renderTable(line, width);
    case "paragraph":
      return <Text>{renderInline(line.tokens)}</Text>;
  }
}

function renderInline(tokens: InlineToken[]): ReactNode {
  return tokens.map((t, idx) => {
    if (t.kind === "code") {
      return (
        <Text key={idx} color={CODE_COLOR}>
          {t.text}
        </Text>
      );
    }
    if (t.kind === "link") {
      return (
        <Text key={idx} color={LINK_COLOR} underline>
          {t.text}
        </Text>
      );
    }
    return (
      <Text key={idx} bold={t.bold} italic={t.italic}>
        {t.text}
      </Text>
    );
  });
}

function tokensWidth(tokens: InlineToken[]): number {
  let n = 0;
  for (const t of tokens) n += t.text.length;
  return n;
}

function cloneWithText(t: InlineToken, text: string): InlineToken {
  if (t.kind === "text") return { kind: "text", text, bold: t.bold, italic: t.italic };
  if (t.kind === "code") return { kind: "code", text };
  return { kind: "link", text };
}

function splitOnWhitespace(t: InlineToken): InlineToken[] {
  const parts = t.text.split(/(\s+)/).filter((s) => s.length > 0);
  return parts.map((p) => cloneWithText(t, p));
}

function isWhitespaceToken(t: InlineToken): boolean {
  return t.kind === "text" && /^\s+$/.test(t.text);
}

// Greedy word-wrap that preserves inline formatting. Splits tokens on
// whitespace into chunks, then packs chunks onto lines without exceeding
// `width`. Hard-splits any chunk longer than `width`.
export function wrapTokens(tokens: InlineToken[], width: number): InlineToken[][] {
  if (width <= 0) return [tokens];
  const chunks: InlineToken[] = tokens.flatMap(splitOnWhitespace);
  const lines: InlineToken[][] = [];
  let cur: InlineToken[] = [];
  let curLen = 0;
  for (const c of chunks) {
    if (curLen + c.text.length <= width) {
      cur.push(c);
      curLen += c.text.length;
      continue;
    }
    while (cur.length && isWhitespaceToken(cur[cur.length - 1]!)) {
      const last = cur.pop()!;
      curLen -= last.text.length;
    }
    if (cur.length) lines.push(cur);
    if (isWhitespaceToken(c)) {
      cur = [];
      curLen = 0;
    } else if (c.text.length > width) {
      for (let k = 0; k < c.text.length; k += width) {
        const piece = c.text.slice(k, k + width);
        if (k + width >= c.text.length) {
          cur = [cloneWithText(c, piece)];
          curLen = piece.length;
        } else {
          lines.push([cloneWithText(c, piece)]);
        }
      }
    } else {
      cur = [c];
      curLen = c.text.length;
    }
  }
  if (cur.length) lines.push(cur);
  return lines.length ? lines : [[]];
}

// Allocates column widths so the rendered table fits within `available`
// total width. `available` already excludes the table's border overhead.
// Natural widths shrink proportionally if needed, with a floor per column.
export function computeColumnWidths(
  natural: number[],
  available: number | undefined,
): number[] {
  if (available === undefined) return natural.slice();
  const ncols = natural.length;
  const minPer = 3;
  const totalNatural = natural.reduce((a, b) => a + b, 0);
  if (totalNatural <= available) return natural.slice();
  const floor = minPer * ncols;
  const target = Math.max(floor, available);
  if (totalNatural === 0) return new Array(ncols).fill(minPer);
  const widths = natural.map((n) =>
    Math.max(minPer, Math.floor((n * target) / totalNatural)),
  );
  let diff = target - widths.reduce((a, b) => a + b, 0);
  let idx = 0;
  while (diff !== 0 && ncols > 0) {
    if (diff > 0) {
      widths[idx % ncols]! += 1;
      diff--;
    } else {
      if (widths[idx % ncols]! > minPer) {
        widths[idx % ncols]! -= 1;
        diff++;
      }
    }
    idx++;
    if (idx > ncols * 10) break;
  }
  return widths;
}

function padCellLine(used: number, target: number, align: TableAlign): { lead: string; trail: string } {
  const slack = Math.max(0, target - used);
  if (align === "right") return { lead: " ".repeat(slack), trail: "" };
  if (align === "center") {
    const left = Math.floor(slack / 2);
    return { lead: " ".repeat(left), trail: " ".repeat(slack - left) };
  }
  return { lead: "", trail: " ".repeat(slack) };
}

function renderCellTokens(tokens: InlineToken[], isHeader: boolean): ReactNode {
  return tokens.map((t, idx) => {
    if (t.kind === "code") {
      return (
        <Text key={idx} color={CODE_COLOR}>
          {t.text}
        </Text>
      );
    }
    if (t.kind === "link") {
      return (
        <Text key={idx} color={LINK_COLOR} underline>
          {t.text}
        </Text>
      );
    }
    if (isHeader) {
      return (
        <Text key={idx} color={HEADING_COLOR} bold italic={t.italic}>
          {t.text}
        </Text>
      );
    }
    return (
      <Text key={idx} bold={t.bold} italic={t.italic}>
        {t.text}
      </Text>
    );
  });
}

function borderRow(
  positions: { left: string; mid: string; right: string },
  widths: number[],
): ReactNode {
  let s = positions.left;
  for (let i = 0; i < widths.length; i++) {
    s += "─".repeat(widths[i]! + 2);
    s += i < widths.length - 1 ? positions.mid : positions.right;
  }
  return <Text color={TABLE_BORDER_COLOR}>{s}</Text>;
}

function renderTableDataRow(
  cells: InlineToken[][],
  widths: number[],
  aligns: TableAlign[],
  isHeader: boolean,
): ReactNode[] {
  const ncols = widths.length;
  const wrapped = cells.map((tokens, i) => wrapTokens(tokens, widths[i]!));
  const height = Math.max(1, ...wrapped.map((c) => c.length));
  const out: ReactNode[] = [];
  for (let h = 0; h < height; h++) {
    out.push(
      <Text>
        <Text color={TABLE_BORDER_COLOR}>│</Text>
        {Array.from({ length: ncols }, (_, i) => {
          const lineTokens = wrapped[i]?.[h] ?? [];
          const used = tokensWidth(lineTokens);
          const pad = padCellLine(used, widths[i]!, aligns[i] ?? "left");
          return (
            <Fragment key={i}>
              <Text>{` ${pad.lead}`}</Text>
              {renderCellTokens(lineTokens, isHeader)}
              <Text>{`${pad.trail} `}</Text>
              <Text color={TABLE_BORDER_COLOR}>│</Text>
            </Fragment>
          );
        })}
      </Text>,
    );
  }
  return out;
}

function renderTable(
  line: Extract<Line, { kind: "table" }>,
  width?: number,
): ReactNode {
  const ncols = line.header.length;
  if (ncols === 0) return null;
  const natural = new Array(ncols).fill(0) as number[];
  const allRows: InlineToken[][][] = [line.header, ...line.rows];
  for (const row of allRows) {
    for (let i = 0; i < ncols; i++) {
      const w = tokensWidth(row[i] ?? []);
      if (w > natural[i]!) natural[i] = w;
    }
  }
  // Each cell renders as "│ <content> " — 3 chars overhead per cell — plus a
  // trailing "│" closing the row. Total overhead = 3*ncols + 1.
  const overhead = 3 * ncols + 1;
  const available = width !== undefined ? Math.max(0, width - overhead) : undefined;
  const widths = computeColumnWidths(natural, available);

  const nodes: ReactNode[] = [];
  nodes.push(borderRow({ left: "┌", mid: "┬", right: "┐" }, widths));
  nodes.push(...renderTableDataRow(line.header, widths, line.aligns, true));
  nodes.push(borderRow({ left: "├", mid: "┼", right: "┤" }, widths));
  for (const row of line.rows) {
    nodes.push(...renderTableDataRow(row, widths, line.aligns, false));
  }
  nodes.push(borderRow({ left: "└", mid: "┴", right: "┘" }, widths));

  return (
    <>
      {nodes.map((node, idx) => (
        <Fragment key={idx}>
          {node}
          {idx < nodes.length - 1 ? "\n" : ""}
        </Fragment>
      ))}
    </>
  );
}
