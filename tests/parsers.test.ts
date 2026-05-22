import { describe, expect, it } from "vitest";
import {
  parserCodexJson,
  parserCursorJson,
  parserAgyText,
  renderRawFallback,
} from "../src/parsers.js";

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
});
