import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = process.env.RELEVO_CONFIG;
let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "relevo-config-"));
  process.env.RELEVO_CONFIG = path.join(tmp, "agents.json");
  mkdirSync(path.dirname(process.env.RELEVO_CONFIG), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.RELEVO_CONFIG;
  else process.env.RELEVO_CONFIG = originalEnv;
  rmSync(tmp, { recursive: true, force: true });
});

describe("isValidAgentKey", () => {
  it("accepts standard agent names", async () => {
    const { isValidAgentKey } = await import("../src/config.js");
    expect(isValidAgentKey("claude")).toBe(true);
    expect(isValidAgentKey("Codex_2")).toBe(true);
    expect(isValidAgentKey("my-agent")).toBe(true);
  });

  it("rejects path separators, dot segments, and shell metachars", async () => {
    const { isValidAgentKey } = await import("../src/config.js");
    expect(isValidAgentKey("../escape")).toBe(false);
    expect(isValidAgentKey("a/b")).toBe(false);
    expect(isValidAgentKey("a\\b")).toBe(false);
    expect(isValidAgentKey(".hidden")).toBe(false);
    expect(isValidAgentKey("a;b")).toBe(false);
    expect(isValidAgentKey("a$(b)")).toBe(false);
    expect(isValidAgentKey("")).toBe(false);
  });
});

describe("loadConfig", () => {
  it("falls back to DEFAULT_CONFIG when agents.json is malformed", async () => {
    writeFileSync(process.env.RELEVO_CONFIG!, "{ not json");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const notices: string[] = [];
    const { loadConfig, DEFAULT_CONFIG } = await import("../src/config.js");
    const cfg = loadConfig((m) => notices.push(m));
    expect(cfg).toBe(DEFAULT_CONFIG);
    expect(notices.some((m) => m.includes("not valid JSON"))).toBe(true);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it("drops agent keys that contain path separators", async () => {
    writeFileSync(
      process.env.RELEVO_CONFIG!,
      JSON.stringify({
        agents: {
          claude: { cmd: "claude -p {prompt}" },
          "../evil": { cmd: "evil {prompt}" },
        },
        context_turns: 3,
      }),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig();
    expect(Object.keys(cfg.agents)).toEqual(["claude"]);
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });
});
