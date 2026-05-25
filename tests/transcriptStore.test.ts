import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTurn,
  formatTurnsAsLegacyMarkdown,
  readDependencyTurn,
  readIndex,
  readTurn,
  readTurnByRunId,
  transcriptIndexPath,
  transcriptTurnPath,
  type TurnFile,
} from "../src/transcriptStore.js";
import { clearActiveTaskForTest, setActiveTask } from "../src/tasks.js";

const originalCwd = process.cwd();
const originalRelevoState = process.env.RELEVO_STATE_HOME;
let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), "relevo-store-"));
  process.chdir(project);
  process.env.RELEVO_STATE_HOME = path.join(project, "state");
  setActiveTask("test-task");
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalRelevoState === undefined) delete process.env.RELEVO_STATE_HOME;
  else process.env.RELEVO_STATE_HOME = originalRelevoState;
  process.chdir(originalCwd);
  rmSync(project, { recursive: true, force: true });
  clearActiveTaskForTest();
});

function sampleTurn(overrides: Partial<TurnFile> = {}): TurnFile {
  return {
    v: 1,
    turn_id: "20260524T120311Z-a4f82c1d",
    run_id: "run-1",
    ts: "2026-05-24T12:03:11Z",
    status: "completed",
    prompt: "Fix auth",
    response: "Done",
    prompt_preview: "Fix auth",
    response_preview: "Done",
    files_edited: ["src/auth.ts"],
    tools_used: ["Edit"],
    attached_images: [],
    tokens: { in: 10, out: 5 },
    depends_on: null,
    path: "codex/20260524T120311Z-a4f82c1d.json",
    events: [],
    agent_spec: { cmd: "codex" },
    ...overrides,
  };
}

describe("transcriptStore", () => {
  it("writes full turn before appending one index entry", async () => {
    await appendTurn("codex", sampleTurn());
    const entries = await readIndex("codex");

    expect(entries).toHaveLength(1);
    expect(entries[0]?.run_id).toBe("run-1");
    expect(entries[0]?.path).toBe("codex/20260524T120311Z-a4f82c1d.json");
    expect(existsSync(transcriptTurnPath("codex", "20260524T120311Z-a4f82c1d"))).toBe(true);
    expect(JSON.parse(readFileSync(transcriptIndexPath("codex"), "utf8").trim())).toMatchObject({
      v: 1,
      turn_id: "20260524T120311Z-a4f82c1d",
      run_id: "run-1",
    });
  });

  it("reads the full turn and resolves by run id", async () => {
    await appendTurn("codex", sampleTurn());

    await expect(readTurn("codex", "20260524T120311Z-a4f82c1d")).resolves.toMatchObject({
      prompt: "Fix auth",
      response: "Done",
    });
    await expect(readTurnByRunId("codex", "run-1")).resolves.toMatchObject({
      turn_id: "20260524T120311Z-a4f82c1d",
    });
  });

  it("formats JSON turns as legacy Markdown", async () => {
    await appendTurn("codex", sampleTurn());

    const text = await formatTurnsAsLegacyMarkdown("codex", await readIndex("codex"));

    expect(text).toBe(
      "## Turn 2026-05-24T12:03:11Z\n\n### Prompt\nFix auth\n\n### Response\nDone\n",
    );
  });

  it("sets response_preview to null for interrupted and cancelled turns", async () => {
    await appendTurn(
      "codex",
      sampleTurn({
        turn_id: "20260524T120312Z-b4c98dd1",
        run_id: "run-2",
        status: "interrupted",
        response_preview: null,
        path: "codex/20260524T120312Z-b4c98dd1.json",
      }),
    );

    expect((await readIndex("codex"))[0]?.response_preview).toBeNull();
  });

  it("rejects unsupported future index versions", async () => {
    mkdirSync(path.dirname(transcriptIndexPath("codex")), { recursive: true });
    const line = JSON.stringify({
      v: 2,
      turn_id: "future",
      run_id: "run-future",
      path: "codex/future.json",
    });
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(transcriptIndexPath("codex"), line + "\n"),
    );

    await expect(readIndex("codex")).rejects.toThrow(/unsupported transcript index version/i);
  });

  it("rejects when index append fails and leaves no successful index entry", async () => {
    mkdirSync(transcriptIndexPath("codex"), { recursive: true });

    await expect(appendTurn("codex", sampleTurn())).rejects.toThrow();
    expect(statSync(transcriptIndexPath("codex")).isDirectory()).toBe(true);
  });

  it("preserves depends_on.turn_id end-to-end through the index", async () => {
    await appendTurn(
      "claude",
      sampleTurn({
        turn_id: "20260524T120311Z-aaaaaaaa",
        run_id: "run-up",
        path: "claude/20260524T120311Z-aaaaaaaa.json",
      }),
    );
    await appendTurn(
      "codex",
      sampleTurn({
        turn_id: "20260524T120411Z-bbbbbbbb",
        run_id: "run-down",
        path: "codex/20260524T120411Z-bbbbbbbb.json",
        depends_on: {
          agent: "claude",
          run_id: "run-up",
          turn_id: "20260524T120311Z-aaaaaaaa",
        },
      }),
    );

    const [entry] = await readIndex("codex");
    expect(entry?.depends_on).toEqual({
      agent: "claude",
      run_id: "run-up",
      turn_id: "20260524T120311Z-aaaaaaaa",
    });
  });

  it("readDependencyTurn prefers turn_id but rejects run_id mismatch", async () => {
    await appendTurn(
      "codex",
      sampleTurn({
        turn_id: "20260524T120311Z-aaaaaaaa",
        run_id: "run-A",
        path: "codex/20260524T120311Z-aaaaaaaa.json",
      }),
    );
    await appendTurn(
      "codex",
      sampleTurn({
        turn_id: "20260524T120411Z-bbbbbbbb",
        run_id: "run-B",
        path: "codex/20260524T120411Z-bbbbbbbb.json",
      }),
    );

    const ok = await readDependencyTurn({
      agent: "codex",
      run_id: "run-A",
      turn_id: "20260524T120311Z-aaaaaaaa",
    });
    expect(ok?.run_id).toBe("run-A");

    const bad = await readDependencyTurn({
      agent: "codex",
      run_id: "run-A",
      turn_id: "20260524T120411Z-bbbbbbbb",
    });
    expect(bad).toBeNull();

    const scan = await readDependencyTurn({ agent: "codex", run_id: "run-B" });
    expect(scan?.run_id).toBe("run-B");

    const missing = await readDependencyTurn({ agent: "codex", run_id: "run-X" });
    expect(missing).toBeNull();
  });

  it("rejects malformed turn ids in transcriptTurnPath", () => {
    expect(() => transcriptTurnPath("codex", "../escape")).toThrow(/invalid transcript turn id/);
    expect(() => transcriptTurnPath("codex", "20260524T120311Z-XYZ12345")).toThrow(
      /invalid transcript turn id/,
    );
    expect(() => transcriptTurnPath("codex", "20260524T120311Z-a4f82c1d")).not.toThrow();
  });
});
