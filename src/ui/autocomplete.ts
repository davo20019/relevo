// Pure helpers for the input-area autocomplete. Kept framework-free so they can
// be unit-tested without spinning up Ink.

export type TokenInfo = {
  start: number;
  end: number;
  text: string; // includes the leading sigil (/ or @)
  kind: "slash" | "mention";
};

// Return the slash- or @-prefixed token the cursor sits in or just after.
// Returns null if the cursor isn't touching an autocompletable token.
export function tokenUnderCursor(value: string, cursor: number): TokenInfo | null {
  if (cursor < 0 || cursor > value.length) return null;
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start--;
  // Find the end of the token (first whitespace after cursor).
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end]!)) end++;
  if (start === end) return null;
  const text = value.slice(start, end);
  const sigil = text[0];
  if (sigil === "/") {
    // Only treat as a slash-command token if it's the first non-space token of
    // the current line. Paths/URLs further into a prompt shouldn't trigger.
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const leading = value.slice(lineStart, start);
    if (/\S/.test(leading)) return null;
    return { start, end, text, kind: "slash" };
  }
  if (sigil === "@") return { start, end, text, kind: "mention" };
  return null;
}

export function filterSuggestions(
  token: TokenInfo,
  slashCommands: readonly string[],
  agents: readonly string[],
): string[] {
  const q = token.text.slice(1).toLowerCase(); // strip the sigil
  const source: string[] =
    token.kind === "slash" ? [...slashCommands] : agents.map((a) => `@${a}`);
  if (token.kind === "mention" && agents.length > 0 && !source.includes("@all")) {
    // Include @all as a synthetic mention.
    source.push("@all");
  }
  if (!q) return source.slice(0, 8);
  // Prefer prefix matches, then substring matches; case-insensitive.
  const prefix: string[] = [];
  const sub: string[] = [];
  for (const cand of source) {
    const stripped = cand.startsWith("/") ? cand.slice(1) : cand.slice(1);
    const low = stripped.toLowerCase();
    if (low === q) prefix.unshift(cand);
    else if (low.startsWith(q)) prefix.push(cand);
    else if (low.includes(q)) sub.push(cand);
  }
  return [...prefix, ...sub].slice(0, 8);
}

export function applySuggestion(
  value: string,
  token: TokenInfo,
  suggestion: string,
): { value: string; cursor: number } {
  const before = value.slice(0, token.start);
  const after = value.slice(token.end);
  // Add a trailing space after the suggestion if the next char isn't already
  // whitespace, so the user can keep typing the prompt body immediately.
  const needsSpace = after.length === 0 || !/^\s/.test(after);
  const inserted = needsSpace ? suggestion + " " : suggestion;
  const next = before + inserted + after;
  return { value: next, cursor: before.length + inserted.length };
}
