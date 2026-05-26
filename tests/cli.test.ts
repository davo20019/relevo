import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const BIN = path.join(ROOT, "dist", "cli.js");

function runCli(...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    input: "",
    encoding: "utf8",
    timeout: 10_000,
  });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("CLI contract", () => {
  it("--help prints help and exits 0 without starting the REPL", () => {
    const r = runCli("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("relevo");
    expect(r.stdout).toContain("@<agent> <prompt>");
    expect(r.stdout).toContain("!<command>");
    expect(r.stdout + r.stderr).not.toContain("at Object.");
  });

  it("non-TTY exits 2 with a clear message", () => {
    const r = runCli();
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("interactive terminal");
  });
});
