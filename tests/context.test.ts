import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildContext } from "../src/context.js";
import type { AgentSpec } from "../src/config.js";
import { transcriptPath } from "../src/transcripts.js";
import { clearActiveTaskForTest, setActiveTask } from "../src/tasks.js";

const originalCwd = process.cwd();
let project: string;

function turn(ts: string, prompt: string, response: string): string {
  return `\n## Turn ${ts}\n\n### Prompt\n${prompt}\n\n### Response\n${response}\n`;
}

function writeTranscript(agent: string, turns: string[]): void {
  const p = transcriptPath(agent);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, turns.join(""));
}

afterEach(() => {
  process.chdir(originalCwd);
  if (project) rmSync(project, { recursive: true, force: true });
  clearActiveTaskForTest();
});

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), "relevo-context-"));
  process.chdir(project);
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
    const sessionsDir = path.join(project, ".relay", "tasks", "test-task");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      path.join(sessionsDir, "sessions.json"),
      JSON.stringify({ claude: "session-123" }),
    );
    const ctx = buildContext("claude", { claude }, 3);
    expect(ctx).toBe("");
  });
});
