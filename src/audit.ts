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

export type VerdictTier = "excellent" | "ok" | "investigate";

export type AgentResult = {
  turns: TurnResult[];
  verdict: VerdictTier;
  verdictPct: number;
  providerNote: string | null;
};

export type Offender = {
  name: string;
  file: string;
  pattern: string;
  effect: string;
  patch: string;
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

export function numericVerdict(pct: number): VerdictTier {
  if (pct >= 0.95) return "excellent";
  if (pct >= 0.80) return "ok";
  return "investigate";
}

export function providerQualifier(
  agentName: string,
  pct: number,
  scan: ScannerOutput,
): string | null {
  // "No offenders" = empty array OR the no-scanner sentinel. Both mean
  // "no known config-level cause to flag", which is when the qualifier
  // is meant to suppress the alarm for known-quirky providers.
  const noOffenders = scan === "no-scanner" || scan.length === 0;
  if (agentName === "codex" && pct <= 0.50 && noOffenders) {
    return "provider-typical for codex";
  }
  return null;
}

export function displayVerdictText(
  tier: VerdictTier,
  pct: number,
  providerNote: string | null,
  turn: number,
): string {
  if (providerNote) return `ok (${providerNote} — see Notes)`;
  return `${tier} (${Math.round(pct * 100)}% at turn ${turn})`;
}

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
        pattern: "SessionStart+resume",
        effect: "injects content on every --resume, invalidating prefix cache",
        patch: "remove 'resume' from the matcher or scope it to non-resume SessionStart events",
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

const CODEX_NOTE =
  "codex caches less aggressively than claude/cursor at the API level. Cache rates in the\n" +
  "  25–45% range are typical and not indicative of a config issue.";

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
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
        const pct = (i === 0 || t.pct === null) ? "—" : `${Math.round(t.pct * 100)}%`;
        lines.push(
          `  ${turnNo.padEnd(5)} ${fmtNum(t.fresh!).padEnd(8)} ${fmtNum(t.cached!).padEnd(8)} ${pct}`,
        );
      }
    });
    // Any errored turn overrides the numeric verdict (spec failure-modes rule).
    const failed = agent.turns.filter((t) => t.error !== null).length;
    if (failed > 0) {
      lines.push(`  verdict: error — ${failed}/${agent.turns.length} turns failed`);
    } else {
      const text = displayVerdictText(agent.verdict, agent.verdictPct, agent.providerNote, agent.turns.length);
      lines.push(`  verdict: ${text}`);
    }
    lines.push("");
  }

  if (Object.keys(r.agents).some((n) => n === "codex")) {
    lines.push("Notes:");
    lines.push(`  ${CODEX_NOTE}`);
    lines.push("");
  }

  if (opts.explain) {
    lines.push("Likely cache offenders:");
    for (const name of Object.keys(r.agents)) {
      const scan = r.hookScan[name];
      if (scan === "no-scanner" || scan === undefined) {
        lines.push(`  ${name}:  scanner not yet implemented`);
        continue;
      }
      if (scan.length === 0) {
        lines.push(`  ${name}:  (none detected)`);
        continue;
      }
      lines.push(`  ${name}:`);
      for (const off of scan) {
        lines.push(`    • ${off.name}`);
        lines.push(`      file:    ${off.file}`);
        lines.push(`      pattern: ${off.pattern}`);
        lines.push(`      effect:  ${off.effect}`);
        lines.push(`      patch:   ${off.patch}`);
      }
    }
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
    if (agent.verdict === "investigate" && agent.providerNote === null) return 1;
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
  0  audited at least one agent, no unqualified 'investigate', no turn errors
  1  any agent verdict 'investigate' (without provider qualifier), or any turn errored
  2  usage error, or no auditable agents were available

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
  // Verdict is computed from turn N. If turn N errored or had null pct,
  // verdictPct is 0 (which → numericVerdict "investigate"). The renderer
  // overrides the verdict line entirely when any turn errored, so the
  // numeric tier is only consulted on a clean run.
  const lastTurn = turns[turns.length - 1];
  const pct = lastTurn && lastTurn.pct !== null ? lastTurn.pct : 0;
  return { turns, verdict: numericVerdict(pct), verdictPct: pct, providerNote: null };
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

  // Apply provider qualifiers now that scanner output is available.
  for (const name of agentsToAudit) {
    const agent = agents[name]!;
    const scan = hookScan[name] ?? "no-scanner";
    agent.providerNote = providerQualifier(name, agent.verdictPct, scan);
  }

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

