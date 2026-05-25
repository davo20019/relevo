import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordDispatch } from "../src/dispatchStats.js";
import { dispatchStatsFile } from "../src/paths.js";

const originalCwd = process.cwd();
const originalStateHome = process.env.RELEVO_STATE_HOME;
let project: string;

beforeEach(() => {
  project = mkdtempSync(path.join(os.tmpdir(), "relevo-stats-"));
  process.env.RELEVO_STATE_HOME = path.join(project, "state");
  process.chdir(project);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (originalStateHome === undefined) {
    delete process.env.RELEVO_STATE_HOME;
  } else {
    process.env.RELEVO_STATE_HOME = originalStateHome;
  }
  rmSync(project, { recursive: true, force: true });
});

describe("recordDispatch", () => {
  it("counts dispatches by agent and parser family", () => {
    recordDispatch("codex", "codex-json");
    recordDispatch("codex", "codex-json");
    recordDispatch("pi", undefined);

    const data = JSON.parse(readFileSync(dispatchStatsFile(), "utf8"));
    expect(data.v).toBe(1);
    expect(data.agents.codex.total).toBe(2);
    expect(data.parsers["codex-json"].total).toBe(2);
    expect(data.agents.pi.total).toBe(1);
    expect(data.parsers.raw.total).toBe(1);
  });

  it("refuses to mutate future schema versions", () => {
    recordDispatch("codex", "codex-json");
    writeFileSync(dispatchStatsFile(), JSON.stringify({ v: 2, agents: {}, parsers: {} }));

    recordDispatch("codex", "codex-json");

    const data = JSON.parse(readFileSync(dispatchStatsFile(), "utf8"));
    expect(data).toEqual({ v: 2, agents: {}, parsers: {} });
  });
});
