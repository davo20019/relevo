import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionsFile } from "./paths.js";

export type Sessions = Record<string, string>;

const sessionWriteLocks = new Map<string, Promise<unknown>>();

function withSessionWriteLock<T>(file: string, op: () => Promise<T>): Promise<T> {
  const prev = sessionWriteLocks.get(file) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  sessionWriteLocks.set(file, next);
  void next.finally(() => {
    if (sessionWriteLocks.get(file) === next) sessionWriteLocks.delete(file);
  });
  return next;
}

export function loadSessions(): Sessions {
  const f = sessionsFile();
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Sessions;
  } catch {
    return {};
  }
}

export async function saveSessionId(agent: string, sessionId: string): Promise<void> {
  const f = sessionsFile();
  await withSessionWriteLock(f, async () => {
    const sessions = loadSessions();
    sessions[agent] = sessionId;
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(sessions, null, 2));
  });
}

export function clearSessions(): void {
  const f = sessionsFile();
  if (existsSync(f)) unlinkSync(f);
}

export async function clearAgentSession(agent: string): Promise<void> {
  const f = sessionsFile();
  await withSessionWriteLock(f, async () => {
    const sessions = loadSessions();
    if (!(agent in sessions)) return;
    delete sessions[agent];
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, JSON.stringify(sessions, null, 2));
  });
}
