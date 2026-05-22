import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configHome, expandHome, resolveConfigPath } from "../src/paths.js";

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
