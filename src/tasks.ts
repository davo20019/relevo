import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import path from "node:path";

// Per-process task state and naming helpers. Tasks live on disk under
// .relay/tasks/<name>/ (see paths.ts). The active task for this process is
// kept here in memory, not in .relay/current, so new terminals start fresh.

export type SlugOptions = { maxWords?: number; maxLen?: number };

export function slugFromPrompt(
  prompt: string,
  opts: SlugOptions = {},
): string | null {
  const maxWords = opts.maxWords ?? 5;
  const maxLen = opts.maxLen ?? 60;
  const cleaned = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const words = cleaned
    .split(" ")
    .filter((w) => w.length > 1 || /\d/.test(w));
  if (words.length === 0) return null;
  const joined = words.slice(0, maxWords).join("-");
  if (!joined) return null;
  // Strip leading/trailing hyphens so the slug always starts with [a-z0-9]
  // (required by validateTaskName) and never ends in '-' after maxLen slicing.
  const trimmed = joined.slice(0, maxLen).replace(/^-+/, "").replace(/-+$/, "");
  return trimmed || null;
}

export function provisionalTaskName(
  now: Date = new Date(),
  pid: number = process.pid,
): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `s-${y}${m}${d}-${hh}${mm}${ss}-${pid}`;
}

const TASK_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,59}$/i;
const COLLISION_SUFFIX_RESERVE = 5;

export function validateTaskName(name: string): string {
  if (typeof name !== "string") throw new Error("invalid task name: not a string");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("invalid task name: empty");
  if (trimmed.length > 60) throw new Error("invalid task name: too long (max 60)");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error("invalid task name: contains a path separator");
  }
  if (trimmed === "." || trimmed === ".." || trimmed.startsWith(".")) {
    throw new Error("invalid task name: leading dot or dot segment");
  }
  if (!TASK_NAME_RE.test(trimmed)) {
    throw new Error(
      "invalid task name: only a-z, 0-9, '-', '_' allowed; must start with alphanumeric",
    );
  }
  return trimmed;
}

function reserveBaseForSuffix(base: string): string {
  const max = 60 - COLLISION_SUFFIX_RESERVE;
  return base.length > max ? base.slice(0, max).replace(/-+$/, "") : base;
}

export function createTaskDir(tasksRoot: string, candidate: string): string {
  const validated = validateTaskName(candidate);
  const base = reserveBaseForSuffix(validated);
  mkdirSync(tasksRoot, { recursive: true });
  for (let i = 0; i < 10_000; i++) {
    const name = i === 0 ? base : `${base}-${i + 1}`;
    try {
      mkdirSync(path.join(tasksRoot, name));
      return name;
    } catch (e: any) {
      if (e?.code !== "EEXIST") throw e;
    }
  }
  const stamp = String(Date.now());
  const fallbackBase = base.slice(0, 60 - stamp.length - 1).replace(/-+$/, "");
  const fallback = validateTaskName(`${fallbackBase}-${stamp}`);
  mkdirSync(path.join(tasksRoot, fallback), { recursive: false });
  return fallback;
}

export function renameTask(tasksRoot: string, from: string, to: string): string {
  const validated = validateTaskName(to);
  const base = reserveBaseForSuffix(validated);
  const src = path.join(tasksRoot, from);
  if (!existsSync(src)) {
    throw new Error(`task directory does not exist: ${src}`);
  }
  if (from === base) return from;
  for (let i = 0; i < 10_000; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const target = path.join(tasksRoot, candidate);
    if (existsSync(target)) continue;
    try {
      renameSync(src, target);
      return candidate;
    } catch (e: any) {
      if (e?.code === "EEXIST" || e?.code === "ENOTEMPTY" || e?.code === "EPERM") {
        continue;
      }
      throw e;
    }
  }
  throw new Error(`could not allocate a free name near '${base}'`);
}

export type TaskInfo = {
  name: string;
  lastActivity: Date;
  agents: string[];
  firstPrompt: string;
};

export function listRecentTasks(tasksRoot: string): TaskInfo[] {
  if (!existsSync(tasksRoot)) return [];
  const out: TaskInfo[] = [];
  for (const entry of readdirSync(tasksRoot)) {
    const dir = path.join(tasksRoot, entry);
    let stat;
    try {
      stat = statSync(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const sessionsPath = path.join(dir, "sessions.json");
    const transcriptsDir = path.join(dir, "transcripts");

    let lastMs = Number.NEGATIVE_INFINITY;
    if (existsSync(sessionsPath)) {
      lastMs = Math.max(lastMs, statSync(sessionsPath).mtimeMs);
    }
    const transcripts = existsSync(transcriptsDir)
      ? readdirSync(transcriptsDir)
          .filter((f) => f.endsWith(".md"))
          .sort()
      : [];
    for (const f of transcripts) {
      try {
        lastMs = Math.max(lastMs, statSync(path.join(transcriptsDir, f)).mtimeMs);
      } catch {
        // Ignore transcripts deleted during the scan.
      }
    }
    if (lastMs === Number.NEGATIVE_INFINITY) lastMs = stat.mtimeMs;

    let agents: string[] = [];
    if (existsSync(sessionsPath)) {
      try {
        const sessions = JSON.parse(readFileSync(sessionsPath, "utf8")) as Record<string, string>;
        agents = Object.keys(sessions);
      } catch {
        agents = [];
      }
    }

    let firstPrompt = "";
    if (existsSync(transcriptsDir)) {
      for (const f of transcripts) {
        const text = readFileSync(path.join(transcriptsDir, f), "utf8");
        const m = text.match(/### Prompt\n([\s\S]+?)(?=\n### |\n*$)/);
        if (m && m[1]) {
          firstPrompt = m[1].trim().replace(/\s+/g, " ").slice(0, 80);
          break;
        }
      }
    }

    out.push({ name: entry, lastActivity: new Date(lastMs), agents, firstPrompt });
  }
  out.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  return out;
}

let activeTask: string | null = null;

export function getActiveTask(): string | null {
  return activeTask;
}

export function setActiveTask(name: string): void {
  activeTask = name;
}

export function clearActiveTaskForTest(): void {
  activeTask = null;
}
