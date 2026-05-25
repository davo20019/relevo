import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getActiveTask, getActiveTaskStorage, setActiveTask } from "./tasks.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Resolve the agents.json bundled with the package. When running from dist/ it
// sits one level up; in dev (src/) it's also one level up. Either way: walk up
// until we find it.
export function scriptDir(): string {
  let dir = here;
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, "agents.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(here, "..");
}

export const DEFAULT_CONFIG_PATH = path.join(scriptDir(), "agents.json");

type ConfigPathOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  homeDir?: string;
  platform?: NodeJS.Platform;
};

export type PathOptions = ConfigPathOptions;

export function expandHome(p: string, homeDir = os.homedir()): string {
  if (p === "~") return homeDir;
  if (p.startsWith("~/")) return path.join(homeDir, p.slice(2));
  return p;
}

export function configHome(options: Pick<ConfigPathOptions, "env" | "homeDir"> = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  if (xdgConfigHome) return path.join(expandHome(xdgConfigHome, homeDir), "relevo");
  return path.join(homeDir, ".config", "relevo");
}

export function resolveConfigPath(options: ConfigPathOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const explicit = env.RELEVO_CONFIG?.trim();
  if (explicit) return expandHome(explicit, homeDir);

  const local = path.join(cwd, "agents.json");
  if (existsSync(local)) return local;

  return path.join(configHome({ env, homeDir }), "agents.json");
}

export const CONFIG_PATH = resolveConfigPath();

export function projectDir(): string {
  return process.cwd();
}

export function projectLocalDir(): string {
  return path.join(projectDir(), ".relay");
}

export function stateDir(): string {
  return projectLocalDir();
}

export function projectIdFile(): string {
  return path.join(projectLocalDir(), "project.json");
}

export function relevoStateHome(options: PathOptions = {}): string {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const explicit = env.RELEVO_STATE_HOME?.trim();
  if (explicit) return expandHome(explicit, homeDir);
  if (platform === "darwin") return path.join(homeDir, "Library", "Application Support", "relevo");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA?.trim();
    if (local) return path.join(local, "relevo", "State");
    const profile = env.USERPROFILE?.trim() || homeDir;
    return path.join(profile, "AppData", "Local", "relevo", "State");
  }
  const xdgState = env.XDG_STATE_HOME?.trim();
  if (xdgState) return path.join(expandHome(xdgState, homeDir), "relevo");
  return path.join(homeDir, ".local", "state", "relevo");
}

export function ensureProjectId(): string {
  const f = projectIdFile();
  if (existsSync(f)) {
    try {
      const parsed = JSON.parse(readFileSync(f, "utf8")) as { project_id?: unknown };
      if (typeof parsed.project_id === "string" && parsed.project_id) return parsed.project_id;
    } catch {
      // Fall through and rewrite a valid id.
    }
  }
  const id = randomUUID();
  mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  writeFileSync(f, JSON.stringify({ v: 1, project_id: id }, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
  return id;
}

export function readProjectId(): string {
  return ensureProjectId();
}

export function projectStateRoot(projectId?: string, options: PathOptions = {}): string {
  return path.join(relevoStateHome(options), "projects", projectId ?? ensureProjectId());
}

export function currentTask(): string {
  const t = getActiveTask();
  if (!t) {
    throw new Error("no active task. call setActiveTask first, or use /resume to pick one.");
  }
  return t;
}

export function setCurrentTask(name: string): void {
  setActiveTask(name);
}

export function taskRoot(name?: string, options: PathOptions = {}): string {
  return path.join(projectStateRoot(undefined, options), "tasks", name ?? currentTask());
}

export function legacyTaskRoot(name?: string): string {
  return path.join(projectLocalDir(), "tasks", name ?? currentTask());
}

export function transcriptDir(options: PathOptions = {}): string {
  if (getActiveTaskStorage() === "legacy") {
    return path.join(legacyTaskRoot(), "transcripts");
  }
  return path.join(taskRoot(undefined, options), "transcripts");
}

export function sessionsFile(options: PathOptions = {}): string {
  if (getActiveTaskStorage() === "legacy") {
    return path.join(legacyTaskRoot(), "sessions.json");
  }
  return path.join(taskRoot(undefined, options), "sessions.json");
}

export function historyFile(): string {
  // project-wide so prompts survive task switches
  return path.join(projectStateRoot(), "history");
}

export function dispatchStatsFile(): string {
  return path.join(projectStateRoot(), "dispatch-stats.json");
}

export function projectSettingsFile(): string {
  return path.join(stateDir(), "settings.json");
}

export function globalSettingsFile(
  options: Pick<ConfigPathOptions, "env" | "homeDir"> = {},
): string {
  return path.join(configHome(options), "settings.json");
}

export function imagesDir(options: PathOptions = {}): string {
  return path.join(taskRoot(undefined, options), "images");
}

export function ensureTask(name: string, options: PathOptions = {}): Promise<string> {
  return mkdir(path.join(taskRoot(name, options), "transcripts"), {
    recursive: true,
    mode: 0o700,
  }).then(() => name);
}

export function maybeMigrateLegacy(): void {
  // Move pre-task-scoping layout into .relay/tasks/default/ if present.
  const legacy = path.join(stateDir(), "transcripts");
  if (existsSync(legacy) && statSync(legacy).isDirectory()) {
    const target = path.join(stateDir(), "tasks", "default", "transcripts");
    if (!existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(legacy, target);
    }
  }
  // Older versions stored "the current task" in .relay/current. The new model
  // keeps the active task in memory and ignores this file. Leave it on disk:
  // an older relevo build still reads it, so deleting it on first launch of
  // this build would silently break downgrade/rollback. It is harmless here.
}

export async function ensureDirs(): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  maybeMigrateLegacy();
}

// Synchronous variant used by the bin entry's early --help branch.
export function ensureDirsSync(): void {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  maybeMigrateLegacy();
  // Do not create a default task here. New processes intentionally start with
  // no active task; the first dispatch creates one lazily.
}

// Touch a file path with content; used by tests.
export function writeFileSyncPassthrough(p: string, content: string): void {
  writeFileSync(p, content);
}
