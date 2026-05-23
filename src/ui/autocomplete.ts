// Pure helpers for the input-area autocomplete. Kept framework-free so they can
// be unit-tested without spinning up Ink.

export type TokenInfo =
  | { kind: "slash"; start: number; end: number; text: string }
  | { kind: "mention"; start: number; end: number; text: string }
  | {
      kind: "slash-arg";
      start: number;
      end: number;
      text: string; // partial arg, no sigil
      command: string; // e.g. "/agents"
      argIndex: number; // 0-based position among args
    };

// Schema describing the positional arguments each slash command accepts.
// Each entry is either a fixed list of literal subcommand names, or the
// special value "agent" meaning "complete with the configured agent names."
type ArgSpec = { type: "literal"; values: readonly string[] } | { type: "agent" };

// Short descriptions shown next to slash-command suggestions in the autocomplete
// dropdown. Keep these tight (≤ ~70 chars) so the dropdown stays readable in
// narrow terminals. Commands omitted here render with no description.
export const SLASH_COMMAND_DESCRIPTIONS: Record<string, string> = {
  "/open": "open agent's CLI natively in a new window, resumed at this session",
};

const COMMAND_ARGS: Record<string, readonly ArgSpec[]> = {
  "/agents": [
    { type: "literal", values: ["enable", "disable"] },
    { type: "agent" },
  ],
  "/last": [{ type: "agent" }],
  "/tail": [{ type: "agent" }],
  "/open": [{ type: "agent" }],
  "/task": [{ type: "literal", values: ["list", "new", "rename"] }],
  "/image": [{ type: "literal", values: ["paste", "list", "clear"] }],
};

// Return the token (or slash-arg context) the cursor sits in or just after.
// Returns null if the cursor isn't touching an autocompletable position.
export function tokenUnderCursor(value: string, cursor: number): TokenInfo | null {
  if (cursor < 0 || cursor > value.length) return null;
  let start = cursor;
  while (start > 0 && !/\s/.test(value[start - 1]!)) start--;
  let end = cursor;
  while (end < value.length && !/\s/.test(value[end]!)) end++;

  if (start !== end) {
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
  }

  // Fall through: maybe we're on or just after an argument of a known slash
  // command. Detect that even if the partial word is empty (cursor on
  // whitespace right after typing `/agents `).
  return slashArgContext(value, cursor, start, end);
}

function slashArgContext(
  value: string,
  cursor: number,
  wordStart: number,
  wordEnd: number,
): TokenInfo | null {
  const lineStart = value.lastIndexOf("\n", cursor - 1) + 1;
  let lineEnd = value.indexOf("\n", cursor);
  if (lineEnd === -1) lineEnd = value.length;
  const line = value.slice(lineStart, lineEnd);
  if (!line.startsWith("/")) return null;
  const m = line.match(/^(\/\S+)/);
  if (!m) return null;
  const command = m[1]!;
  if (!(command in COMMAND_ARGS)) return null;
  // The current word must start strictly after the command token.
  const wStartCol = wordStart - lineStart;
  if (wStartCol < command.length) return null;
  const between = line.slice(command.length, wStartCol);
  const argIndex = (between.match(/\S+/g) || []).length;
  return {
    kind: "slash-arg",
    start: wordStart,
    end: wordEnd,
    text: value.slice(wordStart, wordEnd),
    command,
    argIndex,
  };
}

export function filterSuggestions(
  token: TokenInfo,
  slashCommands: readonly string[],
  agents: readonly string[],
): string[] {
  if (token.kind === "slash-arg") {
    const spec = COMMAND_ARGS[token.command]?.[token.argIndex];
    if (!spec) return [];
    const source = spec.type === "literal" ? [...spec.values] : [...agents];
    return rank(source, token.text);
  }
  const q = token.text.slice(1).toLowerCase(); // strip the sigil
  const source: string[] =
    token.kind === "slash" ? [...slashCommands] : agents.map((a) => `@${a}`);
  if (token.kind === "mention" && agents.length > 0 && !source.includes("@all")) {
    // Include @all as a synthetic mention.
    source.push("@all");
  }
  if (!q) return source.slice(0, 8);
  return rankSigiled(source, q);
}

function rank(source: readonly string[], partial: string): string[] {
  const q = partial.toLowerCase();
  if (!q) return source.slice(0, 8);
  const prefix: string[] = [];
  const sub: string[] = [];
  for (const cand of source) {
    const low = cand.toLowerCase();
    if (low === q) prefix.unshift(cand);
    else if (low.startsWith(q)) prefix.push(cand);
    else if (low.includes(q)) sub.push(cand);
  }
  return [...prefix, ...sub].slice(0, 8);
}

function rankSigiled(source: readonly string[], q: string): string[] {
  const prefix: string[] = [];
  const sub: string[] = [];
  for (const cand of source) {
    const stripped = cand.slice(1);
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
