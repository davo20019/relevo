import { describe, expect, it } from "vitest";
import {
  createClaudeJsonParser,
  parserClaudeJson,
  parserCodexJson,
  parserCursorJson,
  parserAgyText,
  renderRawFallback,
  type ParseResult,
} from "../src/parsers.js";

const toArr = (r: ParseResult | ParseResult[]): ParseResult[] =>
  Array.isArray(r) ? r : [r];

describe("parserCodexJson", () => {
  it("captures thread.started session_id", () => {
    const r = parserCodexJson('{"type":"thread.started","thread_id":"abc-123"}');
    expect(r).toEqual({ kind: "session_id", payload: "abc-123" });
  });

  it("surfaces agent_message items as messages", () => {
    const r = parserCodexJson(
      '{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}',
    );
    expect(r.kind).toBe("message");
    expect(r.payload).toContain("hi");
  });

  it("suppresses unknown JSON events", () => {
    expect(parserCodexJson('{"type":"banner","text":"hello"}').kind).toBeNull();
  });

  it("surfaces clap-style error: lines", () => {
    expect(parserCodexJson("error: unknown flag --foo").kind).toBe("message");
  });
});

describe("parserCursorJson", () => {
  it("unwraps a result event into a message", () => {
    const evt =
      '{"type":"result","subtype":"error_max_usage","is_error":true,' +
      '"result":"Hit usage limit. Get Cursor Pro for more agent usage.",' +
      '"session_id":"abc-123"}';
    const r = parserCursorJson(evt);
    expect(r.kind).toBe("message");
    expect(r.payload).toContain("Hit usage limit");
  });

  it("joins assistant text parts", () => {
    const r = parserCursorJson(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"},{"type":"text","text":" world"}]}}',
    );
    expect(r.kind).toBe("message");
    expect(r.payload).toContain("hello world");
  });

  it("captures tool_call started shell commands", () => {
    const evt =
      '{"type":"tool_call","subtype":"started","tool_call":{"shellToolCall":{"args":{"command":"ls -la"}}}}';
    const r = parserCursorJson(evt);
    expect(r.kind).toBe("command");
    expect(r.payload).toBe("ls -la");
  });
});

describe("parserClaudeJson", () => {
  it("captures session_id from system init", () => {
    const r = parserClaudeJson(
      '{"type":"system","subtype":"init","session_id":"abc-123","model":"claude-x"}',
    );
    expect(r).toEqual({ kind: "session_id", payload: "abc-123" });
  });

  it("surfaces assistant text content as a message", () => {
    const r = parserClaudeJson(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello there"}]}}',
    );
    const arr = toArr(r);
    expect(arr).toHaveLength(1);
    expect(arr[0].kind).toBe("message");
    expect(arr[0].payload).toContain("hello there");
  });

  it("turns a Bash tool_use into a command event", () => {
    const r = parserClaudeJson(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"rg foo src/"}}]}}',
    );
    const arr = toArr(r);
    expect(arr).toHaveLength(1);
    expect(arr[0].kind).toBe("command");
    expect(arr[0].payload).toBe("rg foo src/");
  });

  it("turns Edit/Write tool_use into an edit event with file_path", () => {
    const r = parserClaudeJson(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/x/y.ts"}}]}}',
    );
    const arr = toArr(r);
    expect(arr[0].kind).toBe("edit");
    expect(arr[0].payload).toBe("/x/y.ts");
  });

  it("emits both text and tool_use from a mixed assistant event", () => {
    const r = parserClaudeJson(
      '{"type":"assistant","message":{"content":[' +
        '{"type":"text","text":"let me look"},' +
        '{"type":"tool_use","name":"Bash","input":{"command":"ls"}}' +
        "]}}",
    );
    const arr = toArr(r);
    expect(arr).toHaveLength(2);
    expect(arr[0].kind).toBe("message");
    expect(arr[1].kind).toBe("command");
    expect(arr[1].payload).toBe("ls");
  });

  it("drops Read/Grep tool_use (noise)", () => {
    const r = parserClaudeJson(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x.ts"}}]}}',
    );
    expect(toArr(r).filter((x) => x.kind !== null)).toHaveLength(0);
  });

  it("surfaces result is_error as an error message", () => {
    const r = parserClaudeJson(
      '{"type":"result","subtype":"error","is_error":true,"result":"hit limit"}',
    );
    const arr = toArr(r);
    expect(arr[0].kind).toBe("message");
    expect(arr[0].payload).toContain("hit limit");
  });

  it("ignores successful result events (already streamed)", () => {
    const r = parserClaudeJson(
      '{"type":"result","subtype":"success","result":"final answer","session_id":"x"}',
    );
    expect(toArr(r).filter((x) => x.kind !== null)).toHaveLength(0);
  });

  it("surfaces clap-style error: lines", () => {
    const r = parserClaudeJson("error: unknown flag --foo");
    const arr = toArr(r);
    expect(arr[0].kind).toBe("message");
  });
});

describe("createClaudeJsonParser (stateful fallback)", () => {
  it("still drops a successful result event after assistant text streamed", () => {
    const parse = createClaudeJsonParser();
    parse(
      '{"type":"assistant","message":{"content":[{"type":"text","text":"streamed answer"}]}}',
    );
    const r = parse(
      '{"type":"result","subtype":"success","result":"streamed answer","session_id":"x"}',
    );
    expect(toArr(r).filter((x) => x.kind !== null)).toHaveLength(0);
  });

  it("emits result.result as a message when no assistant text was streamed", () => {
    const parse = createClaudeJsonParser();
    parse('{"type":"system","subtype":"init","session_id":"x","model":"y"}');
    const r = parse(
      '{"type":"result","subtype":"success","result":"final-only answer","session_id":"x"}',
    );
    const arr = toArr(r);
    expect(arr).toHaveLength(1);
    expect(arr[0].kind).toBe("message");
    expect(arr[0].payload).toContain("final-only answer");
  });

  it("does not double-emit if the result event appears twice", () => {
    const parse = createClaudeJsonParser();
    const a = parse(
      '{"type":"result","subtype":"success","result":"only here","session_id":"x"}',
    );
    expect(toArr(a)[0].kind).toBe("message");
    const b = parse(
      '{"type":"result","subtype":"success","result":"only here","session_id":"x"}',
    );
    expect(toArr(b).filter((x) => x.kind !== null)).toHaveLength(0);
  });

  it("ignores assistant events that only carry tool_use (no text)", () => {
    const parse = createClaudeJsonParser();
    parse(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}',
    );
    const r = parse(
      '{"type":"result","subtype":"success","result":"answer-after-tools","session_id":"x"}',
    );
    const arr = toArr(r);
    expect(arr).toHaveLength(1);
    expect(arr[0].kind).toBe("message");
    expect(arr[0].payload).toContain("answer-after-tools");
  });

  it("still surfaces is_error result as an error message", () => {
    const parse = createClaudeJsonParser();
    const r = parse(
      '{"type":"result","subtype":"error","is_error":true,"result":"hit limit"}',
    );
    const arr = toArr(r);
    expect(arr[0].kind).toBe("message");
    expect(arr[0].payload).toContain("hit limit");
  });

  it("drops an empty result.result string instead of emitting an empty message", () => {
    const parse = createClaudeJsonParser();
    const r = parse(
      '{"type":"result","subtype":"success","result":"   ","session_id":"x"}',
    );
    expect(toArr(r).filter((x) => x.kind !== null)).toHaveLength(0);
  });
});

describe("parserAgyText", () => {
  it("treats 'I will X' as a command event", () => {
    expect(parserAgyText("I will list files\n").kind).toBe("command");
  });

  it("passes through ordinary lines as messages", () => {
    expect(parserAgyText("here is the answer\n").kind).toBe("message");
  });
});

describe("renderRawFallback", () => {
  it("extracts text from known event shapes and passes plain lines through", () => {
    const lines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}\n',
      '{"type":"result","subtype":"success","result":"final answer"}\n',
      "not json at all\n",
    ];
    const out = renderRawFallback(lines);
    expect(out).toContain("hello");
    expect(out).toContain("final answer");
    expect(out).toContain("not json at all");
    expect(out).not.toContain('"type"');
  });

  it("filters rust tracing lines (ISO timestamp + level + module path)", () => {
    const lines = [
      "2026-05-22T15:03:55.382713Z ERROR rmcp::transport::worker: worker quit with fatal: ...\n",
      "2026-05-22T15:03:58.807070Z ERROR codex_core::compact_remote: remote compaction failed turn_id=abc\n",
      "[error] Error running remote compact task: You've hit your usage limit.\n",
    ];
    const out = renderRawFallback(lines);
    expect(out).not.toContain("rmcp::transport::worker");
    expect(out).not.toContain("codex_core::compact_remote");
    expect(out).toContain("usage limit");
  });
});
