import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { projectSettingsFile, globalSettingsFile } from "./paths.js";

export type RelevoSettings = {
  default_agent?: string | null;
  // Legacy key from pre-rename releases; read-only fallback. Never written back.
  focus_agent?: string | null;
};

export type DefaultScope = "global" | "local" | "session";

export type DefaultCommand =
  | { kind: "show" }
  | { kind: "set"; scope: DefaultScope; agent: string }
  | { kind: "clear"; scope: "session" | "global" | "local" };

type SettingsPathOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
};

function normalizeAgent(value: unknown): string | null {
  if (typeof value !== "string") return value === null ? null : null;
  const trimmed = value.trim().replace(/^@/, "");
  return trimmed || null;
}

function loadSettingsAt(filePath: string): RelevoSettings {
  try {
    if (!existsSync(filePath)) return {};
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as RelevoSettings;
    const agent =
      parsed.default_agent !== undefined
        ? normalizeAgent(parsed.default_agent)
        : normalizeAgent(parsed.focus_agent);
    return { default_agent: agent };
  } catch {
    return {};
  }
}

function saveSettingsAt(filePath: string, settings: RelevoSettings): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const { focus_agent: _legacy, ...rest } = settings;
  writeFileSync(filePath, JSON.stringify(rest, null, 2) + "\n", "utf8");
}

export function loadGlobalSettings(options: SettingsPathOptions = {}): RelevoSettings {
  return loadSettingsAt(globalSettingsFile(options));
}

export function loadProjectSettings(): RelevoSettings {
  return loadSettingsAt(projectSettingsFile());
}

export function saveGlobalDefaultAgent(
  agent: string | null,
  options: SettingsPathOptions = {},
): void {
  const filePath = globalSettingsFile(options);
  const current = loadSettingsAt(filePath);
  saveSettingsAt(filePath, { ...current, default_agent: agent });
}

export function saveProjectDefaultAgent(agent: string | null): void {
  const filePath = projectSettingsFile();
  const current = loadSettingsAt(filePath);
  saveSettingsAt(filePath, { ...current, default_agent: agent });
}

export type PersistedDefault = {
  agent: string | null;
  source: "global" | "local" | null;
};

export function loadPersistedDefault(options: SettingsPathOptions = {}): PersistedDefault {
  const local = loadProjectSettings().default_agent ?? null;
  if (local) return { agent: local, source: "local" };
  const global = loadGlobalSettings(options).default_agent ?? null;
  if (global) return { agent: global, source: "global" };
  return { agent: null, source: null };
}

export function validateDefaultAgent(
  agent: string | null | undefined,
  knownAgents: string[],
): string | null {
  if (!agent) return null;
  return knownAgents.includes(agent) ? agent : null;
}

export function resolveEffectiveDefault(
  sessionOverride: string | null,
  persisted: PersistedDefault,
  knownAgents: string[],
): string | null {
  const session = validateDefaultAgent(sessionOverride, knownAgents);
  if (session) return session;
  return validateDefaultAgent(persisted.agent, knownAgents);
}

export function parseDefaultCommand(trimmed: string): DefaultCommand | null {
  if (trimmed !== "/default" && !trimmed.startsWith("/default ")) return null;

  const rest = trimmed.replace(/^\/default\s*/, "").replace(/^@/, "").trim();
  if (!rest) return { kind: "show" };

  if (rest === "clear" || rest.startsWith("clear ")) {
    const target = rest.replace(/^clear\s*/, "").trim();
    if (!target || target === "session") return { kind: "clear", scope: "session" };
    if (target === "global") return { kind: "clear", scope: "global" };
    if (target === "local" || target === "project") return { kind: "clear", scope: "local" };
    return null;
  }

  if (rest === "global" || rest === "local" || rest === "project" || rest === "session") {
    const scope = rest === "project" ? "local" : (rest as DefaultScope);
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

export function formatDefaultStatus(opts: {
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

export function defaultSetMessage(scope: DefaultScope, agent: string): string {
  if (scope === "global") {
    return `global default is @${agent}; untagged prompts go there in every session (/default to inspect)`;
  }
  if (scope === "local") {
    return `project default is @${agent} for this repo (/default to inspect)`;
  }
  return `session override is @${agent} until you quit or /default clear session`;
}

export function defaultClearMessage(scope: "session" | "global" | "local"): string {
  if (scope === "global") return "cleared global default agent";
  if (scope === "local") return "cleared project default agent";
  return "cleared session override";
}
