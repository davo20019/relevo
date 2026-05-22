import { SLASH_COMMANDS } from "./config.js";

const AGENT_TOKEN = /^@([A-Za-z0-9_\-]+)[,.;:!?]*\s*([\s\S]*)$/;
const ANY_MENTION = /@([A-Za-z0-9_\-]+)/g;
const MULTI_PREFIX = /^((?:@[A-Za-z0-9_\-]+[,.;:!?]*\s+)+)([\s\S]*)$/;
export const ALL_TOKEN = /^@all\b[,.;:!?]*\s*/i;

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
  const trimmed = line.trim();
  const m = MULTI_PREFIX.exec(trimmed);
  if (!m) return null;
  const prefix = m[1]!;
  const body = m[2]!;
  const mentions: string[] = [];
  let mm: RegExpExecArray | null;
  const re = /@([A-Za-z0-9_\-]+)/g;
  while ((mm = re.exec(prefix))) mentions.push(mm[1]!);
  if (mentions.length < 2) return null;
  if (!mentions.every((a) => knownAgents.includes(a))) return null;
  const seen: string[] = [];
  for (const a of mentions) if (!seen.includes(a)) seen.push(a);
  if (seen.length < 2) return null;
  return { agents: seen, body: body.trim() };
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
): string | null {
  const routed = smartRoute(line, knownAgents);
  const parsed = parseLine(routed);
  if (parsed.kind === "untagged") {
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
