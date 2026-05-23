import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextCompactionConfig } from "./compaction.js";
import which from "./which.js";
import { CONFIG_PATH } from "./paths.js";

export type AgentSpec = {
  cmd: string;
  init_template?: string;
  resume_template?: string;
  open_template?: string;
  pre_generate_id?: string;
  parser?: string;
  session_id_from_dir?: string;
  session_id_strip_ext?: string;
  enabled?: boolean;
};

export type AgentConfig = {
  agents: Record<string, AgentSpec>;
  context_turns: number;
  context_compaction?: ContextCompactionConfig;
};

export const DEFAULT_CONFIG: AgentConfig = {
  agents: {
    claude: {
      // stream-json requires --verbose in -p mode; emits per-event JSON lines
      // (system init, assistant turns with text + tool_use blocks, final result).
      cmd: "claude -p --output-format stream-json --verbose --dangerously-skip-permissions {prompt}",
      init_template:
        "claude -p --output-format stream-json --verbose --session-id {session_id} --dangerously-skip-permissions {prompt}",
      resume_template:
        "claude -p --output-format stream-json --verbose --resume {session_id} --dangerously-skip-permissions {prompt}",
      open_template: "claude --resume {session_id}",
      pre_generate_id: "uuid",
      parser: "claude-json",
    },
    codex: {
      // -c sandbox_mode=workspace-write works on BOTH `codex exec` and `codex exec resume`,
      // unlike --sandbox which only exists on the fresh subcommand.
      cmd: "codex exec -c sandbox_mode=workspace-write --skip-git-repo-check --json --color never {prompt}",
      resume_template:
        "codex exec resume -c sandbox_mode=workspace-write --skip-git-repo-check --json {session_id} {prompt}",
      open_template: "codex resume {session_id}",
      parser: "codex-json",
    },
    cursor: {
      // Headless Cursor agent: --force (run tools), --sandbox disabled + --trust (workspace access),
      // --approve-mcps (unattended MCP), matching the automation level of claude/codex defaults.
      cmd: "agent -p --force --model auto --output-format stream-json --sandbox disabled --trust --approve-mcps {prompt}",
      init_template:
        "agent -p --force --model auto --output-format stream-json --sandbox disabled --trust --approve-mcps --resume {session_id} {prompt}",
      resume_template:
        "agent -p --force --model auto --output-format stream-json --sandbox disabled --trust --approve-mcps --resume {session_id} {prompt}",
      open_template: "agent --resume {session_id}",
      pre_generate_id: "uuid",
      parser: "cursor-json",
    },
    opencode: { cmd: "opencode run {prompt}" },
    pi: { cmd: "pi -p {prompt}" },
    agy: {
      // agy parses positional args after -p as the prompt, so any flags must come
      // BEFORE -p or they get consumed as the prompt value.
      cmd: "agy --dangerously-skip-permissions -p {prompt}",
      resume_template:
        "agy --conversation {session_id} --dangerously-skip-permissions -p {prompt}",
      open_template: "agy --conversation {session_id}",
      session_id_from_dir: "~/.gemini/antigravity-cli/conversations",
      session_id_strip_ext: ".pb",
      parser: "agy-text",
    },
  },
  context_turns: 3,
  context_compaction: {
    enabled: true,
    maxCharsPerBlock: 24_000,
    maxLineLength: 700,
  },
};

// 24-bit hex colors so the palette reads as deliberate and technical rather
// than the default ANSI candy-shop. Ink's Text component accepts hex strings.
export const AGENT_COLORS = [
  "#5DD8E3", // cyan
  "#D85DB4", // mauve magenta
  "#7BD862", // technical green
  "#E0C75D", // warm yellow
  "#5DA0E3", // azure
] as const;

export const SLASH_COMMANDS = [
  "/help",
  "/agents",
  "/last",
  "/tail",
  "/clear",
  "/reset",
  "/resume",
  "/cwd",
  "/pwd",
  "/workspace",
  "/verbose",
  "/quiet",
  "/task",
  "/open",
  "/focus",
  "/sync",
  "/image",
  "/exit",
  "/quit",
] as const;

export function loadConfig(notify?: (msg: string) => void): AgentConfig {
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
    notify?.(`created default config at ${CONFIG_PATH}`);
  }
  return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as AgentConfig;
}

export function saveConfig(config: AgentConfig): void {
  mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function agentCommandName(spec: AgentSpec): string | null {
  // Simple split: first whitespace-delimited token. Mirrors Python shlex.split for
  // the common case (no embedded quotes in the command name).
  const cmd = (spec.cmd || "").trim();
  if (!cmd) return null;
  const first = cmd.split(/\s+/)[0];
  return first || null;
}

export function agentIsEnabled(spec: AgentSpec): boolean {
  return spec.enabled !== false;
}

export function availableAgentNames(
  specs: Record<string, AgentSpec>,
  whichFn: (name: string) => string | null = which,
): string[] {
  const out: string[] = [];
  for (const [name, spec] of Object.entries(specs)) {
    if (!agentIsEnabled(spec)) continue;
    const cmd = agentCommandName(spec);
    if (cmd && whichFn(cmd)) out.push(name);
  }
  return out;
}

export function unavailableAgentReasons(
  specs: Record<string, AgentSpec>,
  whichFn: (name: string) => string | null = which,
): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const [name, spec] of Object.entries(specs)) {
    if (!agentIsEnabled(spec)) {
      reasons[name] = "disabled";
      continue;
    }
    const cmd = agentCommandName(spec);
    if (!cmd) reasons[name] = "no command";
    else if (!whichFn(cmd)) reasons[name] = "not installed";
  }
  return reasons;
}
