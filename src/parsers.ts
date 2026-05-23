export type ParseKind =
  | "message"
  | "command"
  | "edit"
  | "session_id"
  | "tool"
  | "usage"
  | null;
export type ParseResult = { kind: ParseKind; payload: string | null };

export type LineParser = (line: string) => ParseResult | ParseResult[];

const NULL: ParseResult = { kind: null, payload: null };

// Token-usage payloads are JSON-encoded so the existing ParseResult shape
// (string payloads only) survives unchanged. Consumers parse via parseUsagePayload.
export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
};

export function parseUsagePayload(payload: string | null): TokenUsage | null {
  if (!payload) return null;
  try {
    const obj = JSON.parse(payload);
    if (!obj || typeof obj !== "object") return null;
    return {
      input: Number(obj.input ?? 0),
      output: Number(obj.output ?? 0),
      cacheRead: Number(obj.cacheRead ?? 0),
      cacheCreate: Number(obj.cacheCreate ?? 0),
    };
  } catch {
    return null;
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + "...";
}

export function parserRaw(line: string): ParseResult {
  return { kind: "message", payload: line };
}

function extractCodexUsage(usageObj: any): ParseResult | null {
  if (!usageObj || typeof usageObj !== "object") return null;
  // codex's totals: input_tokens is gross input (includes cached), with the
  // cached portion called out separately. Split into uncached + cacheRead so
  // the totalIn math in run.ts matches across providers. codex has no
  // cache-creation analog. reasoning_output_tokens is hidden CoT and is left
  // out of `output` so the display reflects what the user actually received.
  const grossIn = Number(usageObj.input_tokens ?? 0);
  const cacheRead = Number(usageObj.cached_input_tokens ?? 0);
  const output = Number(usageObj.output_tokens ?? 0);
  if (!grossIn && !output && !cacheRead) return null;
  const input = Math.max(0, grossIn - cacheRead);
  return {
    kind: "usage",
    payload: JSON.stringify({ input, output, cacheRead, cacheCreate: 0 }),
  };
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
  // Surface command_execution on `item.started` so the live panel shows the
  // running command immediately instead of waiting for it to finish. Counted
  // exactly once per command since we skip command_execution on item.completed.
  if (t === "item.started") {
    const item = evt.item ?? {};
    if (item.type === "command_execution") {
      const cmd = String(item.command ?? "");
      const short = cmd.length <= 120 ? cmd : cmd.slice(0, 117) + "...";
      return { kind: "command", payload: short };
    }
  }
  if (t === "item.completed") {
    const item = evt.item ?? {};
    const itype = item.type ?? "";
    if (itype === "agent_message") {
      return { kind: "message", payload: (item.text ?? "") + "\n\n" };
    }
    if (itype === "file_change" || itype === "patch_apply") {
      const p = item.path ?? item.file ?? "";
      return { kind: "edit", payload: String(p) };
    }
  }
  if (t === "turn.completed") {
    const usage = extractCodexUsage(evt.usage);
    if (usage) return usage;
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

// Tool names whose execution we surface as `edit` events. Anything else (besides
// Bash, which becomes `command`) surfaces as a `tool` event with a target preview.
const CLAUDE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Picks a one-line "target" for a Claude tool_use input so the UI can show
// "Reading src/foo.ts" instead of just "Read". Defensive against missing fields.
function claudeToolTarget(name: string, input: any): string {
  if (!input || typeof input !== "object") return "";
  if (name === "Grep") {
    const pat = typeof input.pattern === "string" ? input.pattern : "";
    const path = typeof input.path === "string" ? input.path : "";
    if (pat && path) return `${truncate(pat, 30)} in ${truncate(path, 30)}`;
    if (pat) return truncate(pat, 60);
  }
  if (name === "Glob" && typeof input.pattern === "string") {
    return truncate(input.pattern, 60);
  }
  if (name === "WebSearch" && typeof input.query === "string") {
    return truncate(input.query, 60);
  }
  if ((name === "Task" || name === "TaskCreate") &&
      (typeof input.subject === "string" || typeof input.description === "string")) {
    return truncate(String(input.subject ?? input.description), 60);
  }
  for (const key of ["file_path", "notebook_path", "path", "url", "pattern", "query"]) {
    const v = input[key];
    if (typeof v === "string" && v) return truncate(v, 60);
  }
  return "";
}

function extractClaudeUsage(usageObj: any): ParseResult | null {
  if (!usageObj || typeof usageObj !== "object") return null;
  const input = Number(usageObj.input_tokens ?? 0);
  const output = Number(usageObj.output_tokens ?? 0);
  const cacheRead = Number(usageObj.cache_read_input_tokens ?? 0);
  const cacheCreate = Number(usageObj.cache_creation_input_tokens ?? 0);
  if (!input && !output && !cacheRead && !cacheCreate) return null;
  return {
    kind: "usage",
    payload: JSON.stringify({ input, output, cacheRead, cacheCreate }),
  };
}

export function parserClaudeJson(line: string): ParseResult | ParseResult[] {
  // Filter claude's --output-format stream-json events into typed results.
  // A single `assistant` event line can carry both text and tool_use blocks,
  // so this parser returns an array.
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
  if (t === "system" && evt?.subtype === "init") {
    const sid = evt?.session_id;
    if (sid) return { kind: "session_id", payload: String(sid) };
    return NULL;
  }
  if (t === "assistant") {
    const parts = evt?.message?.content ?? [];
    if (!Array.isArray(parts)) return NULL;
    const results: ParseResult[] = [];
    const textPieces: string[] = [];
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text" && typeof p.text === "string" && p.text) {
        textPieces.push(p.text);
      } else if (p.type === "tool_use") {
        const name = String(p.name ?? "");
        const input = p.input ?? {};
        if (name === "Bash") {
          const cmd = String(input.command ?? input.description ?? "");
          if (cmd) results.push({ kind: "command", payload: truncate(cmd, 120) });
        } else if (CLAUDE_EDIT_TOOLS.has(name)) {
          const p2 = input.file_path ?? input.notebook_path ?? "";
          if (p2) results.push({ kind: "edit", payload: String(p2) });
        } else if (name) {
          const target = claudeToolTarget(name, input);
          results.push({ kind: "tool", payload: target ? `${name} ${target}` : name });
        }
      }
    }
    if (textPieces.length) {
      results.unshift({ kind: "message", payload: textPieces.join("") + "\n\n" });
    }
    const usage = extractClaudeUsage(evt?.message?.usage);
    if (usage) results.push(usage);
    return results.length ? results : NULL;
  }
  if (t === "result") {
    const results: ParseResult[] = [];
    if (evt?.is_error) {
      const msg = evt?.result ?? evt?.error ?? evt?.message ?? `error (${evt?.subtype ?? "unknown"})`;
      results.push({ kind: "message", payload: `[error] ${msg}\n` });
    }
    // Otherwise the final assistant turn already streamed via `assistant`
    // events, so re-emitting `result.result` would duplicate it. The stateful
    // wrapper handles the no-text-streamed fallback.
    const usage = extractClaudeUsage(evt?.usage);
    if (usage) results.push(usage);
    return results.length ? results : NULL;
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

// Stateful claude-json parser: tracks whether any assistant text was emitted
// during the stream. If no `assistant` event carried text by the time the
// terminal `result` event arrives, surface `result.result` so a short-circuit
// reply that lives only in the result block is not silently dropped. The
// stateless `parserClaudeJson` (above) keeps its existing contract for tests
// and any caller that does not want this fallback.
export function createClaudeJsonParser(): LineParser {
  let sawAssistantText = false;
  let sawResult = false;
  return (line: string): ParseResult | ParseResult[] => {
    const stripped = line.trim();
    let evt: any = null;
    if (stripped) {
      try {
        evt = JSON.parse(stripped);
      } catch {
        // Not JSON: fall through to the stateless parser.
      }
    }
    if (evt?.type === "result") {
      // A duplicate result event would re-emit usage; suppress.
      if (sawResult) return NULL;
      sawResult = true;
      const results: ParseResult[] = [];
      if (evt?.is_error) {
        const msg = evt?.result ?? evt?.error ?? evt?.message ?? `error (${evt?.subtype ?? "unknown"})`;
        results.push({ kind: "message", payload: `[error] ${msg}\n` });
      } else if (!sawAssistantText) {
        const text = typeof evt?.result === "string" ? evt.result.trim() : "";
        if (text) {
          sawAssistantText = true;
          results.push({ kind: "message", payload: text + "\n" });
        }
      }
      const usage = extractClaudeUsage(evt?.usage);
      if (usage) results.push(usage);
      return results.length ? results : NULL;
    }
    const out = parserClaudeJson(line);
    const arr = Array.isArray(out) ? out : [out];
    for (const r of arr) {
      // Only mark assistant-text seen for genuine assistant chunks. Error
      // messages from result events also use kind: "message" but flow through
      // the is_error branch, which we never reach with a non-error result.
      if (r.kind === "message" && r.payload && !r.payload.startsWith("[error]")) {
        sawAssistantText = true;
        break;
      }
    }
    return out;
  };
}

// Each entry is a factory so stateful parsers (claude-json) get a fresh
// closure per dispatched run. Stateless parsers ignore the call.
export const PARSERS: Record<string, () => LineParser> = {
  raw: () => parserRaw,
  "codex-json": () => parserCodexJson,
  "cursor-json": () => parserCursorJson,
  "claude-json": createClaudeJsonParser,
  "agy-text": () => parserAgyText,
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
