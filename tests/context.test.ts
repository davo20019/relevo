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

  it("includes only the last peer turn by default", () => {
    writeTranscript("claude", [
      turn("2026-01-01T00:00:00", "old prompt", "old response"),
      turn("2026-01-02T00:00:00", "latest prompt", "latest response"),
    ]);
    const ctx = buildContext("codex", { claude, codex: { cmd: "codex" } }, 3);
    expect(ctx).toContain("latest prompt");
    expect(ctx).toContain("latest response");
    expect(ctx).not.toContain("old prompt");
    expect(ctx).not.toContain("old response");
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
