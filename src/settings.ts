import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { configHome, projectSettingsFile, globalSettingsFile } from "./paths.js";

export type RelevoSettings = {
  focus_agent?: string | null;
};

export type FocusScope = "global" | "local" | "session";

export type FocusCommand =
  | { kind: "show" }
  | { kind: "set"; scope: FocusScope; agent: string }
  | { kind: "clear"; scope: "session" | "global" | "local" };

type SettingsPathOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
};

function loadSettingsAt(filePath: string): RelevoSettings {
  try {
    if (!existsSync(filePath)) return {};
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as RelevoSettings;
    if (typeof parsed.focus_agent === "string") {
      const trimmed = parsed.focus_agent.trim().replace(/^@/, "");
      return { focus_agent: trimmed || null };
    }
    return { focus_agent: parsed.focus_agent ?? null };
  } catch {
    return {};
  }
}

function saveSettingsAt(filePath: string, settings: RelevoSettings): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

export function loadGlobalSettings(options: SettingsPathOptions = {}): RelevoSettings {
  return loadSettingsAt(globalSettingsFile(options));
}

export function loadProjectSettings(): RelevoSettings {
  return loadSettingsAt(projectSettingsFile());
}

export function saveGlobalFocusAgent(
  agent: string | null,
  options: SettingsPathOptions = {},
): void {
  const filePath = globalSettingsFile(options);
  const current = loadSettingsAt(filePath);
  saveSettingsAt(filePath, { ...current, focus_agent: agent });
}

export function saveProjectFocusAgent(agent: string | null): void {
  const filePath = projectSettingsFile();
  const current = loadSettingsAt(filePath);
  saveSettingsAt(filePath, { ...current, focus_agent: agent });
}

export type PersistedFocus = {
  agent: string | null;
  source: "global" | "local" | null;
};

export function loadPersistedFocus(options: SettingsPathOptions = {}): PersistedFocus {
  const local = loadProjectSettings().focus_agent ?? null;
  if (local) return { agent: local, source: "local" };
  const global = loadGlobalSettings(options).focus_agent ?? null;
  if (global) return { agent: global, source: "global" };
  return { agent: null, source: null };
}

export function validateFocusAgent(
  agent: string | null | undefined,
  knownAgents: string[],
): string | null {
  if (!agent) return null;
  return knownAgents.includes(agent) ? agent : null;
}

export function resolveEffectiveFocus(
  sessionOverride: string | null,
  persisted: PersistedFocus,
  knownAgents: string[],
): string | null {
  const session = validateFocusAgent(sessionOverride, knownAgents);
  if (session) return session;
  return validateFocusAgent(persisted.agent, knownAgents);
}

export function parseFocusCommand(trimmed: string): FocusCommand | null {
  if (trimmed !== "/focus" && !trimmed.startsWith("/focus ")) return null;

  const rest = trimmed.replace(/^\/focus\s*/, "").replace(/^@/, "").trim();
  if (!rest) return { kind: "show" };

  if (rest === "clear" || rest.startsWith("clear ")) {
    const target = rest.replace(/^clear\s*/, "").trim();
    if (!target || target === "session") return { kind: "clear", scope: "session" };
    if (target === "global") return { kind: "clear", scope: "global" };
    if (target === "local" || target === "project") return { kind: "clear", scope: "local" };
    return null;
  }

  if (rest === "global" || rest === "local" || rest === "project" || rest === "session") {
    const scope = rest === "project" ? "local" : (rest as FocusScope);
    if (scope === "session") return { kind: "clear", scope: "session" };
    return { kind: "clear", scope };
  }

  if (rest.startsWith("global ")) {
    const agent = rest.slice("global ".length).trim().replace(/^@/, "");
    if (!agent) return { kind: "clear", scope: "global" };
    return { kind: "set", scope: "global", agent };
  }

  if (rest.startsWith("local ") || rest.startsWith("project ")) {
    const agent = rest.replace(/^(local|project)\s+/, "").trim().replace(/^@/, "");
    if (!agent) return { kind: "clear", scope: "local" };
    return { kind: "set", scope: "local", agent };
  }

  if (rest.startsWith("session ")) {
    const agent = rest.slice("session ".length).trim().replace(/^@/, "");
    if (!agent) return { kind: "clear", scope: "session" };
    return { kind: "set", scope: "session", agent };
  }

  return { kind: "set", scope: "global", agent: rest };
}

export function formatFocusStatus(opts: {
  effective: string | null;
  sessionOverride: string | null;
  globalAgent: string | null;
  localAgent: string | null;
}): string {
  const lines: string[] = [];
  if (opts.effective) {
    lines.push(`  active: @${opts.effective}`);
  } else {
    lines.push("  active: none");
  }
  lines.push(`  global: ${opts.globalAgent ? `@${opts.globalAgent}` : "(none)"}`);
  lines.push(`  project: ${opts.localAgent ? `@${opts.localAgent}` : "(none)"}`);
  if (opts.sessionOverride) {
    lines.push(`  session override: @${opts.sessionOverride}`);
  }
  return lines.join("\n");
}

export function focusSetMessage(scope: FocusScope, agent: string): string {
  if (scope === "global") {
    return `global default is @${agent}; untagged prompts go there in every session (/focus to inspect)`;
  }
  if (scope === "local") {
    return `project default is @${agent} for this repo (/focus to inspect)`;
  }
  return `session override is @${agent} until you quit or /focus clear session`;
}

export function focusClearMessage(scope: "session" | "global" | "local"): string {
  if (scope === "global") return "cleared global default agent";
  if (scope === "local") return "cleared project default agent";
  return "cleared session override";
}
