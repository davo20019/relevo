import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSessions, saveSessionId } from "../src/sessions.js";
import { clearActiveTaskForTest, setActiveTask } from "../src/tasks.js";

const originalCwd = process.cwd();
const originalStateHome = process.env.RELEVO_STATE_HOME;
let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), "relevo-sessions-"));
  process.env.RELEVO_STATE_HOME = path.join(project, "state");
  process.chdir(project);
  setActiveTask("test-task");
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalStateHome === undefined) {
    delete process.env.RELEVO_STATE_HOME;
  } else {
    process.env.RELEVO_STATE_HOME = originalStateHome;
  }
  rmSync(project, { recursive: true, force: true });
  clearActiveTaskForTest();
});

describe("session persistence", () => {
  it("preserves concurrent session saves from parallel fanout", async () => {
    await Promise.all([
      saveSessionId("claude", "claude-session"),
      saveSessionId("cursor", "cursor-session"),
      saveSessionId("codex", "codex-session"),
    ]);

    expect(loadSessions()).toEqual({
      claude: "claude-session",
      cursor: "cursor-session",
      codex: "codex-session",
    });
  });
});
