import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatFocusStatus,
  loadPersistedFocus,
  parseFocusCommand,
  resolveEffectiveFocus,
  saveGlobalFocusAgent,
  saveProjectFocusAgent,
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

describe("parseFocusCommand", () => {
  it("parses show, set, and clear variants", () => {
    expect(parseFocusCommand("/focus")).toEqual({ kind: "show" });
    expect(parseFocusCommand("/focus claude")).toEqual({
      kind: "set",
      scope: "global",
      agent: "claude",
    });
    expect(parseFocusCommand("/focus global codex")).toEqual({
      kind: "set",
      scope: "global",
      agent: "codex",
    });
    expect(parseFocusCommand("/focus local cursor")).toEqual({
      kind: "set",
      scope: "local",
      agent: "cursor",
    });
    expect(parseFocusCommand("/focus clear global")).toEqual({
      kind: "clear",
      scope: "global",
    });
    expect(parseFocusCommand("/focus clear local")).toEqual({
      kind: "clear",
      scope: "local",
    });
    expect(parseFocusCommand("/focus clear session")).toEqual({
      kind: "clear",
      scope: "session",
    });
  });
});

describe("persisted focus", () => {
  it("prefers project override over global", () => {
    const home = tempDir();
    const project = tempDir();
    mkdirSync(path.join(project, ".relay"), { recursive: true });
    const cwd = process.cwd();
    try {
      process.chdir(project);
      saveGlobalFocusAgent("claude", { homeDir: home });
      saveProjectFocusAgent("codex");
      expect(loadPersistedFocus({ homeDir: home })).toEqual({ agent: "codex", source: "local" });
    } finally {
      process.chdir(cwd);
    }
  });

  it("resolves session override ahead of persisted defaults", () => {
    const persisted = { agent: "claude", source: "global" as const };
    expect(resolveEffectiveFocus("codex", persisted, ["claude", "codex"])).toBe("codex");
    expect(resolveEffectiveFocus(null, persisted, ["claude", "codex"])).toBe("claude");
  });

  it("ignores unavailable persisted agents", () => {
    const persisted = { agent: "claude", source: "global" as const };
    expect(resolveEffectiveFocus(null, persisted, ["codex"])).toBeNull();
  });
});

describe("formatFocusStatus", () => {
  it("lists active, global, project, and session override", () => {
    const text = formatFocusStatus({
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

describe("saveGlobalFocusAgent", () => {
  it("writes global settings under config home", () => {
    const home = tempDir();
    const settingsPath = path.join(home, ".config", "relevo", "settings.json");
    saveGlobalFocusAgent("claude", { homeDir: home });
    expect(existsSync(settingsPath)).toBe(true);
    expect(loadPersistedFocus({ homeDir: home })).toEqual({
      agent: "claude",
      source: "global",
    });
  });
});
