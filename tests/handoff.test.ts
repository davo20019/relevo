import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHandoffBlock } from "../src/context.js";
import { appendTurn, type TurnFile } from "../src/transcriptStore.js";
import { clearActiveTaskForTest, setActiveTask } from "../src/tasks.js";

const originalCwd = process.cwd();
const originalRelevoState = process.env.RELEVO_STATE_HOME;
let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), "relevo-handoff-"));
  process.chdir(project);
  process.env.RELEVO_STATE_HOME = path.join(project, "state");
  setActiveTask("t");
});

afterEach(() => {
  if (originalRelevoState === undefined) delete process.env.RELEVO_STATE_HOME;
  else process.env.RELEVO_STATE_HOME = originalRelevoState;
  process.chdir(originalCwd);
  rmSync(project, { recursive: true, force: true });
  clearActiveTaskForTest();
});

function turn(over: Partial<TurnFile>): TurnFile {
  return {
    v: 1,
    turn_id: "x",
    run_id: "x",
    ts: "2026-05-24T12:03:11Z",
    status: "completed",
    prompt: "",
    response: "",
    prompt_preview: "",
    response_preview: null,
    files_edited: [],
    tools_used: [],
    attached_images: [],
    tokens: null,
    depends_on: null,
    path: "",
    events: [],
    agent_spec: null,
    ...over,
  };
}

describe("buildHandoffBlock", () => {
  it("renders a bounded handoff for an exact upstream run", async () => {
    await appendTurn(
      "claude",
      turn({
        turn_id: "20260524T120311Z-aaaaaaaa",
        run_id: "run-A",
        response: "Refactored token middleware; left follow-up notes at line 88.",
        response_preview: "Refactored token middleware; left follow-up notes at line 88.",
        files_edited: ["src/auth.ts"],
      }),
    );

    const block = buildHandoffBlock({
      agent: "claude",
      run_id: "run-A",
      turn_id: "20260524T120311Z-aaaaaaaa",
    });

    expect(block).toContain("@claude finished run run-A");
    expect(block).toContain("src/auth.ts");
    expect(block).toContain("Refactored token middleware");
    expect(block).toContain("[bounded handoff only");
    expect(block).toContain("20260524T120311Z-aaaaaaaa.json");
  });

  it("returns null when the upstream turn cannot be resolved", () => {
    expect(buildHandoffBlock({ agent: "claude", run_id: "missing" })).toBeNull();
  });

  it("binds to the exact upstream run, not the latest turn from the same agent", async () => {
    await appendTurn(
      "claude",
      turn({
        turn_id: "20260524T120311Z-aaaaaaaa",
        run_id: "run-A",
        response: "FIRST response",
        response_preview: "FIRST response",
      }),
    );
    await appendTurn(
      "claude",
      turn({
        turn_id: "20260524T120412Z-bbbbbbbb",
        run_id: "run-B",
        response: "SECOND response",
        response_preview: "SECOND response",
      }),
    );

    const block = buildHandoffBlock({
      agent: "claude",
      run_id: "run-A",
      turn_id: "20260524T120311Z-aaaaaaaa",
    });

    expect(block).toContain("FIRST response");
    expect(block).not.toContain("SECOND response");
  });

  it("scans by run_id when turn_id is absent", async () => {
    await appendTurn(
      "claude",
      turn({
        turn_id: "20260524T120311Z-aaaaaaaa",
        run_id: "run-A",
        response: "first",
        response_preview: "first",
      }),
    );
    await appendTurn(
      "claude",
      turn({
        turn_id: "20260524T120412Z-bbbbbbbb",
        run_id: "run-B",
        response: "second",
        response_preview: "second",
      }),
    );

    const block = buildHandoffBlock({ agent: "claude", run_id: "run-A" });
    expect(block).toContain("first");
    expect(block).not.toContain("second");
  });
});
