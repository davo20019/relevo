import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditabilityReason,
  auditableAgentNames,
  tokenMetrics,
  trajectory,
  scanClaudeHooks,
  runScanner,
  SCANNERS,
  renderTextOutput,
  renderJsonOutput,
  computeExitCode,
  parseAuditArgs,
  deleteAuditTask,
  auditHelpText,
} from "../src/audit.js";
import type { AgentSpec } from "../src/config.js";
import type { AuditResult, AgentResult, Offender } from "../src/audit.js";

const tempDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "relevo-audit-"));
  tempDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeHooks(root: string, plugin: string, version: string, body: object): string {
  const dir = path.join(root, "plugins", "cache", "org", plugin, version, "hooks");
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "hooks.json");
  writeFileSync(f, JSON.stringify(body));
  return f;
}

const specs: Record<string, AgentSpec> = {
  claude: { cmd: "claude {prompt}", parser: "claude-json", resume_template: "claude --resume {session_id} {prompt}" },
  codex: { cmd: "codex {prompt}", parser: "codex-json", resume_template: "codex resume {session_id} {prompt}" },
  cursor: { cmd: "agent {prompt}", parser: "cursor-json", resume_template: "agent --resume {session_id} {prompt}" },
  opencode: { cmd: "opencode {prompt}" },
  agy: { cmd: "agy {prompt}", parser: "agy-text" },
  disabled: { cmd: "claude {prompt}", parser: "claude-json", resume_template: "claude --resume {session_id}", enabled: false },
  uninstalled: { cmd: "ghost {prompt}", parser: "claude-json", resume_template: "ghost --resume {session_id}" },
};

const fakeWhich = (name: string) => (name === "ghost" ? null : `/usr/bin/${name}`);

describe("tokenMetrics", () => {
  it("fresh = input + cacheCreate, cached = cacheRead", () => {
    expect(tokenMetrics({ input: 100, output: 50, cacheRead: 900, cacheCreate: 0 }))
      .toEqual({ fresh: 100, cached: 900, pct: 0.9 });
  });

  it("counts cacheCreate as fresh (model still processes it cold)", () => {
    expect(tokenMetrics({ input: 0, output: 0, cacheRead: 0, cacheCreate: 500 }))
      .toEqual({ fresh: 500, cached: 0, pct: 0 });
  });

  it("pct is null when both fresh and cached are zero", () => {
    expect(tokenMetrics({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }))
      .toEqual({ fresh: 0, cached: 0, pct: null });
  });
});

describe("auditabilityReason", () => {
  it("returns null for an auditable agent", () => {
    expect(auditabilityReason("claude", specs.claude!, fakeWhich)).toBeNull();
  });
  it("flags disabled", () => {
    expect(auditabilityReason("disabled", specs.disabled!, fakeWhich)).toBe("disabled");
  });
  it("flags not-installed", () => {
    expect(auditabilityReason("uninstalled", specs.uninstalled!, fakeWhich)).toMatch(/not installed/);
  });
  it("flags no structured parser", () => {
    expect(auditabilityReason("opencode", specs.opencode!, fakeWhich)).toMatch(/no structured parser/);
    expect(auditabilityReason("agy", specs.agy!, fakeWhich)).toMatch(/no structured parser/);
  });
  it("flags no resume_template", () => {
    const noResume: AgentSpec = { cmd: "x {prompt}", parser: "claude-json" };
    expect(auditabilityReason("x", noResume, fakeWhich)).toMatch(/no resume_template/);
  });
});

describe("auditableAgentNames", () => {
  it("returns only the three structured CLIs in the default-ish set", () => {
    expect(auditableAgentNames(specs, fakeWhich).sort()).toEqual(["claude", "codex", "cursor"]);
  });
});

describe("trajectory", () => {
  it("first token is always · (no prior turn)", () => {
    expect(trajectory([{ fresh: 1, cached: 1, pct: 0.5, error: null }])).toBe("·");
  });
  it("growing cache% emits ↑", () => {
    const t = [
      { fresh: 1, cached: 1, pct: 0.2, error: null },
      { fresh: 1, cached: 1, pct: 0.5, error: null },
      { fresh: 1, cached: 1, pct: 0.9, error: null },
    ];
    expect(trajectory(t)).toBe("·↑↑");
  });
  it("flat cache% (within ±2pp) emits →", () => {
    const t = [
      { fresh: 1, cached: 1, pct: 0.50, error: null },
      { fresh: 1, cached: 1, pct: 0.51, error: null },
      { fresh: 1, cached: 1, pct: 0.49, error: null },
    ];
    expect(trajectory(t)).toBe("·→→");
  });
  it("declining cache% emits ↓", () => {
    const t = [
      { fresh: 1, cached: 1, pct: 0.9, error: null },
      { fresh: 1, cached: 1, pct: 0.5, error: null },
    ];
    expect(trajectory(t)).toBe("·↓");
  });
  it("treats a cached=0 turn as 0% for trajectory (going to 99% reads as ↑)", () => {
    const t = [
      { fresh: 1, cached: 0, pct: null, error: null },
      { fresh: 1, cached: 99, pct: 0.99, error: null },
    ];
    expect(trajectory(t)).toBe("·↑");
  });
  it("errored turn on either side emits · (no comparable data)", () => {
    const t = [
      { fresh: 1, cached: 1, pct: 0.5, error: null },
      { fresh: null, cached: null, pct: null, error: "exit 1" },
      { fresh: 1, cached: 1, pct: 0.5, error: null },
    ];
    expect(trajectory(t)).toBe("···");
  });
});

describe("scanClaudeHooks", () => {
  it("returns [] when the plugin cache root does not exist", () => {
    const home = tmp();
    expect(scanClaudeHooks(home)).toEqual([]);
  });

  it("detects SessionStart matcher containing 'resume' as a |-token, capturing the verbatim matcher", () => {
    const home = tmp();
    writeHooks(home, "vercel", "0.43.0", {
      hooks: { SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [] }] },
    });
    const found = scanClaudeHooks(home);
    expect(found).toHaveLength(1);
    expect(found[0]!.name).toBe("vercel@0.43.0");
    expect(found[0]!.matcher).toBe("startup|resume|clear|compact");
  });

  it("does NOT flag matchers where 'resume' is only a substring", () => {
    const home = tmp();
    writeHooks(home, "x", "1.0.0", {
      hooks: { SessionStart: [{ matcher: "startup|resumeOnly|other", hooks: [] }] },
    });
    expect(scanClaudeHooks(home)).toEqual([]);
  });

  it("is case-insensitive on token compare", () => {
    const home = tmp();
    writeHooks(home, "y", "2.0.0", {
      hooks: { SessionStart: [{ matcher: "Resume", hooks: [] }] },
    });
    expect(scanClaudeHooks(home)).toHaveLength(1);
  });

  it("skips malformed JSON without crashing", () => {
    const home = tmp();
    const dir = path.join(home, "plugins", "cache", "org", "bad", "1.0.0", "hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "hooks.json"), "{not json");
    expect(scanClaudeHooks(home)).toEqual([]);
  });
});

describe("scanner registry", () => {
  it("returns no-scanner for unregistered agents", () => {
    expect(runScanner("codex")).toBe("no-scanner");
    expect(runScanner("cursor")).toBe("no-scanner");
    expect(runScanner("opencode")).toBe("no-scanner");
  });
  it("has claude registered", () => {
    expect(typeof SCANNERS.claude).toBe("function");
  });
});

const SAMPLE: AuditResult = {
  prompt: "Reply with exactly the word OK. No other text.",
  turns: 4,
  agents: {
    claude: {
      turns: [
        { fresh: 14212, cached: 0, pct: null, error: null },
        { fresh: 142, cached: 13981, pct: 0.99, error: null },
        { fresh: 142, cached: 14053, pct: 0.99, error: null },
        { fresh: 142, cached: 14089, pct: 0.99, error: null },
      ],
    },
    codex: {
      turns: [
        { fresh: 8140, cached: 0, pct: null, error: null },
        { fresh: 8140, cached: 4096, pct: 0.33, error: null },
        { fresh: 8140, cached: 4096, pct: 0.33, error: null },
        { fresh: 8140, cached: 4096, pct: 0.33, error: null },
      ],
    },
  },
  skipped: { opencode: "no structured parser" },
  hookScan: { claude: [], codex: "no-scanner" },
};

describe("renderTextOutput", () => {
  it("includes both agent tables", () => {
    const out = renderTextOutput(SAMPLE, { explain: true });
    expect(out).toContain("claude");
    expect(out).toContain("codex");
  });
  it("emits a steady-state summary line per agent", () => {
    const out = renderTextOutput(SAMPLE, { explain: true });
    expect(out).toContain("steady state @ turn 4: 99% cache, 142 fresh tokens");
    expect(out).toContain("steady state @ turn 4: 33% cache, 8,140 fresh tokens");
  });
  it("emits a trajectory line per agent", () => {
    const out = renderTextOutput(SAMPLE, { explain: true });
    // claude: pct null → 0.99 → 0.99 → 0.99 = ·↑→→
    expect(out).toContain("trajectory: ·↑→→");
  });
  it("does not include any 'verdict' or 'Notes' framing", () => {
    const out = renderTextOutput(SAMPLE, { explain: true });
    expect(out).not.toContain("verdict:");
    expect(out).not.toContain("Notes:");
    expect(out).not.toContain("provider-typical");
  });
  it("renders em-dash for turn-1 pct (no cache to read)", () => {
    expect(renderTextOutput(SAMPLE, { explain: true })).toMatch(/^\s*1\s+14,212\s+0\s+—/m);
  });
  it("renders em-dash for turn 1 even when pct is 0 (no cache available yet)", () => {
    const r: AuditResult = {
      ...SAMPLE,
      agents: {
        claude: {
          turns: [
            { fresh: 14212, cached: 0, pct: 0, error: null },
            { fresh: 142, cached: 13981, pct: 0.99, error: null },
          ],
        },
      },
      hookScan: { claude: [] },
    };
    expect(renderTextOutput(r, { explain: true })).toMatch(/^\s*1\s+14,212\s+0\s+—/m);
  });
  it("renders real pct on turn 1 when there's cross-session cache (cached > 0)", () => {
    const r: AuditResult = {
      ...SAMPLE,
      agents: {
        claude: {
          turns: [
            { fresh: 17435, cached: 17056, pct: 0.4945, error: null },
            { fresh: 142, cached: 34000, pct: 0.996, error: null },
          ],
        },
      },
      hookScan: { claude: [] },
    };
    const out = renderTextOutput(r, { explain: true });
    expect(out).toMatch(/^\s*1\s+17,435\s+17,056\s+49%/m);
  });
  it("renders '(none found)' for an empty claude offender list", () => {
    expect(renderTextOutput(SAMPLE, { explain: true })).toContain("claude:  (none found)");
  });
  it("renders 'scanner not yet implemented' for no-scanner sentinel", () => {
    expect(renderTextOutput(SAMPLE, { explain: true })).toMatch(/codex:\s+scanner not yet implemented/);
  });
  it("uses neutral framing — no causal claims like 'offender', 'effect', or 'patch'", () => {
    const out = renderTextOutput(SAMPLE, { explain: true });
    expect(out).toContain("SessionStart hooks that fire on --resume:");
    expect(out).not.toMatch(/^Likely cache offenders/m);
    expect(out).not.toMatch(/effect:/);
    expect(out).not.toMatch(/patch:/);
  });
  it("includes the verify-by-A/B disclaimer", () => {
    const out = renderTextOutput(SAMPLE, { explain: true });
    expect(out).toContain("invalidate the cache prefix only if");
    expect(out).toContain("rerun audit");
  });
  it("includes skipped agents in a leading skipped: line", () => {
    expect(renderTextOutput(SAMPLE, { explain: true })).toMatch(/skipped:\s+opencode \(no structured parser\)/);
  });
  it("omits the entire offender section when explain is false", () => {
    const out = renderTextOutput(SAMPLE, { explain: false });
    expect(out).not.toContain("SessionStart hooks that fire");
    expect(out).not.toContain("scanner not yet implemented");
    expect(out).not.toContain("(none found)");
  });
  it("renders 'N/M turns errored' when any turn errored, replacing the summary lines", () => {
    const errored: AuditResult = {
      ...SAMPLE,
      agents: {
        claude: {
          turns: [
            { fresh: 100, cached: 900, pct: 0.9, error: null },
            { fresh: null, cached: null, pct: null, error: "exit 1" },
            { fresh: 100, cached: 900, pct: 0.9, error: null },
            { fresh: null, cached: null, pct: null, error: "exit 1" },
          ],
        },
      },
      hookScan: { claude: [] },
    };
    const out = renderTextOutput(errored, { explain: true });
    expect(out).toContain("2/4 turns errored");
    expect(out).not.toContain("steady state");
    expect(out).not.toContain("trajectory:");
  });
});

describe("renderJsonOutput", () => {
  it("includes the skipped object", () => {
    const parsed = JSON.parse(renderJsonOutput(SAMPLE));
    expect(parsed.skipped).toEqual({ opencode: "no structured parser" });
  });
  it("hookScan keys match agents keys", () => {
    const parsed = JSON.parse(renderJsonOutput(SAMPLE));
    expect(Object.keys(parsed.hookScan).sort()).toEqual(Object.keys(parsed.agents).sort());
  });
  it("ends with exactly one trailing newline", () => {
    const out = renderJsonOutput(SAMPLE);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
  it("represents errored turns with nulls and error string", () => {
    const errored: AuditResult = {
      ...SAMPLE,
      agents: {
        claude: {
          turns: [{ fresh: null, cached: null, pct: null, error: "exit 1" }],
        },
      },
    };
    const parsed = JSON.parse(renderJsonOutput(errored));
    expect(parsed.agents.claude.turns[0]).toEqual({
      fresh: null, cached: null, pct: null, error: "exit 1",
    });
  });
  it("does not include verdict / verdictPct / providerNote fields", () => {
    const parsed = JSON.parse(renderJsonOutput(SAMPLE));
    expect(parsed.agents.claude.verdict).toBeUndefined();
    expect(parsed.agents.claude.verdictPct).toBeUndefined();
    expect(parsed.agents.claude.providerNote).toBeUndefined();
  });
});

const baseAgent: AgentResult = {
  turns: [{ fresh: 100, cached: 900, pct: 0.9, error: null }],
};

describe("computeExitCode", () => {
  it("returns 0 for all-ok audit", () => {
    const r: AuditResult = { prompt: "", turns: 1, agents: { a: baseAgent }, skipped: {}, hookScan: {} };
    expect(computeExitCode(r)).toBe(0);
  });
  it("returns 2 when no agents were audited", () => {
    const r: AuditResult = { prompt: "", turns: 1, agents: {}, skipped: { x: "y" }, hookScan: {} };
    expect(computeExitCode(r)).toBe(2);
  });
  it("returns 0 even for very low cache% (no judgment)", () => {
    const r: AuditResult = {
      prompt: "", turns: 1,
      agents: { codex: { turns: [{ fresh: 1000, cached: 10, pct: 0.01, error: null }] } },
      skipped: {}, hookScan: {},
    };
    expect(computeExitCode(r)).toBe(0);
  });
  it("returns 1 on any errored turn", () => {
    const r: AuditResult = {
      prompt: "", turns: 1,
      agents: {
        a: { ...baseAgent, turns: [{ fresh: null, cached: null, pct: null, error: "exit 1" }] },
      },
      skipped: {}, hookScan: {},
    };
    expect(computeExitCode(r)).toBe(1);
  });
});

describe("parseAuditArgs", () => {
  it("returns defaults for empty argv", () => {
    const r = parseAuditArgs([]);
    if (!r.ok) throw new Error(r.error);
    expect(r.opts).toEqual({
      agent: null,
      turns: 4,
      prompt: "Reply with exactly the word OK. No other text.",
      explain: true,
      keep: false,
      json: false,
      helpRequested: false,
    });
  });
  it("--help / -h sets helpRequested", () => {
    const r1 = parseAuditArgs(["--help"]);
    if (!r1.ok) throw new Error(r1.error);
    expect(r1.opts.helpRequested).toBe(true);
    const r2 = parseAuditArgs(["-h"]);
    if (!r2.ok) throw new Error(r2.error);
    expect(r2.opts.helpRequested).toBe(true);
  });
  it("parses --agent --turns --prompt --no-explain --keep --json", () => {
    const r = parseAuditArgs(["--agent", "claude", "--turns", "6", "--prompt", "ping", "--no-explain", "--keep", "--json"]);
    if (!r.ok) throw new Error(r.error);
    expect(r.opts.agent).toBe("claude");
    expect(r.opts.turns).toBe(6);
    expect(r.opts.prompt).toBe("ping");
    expect(r.opts.explain).toBe(false);
    expect(r.opts.keep).toBe(true);
    expect(r.opts.json).toBe(true);
  });
  it("rejects --turns 1", () => {
    const r = parseAuditArgs(["--turns", "1"]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toMatch(/--turns must be an integer ≥ 2/);
  });
  it("rejects non-integer --turns", () => {
    const r1 = parseAuditArgs(["--turns", "abc"]);
    expect(r1.ok).toBe(false);
    const r2 = parseAuditArgs(["--turns", "2.5"]);
    expect(r2.ok).toBe(false);
  });
  it("rejects unknown flag", () => {
    const r = parseAuditArgs(["--foo"]);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("expected error");
    expect(r.error).toMatch(/unknown flag '--foo'/);
  });
  it("rejects --agent without a value", () => {
    const r = parseAuditArgs(["--agent"]);
    expect(r.ok).toBe(false);
  });
});

describe("deleteAuditTask", () => {
  it("removes a directory inside the tasks root", () => {
    const tasksRoot = tmp();
    const target = path.join(tasksRoot, "audit-1");
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "x.txt"), "hi");
    deleteAuditTask(target, tasksRoot);
    expect(existsSync(target)).toBe(false);
  });
  it("refuses to delete a path outside the tasks root", () => {
    const tasksRoot = tmp();
    const outside = tmp();
    expect(() => deleteAuditTask(outside, tasksRoot)).toThrow(/refusing to delete/);
    expect(existsSync(outside)).toBe(true);
  });
  it("is a no-op for a path that doesn't exist", () => {
    const tasksRoot = tmp();
    expect(() => deleteAuditTask(path.join(tasksRoot, "ghost"), tasksRoot)).not.toThrow();
  });
});

describe("auditHelpText", () => {
  it("documents all flags", () => {
    const h = auditHelpText();
    for (const flag of ["--agent", "--turns", "--prompt", "--explain", "--no-explain", "--keep", "--json", "--help"]) {
      expect(h).toContain(flag);
    }
  });
  it("notes the default turn count and prompt", () => {
    const h = auditHelpText();
    expect(h).toMatch(/default: 4/);
    expect(h).toMatch(/Reply with exactly the word OK/);
  });
});
