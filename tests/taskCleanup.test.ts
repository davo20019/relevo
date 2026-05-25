import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearTaskContext } from "../src/taskCleanup.js";
import { sessionsFile, transcriptDir } from "../src/paths.js";
import { clearActiveTaskForTest, setActiveTask } from "../src/tasks.js";

const originalCwd = process.cwd();
const originalStateHome = process.env.RELEVO_STATE_HOME;
let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), "relevo-clear-"));
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

describe("clearTaskContext", () => {
  it("deletes every transcript and saved session for the active task", () => {
    const transcripts = transcriptDir();
    mkdirSync(transcripts, { recursive: true });
    writeFileSync(path.join(transcripts, "claude.md"), "claude transcript");
    writeFileSync(path.join(transcripts, "codex.md"), "codex transcript");
    writeFileSync(path.join(transcripts, "claude.index.jsonl"), "{}\n");
    mkdirSync(path.join(transcripts, "claude"), { recursive: true });
    writeFileSync(path.join(transcripts, "claude", "01HTURN.json"), "{}\n");
    writeFileSync(path.join(transcripts, "notes.txt"), "not a transcript");
    writeFileSync(sessionsFile(), JSON.stringify({ claude: "session-1", codex: "session-2" }));

    const result = clearTaskContext();

    expect(result).toEqual({ transcriptsCleared: 4, sessionsCleared: true });
    expect(existsSync(path.join(transcripts, "claude.md"))).toBe(false);
    expect(existsSync(path.join(transcripts, "codex.md"))).toBe(false);
    expect(existsSync(path.join(transcripts, "claude.index.jsonl"))).toBe(false);
    expect(existsSync(path.join(transcripts, "claude"))).toBe(false);
    expect(existsSync(path.join(transcripts, "notes.txt"))).toBe(true);
    expect(existsSync(sessionsFile())).toBe(false);
  });
});
