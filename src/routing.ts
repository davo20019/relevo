import { SLASH_COMMANDS } from "./config.js";

const AGENT_TOKEN = /^@([A-Za-z0-9_\-]+)[,.;:!?]*\s*([\s\S]*)$/;
const ANY_MENTION = /@([A-Za-z0-9_\-]+)/g;
export const ALL_TOKEN = /^@all\b[,.;:!?]*\s*/i;

// Word-shaped soft connectors users actually type between agent mentions in
// natural multi-dispatches: "@claude and @codex hi", "@claude, @codex hi",
// "@claude + @codex hi", "@claude & @codex hi". Standalone punctuation like
// `,` or `;` is also accepted.
const MULTI_CONNECTOR = /^(?:and|&|\+|,|;)/i;

export type Pending = { pendingPrompt: string | null };

export function expandAll(line: string, knownAgents: string[]): string {
  if (!line) return line;
  const trimmed = line.trimStart();
  const m = ALL_TOKEN.exec(trimmed);
  if (!m) return line;
  const body = trimmed.slice(m[0].length);
  const mentions = knownAgents.map((n) => `@${n}`).join(" ");
  if (!body) return mentions;
  return `${mentions} ${body}`.trimEnd();
}

export function isKnownCommand(line: string): boolean {
  const stripped = line.trimStart();
  if (!stripped.startsWith("/")) return false;
  const first = stripped.split(/\s/, 1)[0]!;
  return (SLASH_COMMANDS as readonly string[]).includes(first);
}

export function parseMulti(
  line: string,
  knownAgents: string[],
): { agents: string[]; body: string } | null {
  // Walk a leading sequence of `@<known>` mentions, tolerating whitespace and
  // soft connector words between them. Stop at the first thing that isn't a
  // known mention or a connector — that's where the prompt body begins.
  //
  // Matches: "@a @b hi", "@a and @b hi", "@a, @b hi", "@a+@b hi",
  //          "@a, @b, @c review this"
  // Doesn't match (falls through to single-dispatch routing):
  //   "@a hi"               — only one mention
  //   "and @a @b hi"        — leading non-mention text
  //   "@unknown @a hi"      — first mention isn't a configured agent
  const trimmed = line.trim();
  const mentions: string[] = [];
  let i = 0;

  const skipWs = (): void => {
    while (i < trimmed.length && /\s/.test(trimmed[i]!)) i++;
  };
  const tryConnector = (): boolean => {
    const rest = trimmed.slice(i);
    const m = MULTI_CONNECTOR.exec(rest);
    if (!m) return false;
    // Require a word-boundary so "android" doesn't get parsed as "and".
    const next = rest[m[0].length];
    if (m[0].toLowerCase() === "and" && next !== undefined && /[A-Za-z]/.test(next)) {
      return false;
    }
    i += m[0].length;
    return true;
  };

  while (i < trimmed.length) {
    skipWs();
    if (mentions.length > 0) {
      // Optional connector between mentions, then more whitespace.
      tryConnector();
      skipWs();
    }
    if (trimmed[i] !== "@") break;
    const m = /^@([A-Za-z0-9_\-]+)[,.;:!?]*/.exec(trimmed.slice(i));
    if (!m) break;
    const name = m[1]!;
    if (!knownAgents.includes(name)) break;
    mentions.push(name);
    i += m[0].length;
  }

  if (mentions.length < 2) return null;
  const seen: string[] = [];
  for (const a of mentions) if (!seen.includes(a)) seen.push(a);
  if (seen.length < 2) return null;
  return { agents: seen, body: trimmed.slice(i).trim() };
}

export function smartRoute(line: string, knownAgents: string[]): string {
  if (!line) return line;
  if (isKnownCommand(line)) return line;
  if (line.startsWith("@")) {
    const head = AGENT_TOKEN.exec(line);
    if (head && knownAgents.includes(head[1]!)) return line;
  }
  const matches: { start: number; end: number; name: string }[] = [];
  let m: RegExpExecArray | null;
  ANY_MENTION.lastIndex = 0;
  while ((m = ANY_MENTION.exec(line))) {
    if (knownAgents.includes(m[1]!)) {
      matches.push({ start: m.index, end: ANY_MENTION.lastIndex, name: m[1]! });
    }
  }
  if (matches.length === 0) return line;
  const last = matches[matches.length - 1]!;
  let end = last.end;
  while (end < line.length && ",.;:!?".includes(line[end]!)) end++;
  let rest = (line.slice(0, last.start) + line.slice(end)).trim();
  rest = rest.replace(/\s+/g, " ");
  return rest ? `@${last.name} ${rest}` : `@${last.name}`;
}

export type ParsedLine =
  | { kind: "empty" }
  | { kind: "command"; content: string }
  | { kind: "agent"; agent: string; content: string }
  | { kind: "untagged"; content: string };

export function parseLine(line: string): ParsedLine {
  const t = line.trim();
  if (!t) return { kind: "empty" };
  if (isKnownCommand(t)) return { kind: "command", content: t };
  if (t.startsWith("@")) {
    const m = AGENT_TOKEN.exec(t);
    if (m) return { kind: "agent", agent: m[1]!, content: (m[2] ?? "").trim() };
  }
  return { kind: "untagged", content: t };
}

export function prepareDispatchLine(
  line: string,
  knownAgents: string[],
  state: Pending,
  focusAgent: string | null = null,
): string | null {
  const routed = smartRoute(line, knownAgents);
  const parsed = parseLine(routed);
  if (parsed.kind === "untagged") {
    if (focusAgent && knownAgents.includes(focusAgent)) {
      state.pendingPrompt = null;
      return parsed.content ? `@${focusAgent} ${parsed.content}` : `@${focusAgent}`;
    }
    state.pendingPrompt = parsed.content;
    return null;
  }
  if (
    parsed.kind === "agent" &&
    knownAgents.includes(parsed.agent) &&
    !parsed.content &&
    state.pendingPrompt
  ) {
    const pending = state.pendingPrompt;
    state.pendingPrompt = null;
    return `@${parsed.agent} ${pending}`;
  }
  if (parsed.kind === "agent" && knownAgents.includes(parsed.agent) && parsed.content) {
    state.pendingPrompt = null;
  }
  return routed;
}

export function requestedPeerAgents(
  content: string,
  targetAgent: string,
  knownAgents: readonly string[],
): string[] {
  const out: string[] = [];
  ANY_MENTION.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANY_MENTION.exec(content))) {
    const name = m[1]!;
    if (name === targetAgent) continue;
    if (!knownAgents.includes(name)) continue;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}
