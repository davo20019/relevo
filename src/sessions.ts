import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionsFile } from "./paths.js";

export type Sessions = Record<string, string>;

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
  const sessions = loadSessions();
  sessions[agent] = sessionId;
  const f = sessionsFile();
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(sessions, null, 2));
}

export function clearSessions(): void {
  const f = sessionsFile();
  if (existsSync(f)) unlinkSync(f);
}

export async function clearAgentSession(agent: string): Promise<void> {
  const sessions = loadSessions();
  if (!(agent in sessions)) return;
  delete sessions[agent];
  const f = sessionsFile();
  await mkdir(path.dirname(f), { recursive: true });
  await writeFile(f, JSON.stringify(sessions, null, 2));
}
