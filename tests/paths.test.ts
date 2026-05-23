import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configHome,
  currentTask,
  expandHome,
  resolveConfigPath,
  sessionsFile,
  taskRoot,
  transcriptDir,
} from "../src/paths.js";
import { clearActiveTaskForTest, setActiveTask } from "../src/tasks.js";

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relevo-paths-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("config path resolution", () => {
  it("uses a project-local agents.json when present", () => {
    const project = tempDir();
    const localConfig = path.join(project, "agents.json");
    writeFileSync(localConfig, "{}\n");

    expect(resolveConfigPath({ cwd: project })).toBe(localConfig);
  });

  it("falls back to XDG_CONFIG_HOME/relevo/agents.json", () => {
    const project = tempDir();
    const xdg = tempDir();

    expect(resolveConfigPath({ cwd: project, env: { XDG_CONFIG_HOME: xdg } })).toBe(
      path.join(xdg, "relevo", "agents.json"),
    );
  });

  it("falls back to ~/.config/relevo/agents.json when XDG_CONFIG_HOME is not set", () => {
    const project = tempDir();
    const home = tempDir();

    expect(resolveConfigPath({ cwd: project, env: {}, homeDir: home })).toBe(
      path.join(home, ".config", "relevo", "agents.json"),
    );
    expect(configHome({ env: {}, homeDir: home })).toBe(path.join(home, ".config", "relevo"));
  });

  it("honors RELEVO_CONFIG and expands a leading home segment", () => {
    const project = tempDir();
    const home = tempDir();

    expect(
      resolveConfigPath({
        cwd: project,
        env: { RELEVO_CONFIG: "~/.relevo/custom-agents.json" },
        homeDir: home,
      }),
    ).toBe(path.join(home, ".relevo", "custom-agents.json"));
    expect(expandHome("~/agents.json", home)).toBe(path.join(home, "agents.json"));
  });

  it("does not create config directories while resolving", () => {
    const project = tempDir();
    const xdg = path.join(tempDir(), "xdg");

    resolveConfigPath({ cwd: project, env: { XDG_CONFIG_HOME: xdg } });

    expect(existsSync(path.join(xdg, "relevo"))).toBe(false);
  });
});

describe("task-scoped paths use the active task", () => {
  const originalCwd = process.cwd();
  let project: string;

  beforeEach(() => {
    const temp = mkdtempSync(path.join(os.tmpdir(), "relevo-active-"));
    process.chdir(temp);
    project = process.cwd();
    clearActiveTaskForTest();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(project, { recursive: true, force: true });
    clearActiveTaskForTest();
  });

  it("currentTask throws when nothing is active", () => {
    expect(() => currentTask()).toThrow(/no active task/);
  });

  it("currentTask returns the active task name once set", () => {
    setActiveTask("s-20260522-132901");
    expect(currentTask()).toBe("s-20260522-132901");
    expect(taskRoot()).toBe(path.join(project, ".relay", "tasks", "s-20260522-132901"));
    expect(transcriptDir()).toBe(
      path.join(project, ".relay", "tasks", "s-20260522-132901", "transcripts"),
    );
    expect(sessionsFile()).toBe(
      path.join(project, ".relay", "tasks", "s-20260522-132901", "sessions.json"),
    );
  });

  it("taskRoot accepts an explicit name without activation", () => {
    expect(taskRoot("other")).toBe(path.join(project, ".relay", "tasks", "other"));
  });
});
