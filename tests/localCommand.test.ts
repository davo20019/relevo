import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runLocalCommand } from "../src/localCommand.js";

let project: string;
const originalCwd = process.cwd();

beforeEach(() => {
  project = realpathSync(mkdtempSync(path.join(os.tmpdir(), "relevo-local-")));
  process.chdir(project);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(project, { recursive: true, force: true });
});

describe("runLocalCommand", () => {
  it("runs a command in the project directory", async () => {
    writeFileSync(path.join(project, "marker.txt"), "ok\n");

    const result = await runLocalCommand("pwd && ls marker.txt");

    expect(result.cwd).toBe(project);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("marker.txt");
    expect(result.stderr).toBe("");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("captures stderr and nonzero exit codes", async () => {
    const result = await runLocalCommand("echo nope >&2; exit 7");

    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("nope");
  });

  it("cancels a running command when its AbortSignal aborts", async () => {
    const controller = new AbortController();
    const pending = runLocalCommand("sleep 30", {}, { signal: controller.signal, killGraceMs: 25 });
    setTimeout(() => controller.abort(), 50);
    const result = await pending;
    expect(result.cancelled).toBe(true);
    expect(result.exitCode === 0).toBe(false);
    expect(result.signal === "SIGTERM" || result.signal === "SIGKILL").toBe(true);
  });

  it("caps captured stdout while still reporting truncation", async () => {
    const result = await runLocalCommand("yes x | head -c 140000");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBeLessThanOrEqual(128 * 1024);
    expect(result.stdoutTruncated).toBe(true);
  });
});
