import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildAgentPrompt, buildContext } from "../src/context.js";
import { clearAgentSession } from "../src/sessions.js";
import type { AgentSpec } from "../src/config.js";
import { sessionsFile, transcriptDir } from "../src/paths.js";
import { appendTurn as appendStructuredTurn, type TurnFile } from "../src/transcriptStore.js";
import { transcriptPath } from "../src/transcripts.js";
import { clearActiveTaskForTest, setActiveTask } from "../src/tasks.js";

const originalCwd = process.cwd();
const originalRelevoState = process.env.RELEVO_STATE_HOME;
let project: string;

function turn(ts: string, prompt: string, response: string): string {
  return `\n## Turn ${ts}\n\n### Prompt\n${prompt}\n\n### Response\n${response}\n`;
}

function writeTranscript(agent: string, turns: string[]): void {
  const p = transcriptPath(agent);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, turns.join(""));
}

function structuredTurn(ts: string, runId: string, prompt: string, response: string): TurnFile {
  const turnId = ts.replace(/[-:]/g, "").replace(/Z?$/, "Z") + "-abcd0001";
  return {
    v: 1,
    turn_id: turnId,
    run_id: runId,
    ts,
    status: "completed",
    prompt,
    response,
    prompt_preview: prompt.slice(0, 120),
    response_preview: response.slice(0, 200),
    files_edited: [],
    tools_used: [],
    attached_images: [],
    tokens: null,
    depends_on: null,
    path: `agent/${turnId}.json`,
    events: [],
    agent_spec: null,
  };
}

afterEach(() => {
  if (originalRelevoState === undefined) delete process.env.RELEVO_STATE_HOME;
  else process.env.RELEVO_STATE_HOME = originalRelevoState;
  process.chdir(originalCwd);
  if (project) rmSync(project, { recursive: true, force: true });
  clearActiveTaskForTest();
});

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), "relevo-context-"));
  process.chdir(project);
  process.env.RELEVO_STATE_HOME = path.join(project, "state");
  setActiveTask("test-task");
});

describe("buildContext", () => {
  const claude: AgentSpec = {
    cmd: "claude",
    resume_template: "claude --resume {session_id} {prompt}",
  };
  const pi: AgentSpec = { cmd: "pi -p {prompt}" };

  it("does not include peer turns by default", () => {
    writeTranscript("claude", [
      turn("2026-01-01T00:00:00", "old prompt", "old response"),
      turn("2026-01-02T00:00:00", "latest prompt", "latest response"),
    ]);
    const ctx = buildContext("codex", { claude, codex: { cmd: "codex" } }, 3);
    expect(ctx).toBe("");
  });

  it("includes reserved @local transcript context when requested", () => {
    writeTranscript("local", [
      turn(
        "2026-01-02T00:00:00",
        "!npm test",
        "$ npm test\ncwd: /proj\nshell: /bin/bash\n\nstderr:\nboom\n\nexit 1 after 50ms",
      ),
    ]);
    const ctx = buildAgentPrompt(
      "claude",
      { claude },
      3,
      "debug this",
      { peerAgents: ["local"] },
    );
    expect(ctx).toContain("--- Recent activity from @local ---");
    expect(ctx).toContain("!npm test");
    expect(ctx).toContain("boom");
  });

  it("includes only requested peer turns", () => {
    writeTranscript("claude", [
      turn("2026-01-01T00:00:00", "old prompt", "old response"),
      turn("2026-01-02T00:00:00", "latest prompt", "latest response"),
    ]);
    writeTranscript("cursor", [turn("2026-01-02T00:00:00", "cursor prompt", "cursor response")]);
    const ctx = buildContext(
      "codex",
      { claude, codex: { cmd: "codex" }, cursor: { cmd: "cursor" } },
      3,
      { peerAgents: ["claude"] },
    );
    expect(ctx).toContain("latest prompt");
    expect(ctx).toContain("latest response");
    expect(ctx).not.toContain("old prompt");
    expect(ctx).not.toContain("old response");
    expect(ctx).not.toContain("cursor prompt");
  });

  it("does not mark ordinary recent activity as compacted", () => {
    writeTranscript("pi", [turn("2026-01-01T00:00:00", "ordinary prompt", "ordinary response")]);
    const ctx = buildContext("pi", { pi }, 1);

    expect(ctx).toContain("ordinary prompt");
    expect(ctx).toContain("ordinary response");
    expect(ctx).not.toContain("[relevo compacted");
  });

  it("compacts oversized recent activity when requested", () => {
    const noisy = Array.from({ length: 40 }, (_, i) => `line ${i + 1}: ${"x".repeat(80)}`).join(
      "\n",
    );
    writeTranscript("pi", [turn("2026-01-01T00:00:00", "inspect output", noisy)]);
    const ctx = buildContext("pi", { pi }, 1, {
      contextCompaction: {
        enabled: true,
        maxCharsPerBlock: 900,
        maxLineLength: 120,
      },
    });

    expect(ctx).toContain("## Turn 2026-01-01T00:00:00");
    expect(ctx).toContain("### Prompt");
    expect(ctx).toContain("inspect output");
    expect(ctx).toContain("[relevo compacted");
    expect(ctx.length).toBeLessThan(noisy.length);
  });

  it("leaves recent activity unchanged when compaction is disabled", () => {
    const response = `first\n${"x".repeat(300)}\nlast`;
    writeTranscript("pi", [turn("2026-01-01T00:00:00", "short prompt", response)]);
    const ctx = buildContext("pi", { pi }, 1, {
      contextCompaction: {
        enabled: false,
        maxCharsPerBlock: 100,
        maxLineLength: 40,
      },
    });

    expect(ctx).toContain(response);
    expect(ctx).not.toContain("[relevo compacted");
  });

  it("uses context_turns for the target agent without a native session", () => {
    writeTranscript("pi", [
      turn("2026-01-01T00:00:00", "turn one", "resp one"),
      turn("2026-01-02T00:00:00", "turn two", "resp two"),
      turn("2026-01-03T00:00:00", "turn three", "resp three"),
    ]);
    const ctx = buildContext("pi", { pi }, 2);
    expect(ctx).toContain("turn two");
    expect(ctx).toContain("turn three");
    expect(ctx).not.toContain("turn one");
    expect(ctx).toContain("your own prior turns");
  });

  it("skips the target agent when it has an active native session", () => {
    writeTranscript("claude", [turn("2026-01-01T00:00:00", "self prompt", "self response")]);
    const sessionsDir = path.dirname(sessionsFile());
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      sessionsFile(),
      JSON.stringify({ claude: "session-123" }),
    );
    const ctx = buildContext("claude", { claude }, 3);
    expect(ctx).toBe("");
  });

  it("preserves buildContext output for JSONL-backed self turns", async () => {
    const specs = { pi };
    writeTranscript("pi", [
      turn("2026-01-01T00:00:00", "turn one", "resp one"),
      turn("2026-01-02T00:00:00", "turn two", "resp two"),
    ]);
    const legacy = buildContext("pi", specs, 2);
    rmSync(transcriptDir(), { recursive: true, force: true });

    await appendStructuredTurn(
      "pi",
      structuredTurn("2026-01-01T00:00:00", "run-1", "turn one", "resp one"),
    );
    await appendStructuredTurn(
      "pi",
      structuredTurn("2026-01-02T00:00:00", "run-2", "turn two", "resp two"),
    );

    expect(buildContext("pi", specs, 2)).toBe(legacy);
  });

  it("preserves requested peer context output for JSONL-backed peer turns", async () => {
    const specs = { claude, codex: { cmd: "codex" } };
    writeTranscript("claude", [turn("2026-01-02T00:00:00", "peer prompt", "peer response")]);
    const legacy = buildContext("codex", specs, 3, { peerAgents: ["claude"] });
    rmSync(transcriptDir(), { recursive: true, force: true });

    await appendStructuredTurn(
      "claude",
      structuredTurn("2026-01-02T00:00:00", "run-peer", "peer prompt", "peer response"),
    );

    expect(buildContext("codex", specs, 3, { peerAgents: ["claude"] })).toBe(legacy);
  });

  it("does not split JSONL-backed responses containing the legacy turn marker", async () => {
    await appendStructuredTurn(
      "pi",
      structuredTurn("2026-01-01T00:00:00", "run-1", "prompt", "response with ## Turn inside"),
    );

    const ctx = buildContext("pi", { pi }, 1);

    expect(ctx).toContain("response with ## Turn inside");
  });
});

describe("buildAgentPrompt", () => {
  const claude: AgentSpec = {
    cmd: "claude",
    resume_template: "claude --resume {session_id} {prompt}",
  };

  it("returns the userPrompt unchanged when there is no context or handoff", () => {
    const out = buildAgentPrompt("claude", { claude }, 3, "do A now");
    expect(out).toBe("do A now");
  });

  it("prepends a handoff block when given", () => {
    const out = buildAgentPrompt("claude", { claude }, 3, "do A now", {
      handoff: "HANDOFF\n",
    });
    expect(out).toBe("HANDOFF\ndo A now");
  });

  // Regression: the session-expired retry path in App.tsx reused the prompt
  // built before clearAgentSession, so self-context that buildContext had
  // suppressed (because the native session was active) never got injected on
  // retry — the fresh agent received only the bare user prompt and could not
  // resolve references like "yes, do A now" from prior turns.
  it("re-includes self-history after the native session is cleared", async () => {
    writeTranscript("claude", [
      turn("2026-01-01T00:00:00", "old prompt", "old response"),
    ]);
    const sessionsDir = path.dirname(sessionsFile());
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(sessionsFile(), JSON.stringify({ claude: "session-abc" }));

    const beforeClear = buildAgentPrompt("claude", { claude }, 3, "yes, do A now.");
    expect(beforeClear).toBe("yes, do A now.");

    await clearAgentSession("claude");

    const afterClear = buildAgentPrompt("claude", { claude }, 3, "yes, do A now.");
    expect(afterClear).toContain("old prompt");
    expect(afterClear).toContain("old response");
    expect(afterClear).toContain("your own prior turns");
    expect(afterClear.endsWith("yes, do A now.")).toBe(true);
  });
});
