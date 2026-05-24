import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatDefaultStatus,
  loadPersistedDefault,
  parseDefaultCommand,
  resolveEffectiveDefault,
  saveGlobalDefaultAgent,
  saveProjectDefaultAgent,
} from "../src/settings.js";

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relevo-settings-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseDefaultCommand", () => {
  it("parses show, set, and clear variants", () => {
    expect(parseDefaultCommand("/default")).toEqual({ kind: "show" });
    expect(parseDefaultCommand("/default claude")).toEqual({
      kind: "set",
      scope: "global",
      agent: "claude",
    });
    expect(parseDefaultCommand("/default global codex")).toEqual({
      kind: "set",
      scope: "global",
      agent: "codex",
    });
    expect(parseDefaultCommand("/default local cursor")).toEqual({
      kind: "set",
      scope: "local",
      agent: "cursor",
    });
    expect(parseDefaultCommand("/default clear global")).toEqual({
      kind: "clear",
      scope: "global",
    });
    expect(parseDefaultCommand("/default clear local")).toEqual({
      kind: "clear",
      scope: "local",
    });
    expect(parseDefaultCommand("/default clear session")).toEqual({
      kind: "clear",
      scope: "session",
    });
  });
});

describe("persisted default", () => {
  it("prefers project override over global", () => {
    const home = tempDir();
    const project = tempDir();
    mkdirSync(path.join(project, ".relay"), { recursive: true });
    const cwd = process.cwd();
    try {
      process.chdir(project);
      saveGlobalDefaultAgent("claude", { homeDir: home });
      saveProjectDefaultAgent("codex");
      expect(loadPersistedDefault({ homeDir: home })).toEqual({
        agent: "codex",
        source: "local",
      });
    } finally {
      process.chdir(cwd);
    }
  });

  it("resolves session override ahead of persisted defaults", () => {
    const persisted = { agent: "claude", source: "global" as const };
    expect(resolveEffectiveDefault("codex", persisted, ["claude", "codex"])).toBe("codex");
    expect(resolveEffectiveDefault(null, persisted, ["claude", "codex"])).toBe("claude");
  });

  it("ignores unavailable persisted agents", () => {
    const persisted = { agent: "claude", source: "global" as const };
    expect(resolveEffectiveDefault(null, persisted, ["codex"])).toBeNull();
  });
});

describe("formatDefaultStatus", () => {
  it("lists active, global, project, and session override", () => {
    const text = formatDefaultStatus({
      effective: "codex",
      sessionOverride: null,
      globalAgent: "claude",
      localAgent: "codex",
    });
    expect(text).toContain("active: @codex");
    expect(text).toContain("global: @claude");
    expect(text).toContain("project: @codex");
  });
});

describe("saveGlobalDefaultAgent", () => {
  it("writes global settings under config home", () => {
    const home = tempDir();
    const settingsPath = path.join(home, ".config", "relevo", "settings.json");
    saveGlobalDefaultAgent("claude", { homeDir: home });
    expect(existsSync(settingsPath)).toBe(true);
    expect(loadPersistedDefault({ homeDir: home })).toEqual({
      agent: "claude",
      source: "global",
    });
  });
});

describe("legacy focus_agent migration", () => {
  it("reads pre-rename focus_agent key as default", () => {
    const home = tempDir();
    const settingsDir = path.join(home, ".config", "relevo");
    mkdirSync(settingsDir, { recursive: true });
    const settingsPath = path.join(settingsDir, "settings.json");
    writeFileSync(settingsPath, JSON.stringify({ focus_agent: "claude" }) + "\n", "utf8");
    expect(loadPersistedDefault({ homeDir: home })).toEqual({
      agent: "claude",
      source: "global",
    });
  });
});
