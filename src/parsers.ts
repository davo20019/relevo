export type ParseKind = "message" | "command" | "edit" | "session_id" | null;
export type ParseResult = { kind: ParseKind; payload: string | null };

export type LineParser = (line: string) => ParseResult;

const NULL: ParseResult = { kind: null, payload: null };

export function parserRaw(line: string): ParseResult {
  return { kind: "message", payload: line };
}

export function parserCodexJson(line: string): ParseResult {
  // Filter codex's --json event stream into typed events.
  const stripped = line.trim();
  if (!stripped) return NULL;
  let evt: any;
  try {
    evt = JSON.parse(stripped);
  } catch {
    const low = stripped.toLowerCase();
    if (low.startsWith("error:") || low.startsWith("usage:")) {
      return { kind: "message", payload: stripped + "\n" };
    }
    return NULL;
  }
  const t = evt?.type ?? "";
  if (t === "thread.started") {
    const tid = evt.thread_id;
    if (tid) return { kind: "session_id", payload: String(tid) };
  }
  if (t === "item.completed") {
    const item = evt.item ?? {};
    const itype = item.type ?? "";
    if (itype === "agent_message") {
      return { kind: "message", payload: (item.text ?? "") + "\n\n" };
    }
    if (itype === "command_execution") {
      const cmd = String(item.command ?? "");
      const short = cmd.length <= 120 ? cmd : cmd.slice(0, 117) + "...";
      return { kind: "command", payload: short };
    }
    if (itype === "file_change" || itype === "patch_apply") {
      const p = item.path ?? item.file ?? "";
      return { kind: "edit", payload: String(p) };
    }
  }
  return NULL;
}

// Heuristic narration starters for agy. agy 1.0.1 has no JSON output mode, so
// the parser walks its plain-text stream and routes anything that looks like
// "I'm about to do X" to the hidden command counter rather than rendering it.
// Each entry is a *prefix* (matched with startsWith). Prefer phrases that
// almost always begin a plan/narration line and rarely begin a final answer:
//   ✓ safe: "I will", "Let me", "Going to", "Reading", "Examining"
//   ✗ risky: "I see", "I have", "Found", "Based on" — too often answer openers
const AGY_PLAN_PREFIXES = [
  // first-person plan statements
  "I will ",
  "I'll ",
  "I am going to ",
  "I'm going to ",
  "I need to ",
  "I should ",
  "I'm planning to ",
  // explicit transitions
  "Let me ",
  "Let's ",
  "First, I ",
  "First I ",
  "Next, I ",
  "Then I ",
  "Now I ",
  "Now I'll ",
  "Now let me ",
  "To start, ",
  "To begin, ",
  "Step ",
  // tool-action narration (extremely common in agy)
  "Going to ",
  "Reading ",
  "Examining ",
  "Searching ",
  "Checking ",
  "Looking at ",
  "Inspecting ",
  "Scanning ",
  "Listing ",
  "Loading ",
  "Opening ",
  "Running ",
  "Executing ",
  // status-y narration
  "Calling ",
  "Invoking ",
];

export function parserCursorJson(line: string): ParseResult {
  // Filter Cursor's --output-format stream-json into typed events.
  const stripped = line.trim();
  if (!stripped) return NULL;
  let evt: any;
  try {
    evt = JSON.parse(stripped);
  } catch {
    const low = stripped.toLowerCase();
    if (low.startsWith("error:") || low.startsWith("usage:")) {
      return { kind: "message", payload: stripped + "\n" };
    }
    return NULL;
  }
  const t = evt?.type ?? "";
  const sub = evt?.subtype ?? "";
  if (t === "assistant") {
    const parts = evt?.message?.content ?? [];
    const text = Array.isArray(parts)
      ? parts.filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("")
      : "";
    if (text) return { kind: "message", payload: text + "\n\n" };
    return NULL;
  }
  if (t === "tool_call" && sub === "started") {
    const tc = evt?.tool_call ?? {};
    const shell = tc?.shellToolCall;
    if (shell) {
      const cmd = String(shell?.args?.command ?? shell?.description ?? "");
      const short = cmd.length <= 120 ? cmd : cmd.slice(0, 117) + "...";
      return { kind: "command", payload: short };
    }
    // Best-effort edit detection for non-shell tool calls (write/edit/patch).
    for (const [key, val] of Object.entries(tc)) {
      if (!val || typeof val !== "object") continue;
      const kl = key.toLowerCase();
      if (kl.includes("write") || kl.includes("edit") || kl.includes("patch")) {
        const args = (val as any).args ?? {};
        const p = args.path ?? args.file ?? args.filePath;
        if (p) return { kind: "edit", payload: String(p) };
      }
    }
    return NULL;
  }
  if (t === "result") {
    const text = evt?.result ?? "";
    if (text) return { kind: "message", payload: text + "\n\n" };
    if (evt?.is_error) {
      const msg = evt?.error ?? evt?.message ?? `error (${sub || "unknown"})`;
      return { kind: "message", payload: `[error] ${msg}\n` };
    }
    return NULL;
  }
  return NULL;
}

export function parserAgyText(line: string): ParseResult {
  // Heuristic parser for agy's verbose plain-text headless output.
  const stripped = line.trim();
  if (!stripped) return { kind: "message", payload: line };
  if (AGY_PLAN_PREFIXES.some((p) => stripped.startsWith(p))) {
    return { kind: "command", payload: stripped };
  }
  return { kind: "message", payload: line };
}

export const PARSERS: Record<string, LineParser> = {
  raw: parserRaw,
  "codex-json": parserCodexJson,
  "cursor-json": parserCursorJson,
  "agy-text": parserAgyText,
};

// Rust `tracing` lines: ISO8601 timestamp, level, then a `module::path:` prefix.
// These dominate codex's stderr on failure and obscure the real error.
const RUST_TRACE_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+\S+:/;

export function renderRawFallback(rawLines: string[]): string {
  // Turn buffered subprocess output into something readable when the parser found nothing.
  const out: string[] = [];
  for (const line of rawLines) {
    const s = line.trim();
    if (!s) continue;
    if (RUST_TRACE_RE.test(s)) continue;
    let evt: any;
    try {
      evt = JSON.parse(s);
    } catch {
      out.push(line.replace(/\n$/, ""));
      continue;
    }
    if (!evt || typeof evt !== "object") {
      out.push(line.replace(/\n$/, ""));
      continue;
    }
    const t = evt.type ?? "";
    const sub = evt.subtype ?? "";
    if (t === "result") {
      const text = evt.result ?? "";
      if (text) out.push(text);
      else if (evt.is_error) {
        const msg = evt.error ?? evt.message ?? `error (${sub || "unknown"})`;
        out.push(`[error] ${msg}`);
      }
      continue;
    }
    if (t === "assistant") {
      const parts = evt?.message?.content ?? [];
      const text = Array.isArray(parts)
        ? parts.filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("")
        : "";
      if (text) out.push(text);
      continue;
    }
    if (t === "item.completed") {
      const item = evt.item ?? {};
      if (item.type === "agent_message") {
        const msg = item.text ?? "";
        if (msg) out.push(msg);
      }
      continue;
    }
    if (t === "system" || t === "error") {
      const msg = evt.message ?? evt.error ?? evt.text ?? "";
      if (msg) {
        const label = sub ? `${t}:${sub}` : t;
        out.push(`[${label}] ${msg}`);
      }
      continue;
    }
  }
  return out.join("\n");
}
