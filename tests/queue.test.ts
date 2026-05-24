import { describe, expect, it } from "vitest";
import {
  classifySubmit,
  dependencySatisfied,
  formatQueuePreview,
  parseDependencyKey,
  pruneDeliveredBatches,
  queuedLines,
  recordCompletedRunKey,
  resolveAfterTarget,
  shouldDisablePromptInput,
  type QueueDependency,
} from "../src/queue.js";

describe("classifySubmit", () => {
  it("dispatches normally when not busy", () => {
    expect(classifySubmit("@claude hi", false)).toBe("dispatch");
  });

  it("dispatches a slash command when not busy", () => {
    expect(classifySubmit("/help", false)).toBe("dispatch");
  });

  it("queues a normal prompt when busy", () => {
    expect(classifySubmit("@claude follow-up", true)).toBe("queue");
  });

  it("rejects a slash command when busy", () => {
    expect(classifySubmit("/clear", true)).toBe("reject-slash");
  });

  it("treats leading whitespace before a slash command as still a slash command", () => {
    expect(classifySubmit("   /reset", true)).toBe("reject-slash");
  });

  it("queues whitespace-only as queue (App handles empty-line filter)", () => {
    // The queue layer doesn't second-guess the App-level empty check; both
    // layers gating empty submissions would let the rules drift. Empty lines
    // are filtered upstream before classify is called.
    expect(classifySubmit("   ", true)).toBe("queue");
  });
});

describe("formatQueuePreview", () => {
  it("returns short prompts unchanged", () => {
    expect(formatQueuePreview("hello", 60)).toEqual(["hello"]);
  });

  it("collapses internal whitespace into single spaces", () => {
    expect(formatQueuePreview("hello   world\n\nagain", 60)).toEqual(["hello world again"]);
  });

  it("trims leading and trailing whitespace", () => {
    expect(formatQueuePreview("  hi  ", 60)).toEqual(["hi"]);
  });

  it("wraps prompts onto a second line before truncating", () => {
    expect(formatQueuePreview("one two three four five six seven", 14)).toEqual([
      "one two three",
      "four five six…",
    ]);
  });

  it("splits long words across two lines and ellipsizes overflow", () => {
    expect(formatQueuePreview("abcdefghijklmnop", 6)).toEqual(["abcdef", "ghijk…"]);
  });
});

describe("shouldDisablePromptInput", () => {
  it("keeps the input locked during preparation before an agent is observable", () => {
    expect(shouldDisablePromptInput(true, 0)).toBe(true);
  });

  it("unlocks the input once a preparing dispatch has marked an agent in-flight", () => {
    expect(shouldDisablePromptInput(true, 1)).toBe(false);
  });

  it("keeps the input available while idle", () => {
    expect(shouldDisablePromptInput(false, 0)).toBe(false);
  });
});

describe("dependencySatisfied", () => {
  it("allows items without dependencies", () => {
    expect(dependencySatisfied(undefined, new Set())).toBe(true);
  });

  it("waits for the exact agent/run key", () => {
    const dep: QueueDependency = { agent: "codex", runId: "r1" };
    expect(dependencySatisfied(dep, new Set())).toBe(false);
    expect(dependencySatisfied(dep, new Set(["codex:r1"]))).toBe(true);
  });

  it("does not block unrelated items when one in a batch is waiting", () => {
    const completed = new Set<string>();
    const blocked: QueueDependency = { agent: "codex", runId: "r1" };
    expect(dependencySatisfied(blocked, completed)).toBe(false);
    expect(dependencySatisfied(undefined, completed)).toBe(true);
  });
});

describe("parseDependencyKey", () => {
  it("splits agent and runId on the first colon", () => {
    expect(parseDependencyKey("codex:r1")).toEqual({ agent: "codex", runId: "r1" });
  });
  it("preserves colons in the runId after the first split", () => {
    expect(parseDependencyKey("cursor:a:b:c")).toEqual({ agent: "cursor", runId: "a:b:c" });
  });
  it("returns null when no colon present", () => {
    expect(parseDependencyKey("codex")).toBeNull();
  });
});

describe("resolveAfterTarget", () => {
  const run = (id: string, agent: string, running: boolean, start: number) =>
    ({ id, agentName: agent, running, start });

  it("returns the lone in-flight run id", () => {
    const r = run("r1", "codex", true, 100);
    expect(resolveAfterTarget("codex", [r], [])).toEqual({ runId: "r1", ambiguous: false });
  });

  it("picks the most-recently-started of multiple in-flight, flagging ambiguous", () => {
    const a = run("r1", "codex", true, 100);
    const b = run("r2", "codex", true, 200);
    expect(resolveAfterTarget("codex", [a, b], [])).toEqual({ runId: "r2", ambiguous: true });
  });

  it("falls back to the most recent terminal run for the agent", () => {
    expect(resolveAfterTarget("codex", [], ["claude:c1", "codex:r1", "codex:r2"])).toEqual({
      runId: "r2",
      ambiguous: false,
    });
  });

  it("returns null when no in-flight and no terminal history", () => {
    expect(resolveAfterTarget("codex", [], ["claude:c1"])).toBeNull();
  });

  it("ignores completed runs for other agents", () => {
    expect(resolveAfterTarget("codex", [], ["claude:c1", "agy:a1"])).toBeNull();
  });
});

describe("recordCompletedRunKey", () => {
  it("dedupes repeated terminal events for the same run", () => {
    const keys = new Set<string>();
    const order: string[] = [];
    recordCompletedRunKey(keys, order, "codex:r1", 10);
    recordCompletedRunKey(keys, order, "codex:r1", 10);
    expect(keys.size).toBe(1);
    expect(order).toEqual(["codex:r1"]);
  });

  it("evicts the oldest entry past the limit", () => {
    const keys = new Set<string>();
    const order: string[] = [];
    for (let i = 0; i < 5; i++) recordCompletedRunKey(keys, order, `r${i}`, 3);
    expect(order).toEqual(["r2", "r3", "r4"]);
    expect(keys.has("r0")).toBe(false);
    expect(keys.has("r1")).toBe(false);
    expect(keys.has("r4")).toBe(true);
  });
});

describe("prompt queue batches", () => {
  it("returns every queued line in submission order so the UI can render all of them", () => {
    const queue = [
      { line: "@cursor task B", items: [{ agent: "cursor" }], delivered: new Set<string>() },
      { line: "@codex task C", items: [{ agent: "codex" }], delivered: new Set<string>() },
    ];

    expect(queuedLines(queue)).toEqual(["@cursor task B", "@codex task C"]);
  });

  it("returns an empty array when nothing is queued", () => {
    expect(queuedLines([])).toEqual([]);
  });

  it("prunes delivered batches without dropping later pending batches", () => {
    const queue = [
      {
        line: "@cursor task B",
        items: [{ agent: "cursor" }],
        delivered: new Set(["cursor"]),
      },
      { line: "@codex task C", items: [{ agent: "codex" }], delivered: new Set<string>() },
    ];

    pruneDeliveredBatches(queue);

    expect(queue).toHaveLength(1);
    expect(queuedLines(queue)).toEqual(["@codex task C"]);
  });
});
