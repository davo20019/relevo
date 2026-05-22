import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
};

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

export function stateDir(): string {
  return path.join(projectDir(), ".relay");
}

export function currentTaskFile(): string {
  return path.join(stateDir(), "current");
}

export function currentTask(): string {
  const f = currentTaskFile();
  if (existsSync(f)) {
    const name = readFileSync(f, "utf8").trim();
    if (name) return name;
  }
  return "default";
}

export async function setCurrentTask(name: string): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  await writeFile(currentTaskFile(), name + "\n");
}

export function taskRoot(name?: string): string {
  return path.join(stateDir(), "tasks", name ?? currentTask());
}

export function transcriptDir(): string {
  return path.join(taskRoot(), "transcripts");
}

export function sessionsFile(): string {
  return path.join(taskRoot(), "sessions.json");
}

export function historyFile(): string {
  // project-wide so prompts survive task switches
  return path.join(stateDir(), "history");
}

export function imagesDir(): string {
  return path.join(taskRoot(), "images");
}

export function listTasks(): string[] {
  const base = path.join(stateDir(), "tasks");
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((p) => {
      try {
        return statSync(path.join(base, p)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export async function ensureTask(name?: string): Promise<string> {
  const n = name ?? currentTask();
  await mkdir(path.join(taskRoot(n), "transcripts"), { recursive: true });
  return n;
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
}

export async function ensureDirs(): Promise<void> {
  await mkdir(stateDir(), { recursive: true });
  maybeMigrateLegacy();
  await ensureTask();
}

// Synchronous variant used by the bin entry's early --help branch.
export function ensureDirsSync(): void {
  mkdirSync(stateDir(), { recursive: true });
  maybeMigrateLegacy();
  mkdirSync(path.join(taskRoot(), "transcripts"), { recursive: true });
}

// Touch a file path with content; used by tests.
export function writeFileSyncPassthrough(p: string, content: string): void {
  writeFileSync(p, content);
}
