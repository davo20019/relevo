// All audit logic in one module. Sections below are ordered:
// types → pure helpers → scanner → renderers → runner → entry.

import { existsSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TokenUsage } from "./parsers.js";
import type { AgentSpec } from "./config.js";
import { agentCommandName, agentIsEnabled, loadConfig } from "./config.js";
import which from "./which.js";
import { newRun, prepareCommand, spawnProc, streamToRun } from "./run.js";
import { ensureDirsSync, ensureTask, stateDir } from "./paths.js";
import { setActiveTask } from "./tasks.js";

export type TurnResult = {
  fresh: number | null;   // null when the turn errored
  cached: number | null;
  pct: number | null;     // cached / (fresh + cached); null when denominator 0 or errored
  error: string | null;   // "exit 1", "timeout", etc. null on success
};

export type AgentResult = {
  turns: TurnResult[];
};

// A factual observation of a plugin whose SessionStart hook fires on `resume`.
// Not a claim of causation — whether it actually invalidates the cache depends
// on whether the hook's output is deterministic call-to-call. Verify with an
// A/B (toggle the hook, rerun audit, compare).
//
// TODO: a stronger scanner could invoke each hook twice and diff stdout to
// classify deterministic vs non-deterministic hooks. That converts pattern-
// matched suspicion into measured fact. Deferred for safety (hooks may not be
// safe to invoke standalone) and complexity.
export type Offender = {
  name: string;
  file: string;
  matcher: string;
};

export type ScannerOutput = Offender[] | "no-scanner";
export type CliScanner = () => ScannerOutput;

export type AuditResult = {
  prompt: string;
  turns: number;
  agents: Record<string, AgentResult>;
  skipped: Record<string, string>;
  hookScan: Record<string, ScannerOutput>;
};

export function tokenMetrics(t: TokenUsage): { fresh: number; cached: number; pct: number | null } {
  const fresh = t.input + t.cacheCreate;
  const cached = t.cacheRead;
  const denom = fresh + cached;
  return { fresh, cached, pct: denom > 0 ? cached / denom : null };
}

const STRUCTURED_PARSERS = new Set(["claude-json", "codex-json", "cursor-json"]);

export function auditabilityReason(
  _name: string,
  spec: AgentSpec,
  whichFn: (n: string) => string | null = which,
): string | null {
  if (!agentIsEnabled(spec)) return "disabled";
  const cmd = agentCommandName(spec);
  if (!cmd) return "no command";
  if (!whichFn(cmd)) return `not installed (binary '${cmd}' not on PATH)`;
  if (!spec.parser || !STRUCTURED_PARSERS.has(spec.parser)) {
    return `no structured parser (got '${spec.parser ?? "raw"}'; need one of ${[...STRUCTURED_PARSERS].join(", ")})`;
  }
  if (!spec.resume_template) return "no resume_template";
  return null;
}

export function auditableAgentNames(
  specs: Record<string, AgentSpec>,
  whichFn: (n: string) => string | null = which,
): string[] {
  return Object.entries(specs)
    .filter(([name, spec]) => auditabilityReason(name, spec, whichFn) === null)
    .map(([name]) => name);
}

// Audit emits raw measurements. Interpretation (is X% good? bad?) is left to
// the user or to a downstream analyzing agent — different providers, prompts,
// and setups have different ceilings, and baking thresholds into the tool
// would be opinion, not measurement.

export function scanClaudeHooks(claudeHome: string = path.join(os.homedir(), ".claude")): Offender[] {
  const root = path.join(claudeHome, "plugins", "cache");
  if (!existsSync(root)) return [];
  const out: Offender[] = [];
  for (const file of walkForHooksJson(root)) {
    let body: any;
    try {
      body = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const entries = body?.hooks?.SessionStart;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const matcher = typeof entry?.matcher === "string" ? entry.matcher : "";
      const tokens = matcher.split("|").map((s: string) => s.trim().toLowerCase());
      if (!tokens.includes("resume")) continue;
      out.push({
        name: pluginNameFromPath(root, file),
        file,
        matcher,
      });
    }
  }
  return out;
}

function walkForHooksJson(root: string): string[] {
  const found: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) stack.push(full);
      else if (e === "hooks.json" && path.basename(dir) === "hooks") found.push(full);
    }
  }
  return found;
}

function pluginNameFromPath(root: string, file: string): string {
  // file = root/<org>/<plugin>/<version>/hooks/hooks.json — emit "<plugin>@<version>"
  const rel = path.relative(root, file);
  const parts = rel.split(path.sep);
  if (parts.length >= 4) return `${parts[parts.length - 4]}@${parts[parts.length - 3]}`;
  return rel;
}

export const SCANNERS: Record<string, CliScanner> = {
  claude: () => scanClaudeHooks(),
};

export function runScanner(agentName: string): ScannerOutput {
  const fn = SCANNERS[agentName];
  return fn ? fn() : "no-scanner";
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

// Trajectory of cache% across turns. Measurable signal: a flat trajectory at
// any level means the cache isn't warming. Tokens: ↑ (grew >2pp), ↓ (fell
// >2pp), → (within ±2pp), · (no comparable data — first turn or an errored
// turn on either side). A successful turn with cached=0 is treated as 0% for
// trajectory purposes (going from "no cache yet" to 99% is a real ↑).
export function trajectory(turns: TurnResult[]): string {
  const tokens: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    if (i === 0) { tokens.push("·"); continue; }
    const prev = turns[i - 1]!;
    const cur = turns[i]!;
    if (prev.error !== null || cur.error !== null) { tokens.push("·"); continue; }
    const prevPct = prev.pct ?? 0;
    const curPct = cur.pct ?? 0;
    const delta = curPct - prevPct;
    // Tolerance of ±2pp keeps small natural drift labeled flat. The 0.0201
    // slack absorbs IEEE-754 noise (e.g., 0.51-0.49 = -0.0200000000000000018).
    if (Math.abs(delta) <= 0.0201) tokens.push("→");
    else if (delta > 0) tokens.push("↑");
    else tokens.push("↓");
  }
  return tokens.join("");
}

export function renderTextOutput(r: AuditResult, opts: { explain: boolean }): string {
  const lines: string[] = [];
  lines.push(`relevo audit — ${r.turns} turns, prompt: ${JSON.stringify(r.prompt)}`);
  lines.push("");

  const skippedNames = Object.keys(r.skipped);
  if (skippedNames.length > 0) {
    const parts = skippedNames.map((n) => `${n} (${r.skipped[n]})`);
    lines.push(`skipped: ${parts.join(", ")}`);
    lines.push("");
  }

  for (const [name, agent] of Object.entries(r.agents)) {
    lines.push(name);
    lines.push("  turn  fresh    cached   cache%");
    agent.turns.forEach((t, i) => {
      const turnNo = String(i + 1);
      if (t.error) {
        lines.push(`  ${turnNo.padEnd(5)} ${"—".padEnd(8)} ${"—".padEnd(8)} err`);
      } else {
        const pct = (t.pct === null || t.cached === 0) ? "—" : `${Math.round(t.pct * 100)}%`;
        lines.push(
          `  ${turnNo.padEnd(5)} ${fmtNum(t.fresh!).padEnd(8)} ${fmtNum(t.cached!).padEnd(8)} ${pct}`,
        );
      }
    });
    const failed = agent.turns.filter((t) => t.error !== null).length;
    if (failed > 0) {
      lines.push(`  ${failed}/${agent.turns.length} turns errored`);
    } else {
      const last = agent.turns[agent.turns.length - 1]!;
      const lastPct = last.pct === null ? "—" : `${Math.round(last.pct * 100)}%`;
      lines.push(
        `  steady state @ turn ${agent.turns.length}: ${lastPct} cache, ${fmtNum(last.fresh!)} fresh tokens`,
      );
      lines.push(`  trajectory: ${trajectory(agent.turns)}`);
    }
    lines.push("");
  }

  if (opts.explain) {
    lines.push("SessionStart hooks that fire on --resume:");
    for (const name of Object.keys(r.agents)) {
      const scan = r.hookScan[name];
      if (scan === "no-scanner" || scan === undefined) {
        lines.push(`  ${name}:  scanner not yet implemented`);
        continue;
      }
      if (scan.length === 0) {
        lines.push(`  ${name}:  (none found)`);
        continue;
      }
      lines.push(`  ${name}:`);
      for (const off of scan) {
        lines.push(`    • ${off.name}`);
        lines.push(`      file:    ${off.file}`);
        lines.push(`      matcher: ${off.matcher}`);
      }
    }
    lines.push("");
    lines.push("  These hooks run on every --resume. They invalidate the cache prefix only if");
    lines.push("  their output varies between calls (timestamps, version checks, dir state).");
    lines.push("  To confirm impact, neutralize the hook (mv hooks.json aside) and rerun audit.");
  }

  return lines.join("\n") + "\n";
}

export function renderJsonOutput(r: AuditResult): string {
  return JSON.stringify(r) + "\n";
}

export function computeExitCode(r: AuditResult): 0 | 1 | 2 {
  if (Object.keys(r.agents).length === 0) return 2;
  for (const agent of Object.values(r.agents)) {
    if (agent.turns.some((t) => t.error !== null)) return 1;
  }
  return 0;
}

export type AuditOpts = {
  agent: string | null;
  turns: number;
  prompt: string;
  explain: boolean;
  keep: boolean;
  json: boolean;
  helpRequested: boolean;
};

const DEFAULT_PROMPT = "Reply with exactly the word OK. No other text.";

export type ParseResult =
  | { ok: true; opts: AuditOpts }
  | { ok: false; error: string };

export function parseAuditArgs(argv: string[]): ParseResult {
  const opts: AuditOpts = {
    agent: null,
    turns: 4,
    prompt: DEFAULT_PROMPT,
    explain: true,
    keep: false,
    json: false,
    helpRequested: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") opts.helpRequested = true;
    else if (a === "--no-explain") opts.explain = false;
    else if (a === "--explain") opts.explain = true;
    else if (a === "--keep") opts.keep = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--agent") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "error: --agent requires a value" };
      opts.agent = v;
    } else if (a === "--turns") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "error: --turns requires a value" };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 2) {
        return { ok: false, error: `error: --turns must be an integer ≥ 2 (got '${v}')` };
      }
      opts.turns = n;
    } else if (a === "--prompt") {
      const v = argv[++i];
      if (v === undefined) return { ok: false, error: "error: --prompt requires a value" };
      opts.prompt = v;
    } else {
      return { ok: false, error: `error: unknown flag '${a}'. see 'relevo audit --help'` };
    }
  }
  return { ok: true, opts };
}

export function deleteAuditTask(taskDir: string, tasksRoot: string): void {
  const resolvedRoot = path.resolve(tasksRoot) + path.sep;
  const resolvedTarget = path.resolve(taskDir);
  if (!(resolvedTarget + path.sep).startsWith(resolvedRoot)) {
    throw new Error(`refusing to delete '${taskDir}': not under tasks root '${tasksRoot}'`);
  }
  rmSync(resolvedTarget, { recursive: true, force: true });
}

export function auditHelpText(): string {
  return `relevo audit — measure cache hit ratios across agent CLIs

Usage:
  relevo audit [options]

Options:
  --agent <name>     audit only one agent (default: all auditable+available)
  --turns <n>        number of identical turns (default: 4, minimum: 2)
  --prompt <text>    override the default audit prompt
                       (default: "Reply with exactly the word OK. No other text.")
  --explain          run per-CLI offender scanners (default: on)
  --no-explain       skip the offender scan
  --keep             keep the throwaway audit task dir after the run
  --json             emit results as JSON instead of the text table
  --help, -h         show this help

Exit codes:
  0  audited at least one agent, no turn errors
  1  any turn errored (the audit run itself failed for some agent)
  2  usage error, or no auditable agents were available

Output is measurement only — per-turn fresh / cached / cache% plus steady-state
and trajectory. Interpretation (is X% good?) is left to you; what counts as a
healthy cache rate depends on provider, prompt, and setup.

The audit runs each agent in a throwaway task (under .relay/tasks/) so existing
sessions/transcripts aren't touched. Pass --keep to inspect the per-agent task
dirs afterward.
`;
}

const COST_ESTIMATE_SECONDS_PER_TURN = 30;

function notifyStderr(json: boolean, msg: string): void {
  if (json) return;
  process.stderr.write(msg + "\n");
}

async function auditOneAgent(
  agentName: string,
  spec: AgentSpec,
  opts: AuditOpts,
  tasksRoot: string,
): Promise<AgentResult> {
  const taskName = `audit-${Date.now()}-${agentName}`;
  await ensureTask(taskName);
  setActiveTask(taskName);
  const taskDir = path.join(tasksRoot, taskName);
  const turns: TurnResult[] = [];
  try {
    for (let i = 0; i < opts.turns; i++) {
      const prep = await prepareCommand(agentName, spec, opts.prompt);
      const spawn = spawnProc(prep.args, prep.viaStdin, opts.prompt);
      if (spawn.error || !spawn.proc) {
        notifyStderr(opts.json, `${agentName}: turn ${i + 1}/${opts.turns} done`);
        turns.push({ fresh: null, cached: null, pct: null, error: spawn.error ?? "spawn failed" });
        continue;
      }
      const run = newRun(agentName, "#000000", opts.prompt);
      const result = await streamToRun({
        run, proc: spawn.proc, parser: prep.parser, agentName,
        preGen: prep.preGen, sessionId: prep.sessionId, verbose: false,
      });
      if (result.exitCode !== 0 || !run.tokens) {
        notifyStderr(opts.json, `${agentName}: turn ${i + 1}/${opts.turns} done`);
        turns.push({
          fresh: null, cached: null, pct: null,
          error: result.exitCode !== 0 ? `exit ${result.exitCode}` : "no usage event",
        });
        continue;
      }
      const m = tokenMetrics(run.tokens);
      notifyStderr(opts.json, `${agentName}: turn ${i + 1}/${opts.turns} done`);
      turns.push({ fresh: m.fresh, cached: m.cached, pct: m.pct, error: null });
    }
  } finally {
    if (!opts.keep) deleteAuditTask(taskDir, tasksRoot);
  }
  return { turns };
}

// Resolve --agent <name> to an exit-2 error string, or null if it's auditable.
// Spec-shaped messages: one per failure mode.
function validateAgentForAudit(
  name: string,
  configured: Record<string, AgentSpec>,
): { ok: true; spec: AgentSpec } | { ok: false; error: string } {
  const spec = configured[name];
  if (!spec) {
    return { ok: false, error: `error: unknown agent '${name}'. configured: ${Object.keys(configured).join(", ")}` };
  }
  if (!agentIsEnabled(spec)) {
    return { ok: false, error: `error: agent '${name}' is disabled in agents.json` };
  }
  const cmd = agentCommandName(spec);
  if (cmd && !which(cmd)) {
    return { ok: false, error: `error: agent '${name}' is not installed (binary '${cmd}' not on PATH)` };
  }
  const reason = auditabilityReason(name, spec);
  if (reason !== null) {
    return { ok: false, error: `error: agent '${name}' is not auditable (${reason})` };
  }
  return { ok: true, spec };
}

export async function runAudit(argv: string[]): Promise<number> {
  const parsed = parseAuditArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(parsed.error + "\n");
    return 2;
  }
  const opts = parsed.opts;
  if (opts.helpRequested) {
    process.stdout.write(auditHelpText());
    return 0;
  }

  ensureDirsSync();
  const config = loadConfig();
  const tasksRoot = path.join(stateDir(), "tasks");

  // Decide which agents to audit and which to record as skipped.
  const agentsToAudit: string[] = [];
  const skipped: Record<string, string> = {};
  if (opts.agent) {
    const check = validateAgentForAudit(opts.agent, config.agents);
    if (!check.ok) {
      process.stderr.write(check.error + "\n");
      return 2;
    }
    agentsToAudit.push(opts.agent);
  } else {
    for (const [name, spec] of Object.entries(config.agents)) {
      const reason = auditabilityReason(name, spec);
      if (reason === null) agentsToAudit.push(name);
      else skipped[name] = reason;
    }
  }

  // Early exit: zero agents to audit → exit 2 before cost warning or any output.
  if (agentsToAudit.length === 0) {
    process.stderr.write("error: no auditable agents available\n");
    return 2;
  }

  // Cost warning to stderr (suppressed under --json).
  const totalTurns = agentsToAudit.length * opts.turns;
  const estMin = Math.max(1, Math.round((totalTurns * COST_ESTIMATE_SECONDS_PER_TURN) / 60));
  notifyStderr(
    opts.json,
    `relevo audit will run ${agentsToAudit.length} agents × ${opts.turns} turns = ${totalTurns} model turns (~${estMin} min, billed to your CLI accounts).`,
  );

  // Run each agent's audit (sequential — keeps output legible and avoids competing for IO).
  const agents: Record<string, AgentResult> = {};
  for (const name of agentsToAudit) {
    agents[name] = await auditOneAgent(name, config.agents[name]!, opts, tasksRoot);
  }

  // Always populate hookScan so the JSON shape invariant holds
  // (hookScan keys match agents keys). The text renderer hides
  // the offender section when --no-explain is passed.
  const hookScan: Record<string, ScannerOutput> = {};
  if (opts.explain) {
    notifyStderr(opts.json, "Running offender scan (skip with --no-explain).");
  }
  for (const name of agentsToAudit) hookScan[name] = runScanner(name);

  const result: AuditResult = {
    prompt: opts.prompt,
    turns: opts.turns,
    agents,
    skipped,
    hookScan,
  };

  process.stdout.write(
    opts.json ? renderJsonOutput(result) : renderTextOutput(result, { explain: opts.explain }),
  );
  return computeExitCode(result);
}

