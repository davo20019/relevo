import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { AgentSpec } from "./config.js";
import { transcriptDir } from "./paths.js";

export type TurnStatus = "completed" | "cancelled" | "interrupted" | "failed";
export type TokenTotals = { in: number; out: number } | null;
export type TurnDependency = { agent: string; run_id: string; turn_id?: string };
export type TurnEvent = { kind: string; payload: string | null };

export type IndexEntry = {
  v: 1;
  turn_id: string;
  run_id: string;
  ts: string;
  status: TurnStatus;
  prompt_preview: string;
  response_preview: string | null;
  files_edited: string[];
  tools_used: string[];
  attached_images: string[];
  tokens: TokenTotals;
  depends_on: TurnDependency | null;
  path: string;
};

export type TurnFile = IndexEntry & {
  prompt: string;
  response: string;
  events: TurnEvent[];
  agent_spec: Partial<AgentSpec> | null;
};

export type AppendTurnInput = {
  runId: string;
  status: TurnStatus;
  userPrompt: string;
  response: string;
  filesEdited?: string[];
  toolsUsed?: string[];
  attachedImages?: string[];
  tokens?: TokenTotals;
  dependsOn?: TurnDependency | null;
  events?: TurnEvent[];
  agentSpec?: Partial<AgentSpec> | null;
};

const transcriptWriteLocks = new Map<string, Promise<unknown>>();

function withTranscriptWriteLock<T>(file: string, op: () => Promise<T>): Promise<T> {
  const prev = transcriptWriteLocks.get(file) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(op);
  transcriptWriteLocks.set(file, next);
  void next
    .finally(() => {
      if (transcriptWriteLocks.get(file) === next) transcriptWriteLocks.delete(file);
    })
    .catch((err) => {
      // The awaiting caller already sees this rejection via `next`; this is the
      // side observer used only to keep the lock map clean. Surface to stderr
      // when RELEVO_DEBUG is set so a silent transcript-write failure does not
      // hide a real I/O problem.
      if (process.env.RELEVO_DEBUG) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`relevo: transcript write error on ${file}: ${msg}\n`);
      }
    });
  return next;
}

function indexEntryFromTurn(turn: TurnFile): IndexEntry {
  return {
    v: turn.v,
    turn_id: turn.turn_id,
    run_id: turn.run_id,
    ts: turn.ts,
    status: turn.status,
    prompt_preview: turn.prompt_preview,
    response_preview: turn.response_preview,
    files_edited: turn.files_edited,
    tools_used: turn.tools_used,
    attached_images: turn.attached_images,
    tokens: turn.tokens,
    depends_on: turn.depends_on,
    path: turn.path,
  };
}

function preview(text: string, max = 200): string {
  const compact = text.trim().replace(/\s+/g, " ");
  return compact.length <= max ? compact : compact.slice(0, max - 3) + "...";
}

function newTurnId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomUUID().slice(0, 8)}`;
}

export function transcriptIndexPath(agent: string): string {
  return path.join(transcriptDir(), `${agent}.index.jsonl`);
}

// turn ids come from newTurnId(): YYYYMMDDTHHMMSSZ-<8 hex>. Asserting this
// before joining onto a path is defense-in-depth — turn ids are an internal
// invariant, but they end up in filesystem paths, so a regression that lets a
// malformed id through would be a path-traversal foothold.
const TURN_ID_RE = /^\d{8}T\d{6}Z-[a-f0-9]{8}$/;

export function transcriptTurnPath(agent: string, turnId: string): string {
  if (!TURN_ID_RE.test(turnId)) {
    throw new Error(`invalid transcript turn id: ${JSON.stringify(turnId)}`);
  }
  return path.join(transcriptDir(), agent, `${turnId}.json`);
}

export async function appendTurn(agent: string, turn: TurnFile): Promise<void> {
  const indexPath = transcriptIndexPath(agent);
  await withTranscriptWriteLock(indexPath, async () => {
    const fullPath = transcriptTurnPath(agent, turn.turn_id);
    const tmpPath = `${fullPath}.tmp`;
    const fullTurn: TurnFile = {
      ...turn,
      path: `${agent}/${turn.turn_id}.json`,
    };
    const indexEntry = indexEntryFromTurn(fullTurn);
    await mkdir(path.dirname(fullPath), { recursive: true, mode: 0o700 });
    await writeFile(tmpPath, JSON.stringify(fullTurn, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tmpPath, fullPath);
    await mkdir(path.dirname(indexPath), { recursive: true, mode: 0o700 });
    await appendFile(indexPath, JSON.stringify(indexEntry) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  });
}

export async function appendStructuredTurn(
  agent: string,
  input: AppendTurnInput,
): Promise<void> {
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const responsePreview =
    input.status === "cancelled" || input.status === "interrupted"
      ? null
      : preview(input.response);
  await appendTurn(agent, {
    v: 1,
    turn_id: newTurnId(),
    run_id: input.runId,
    ts,
    status: input.status,
    prompt: input.userPrompt,
    response: input.response,
    prompt_preview: preview(input.userPrompt),
    response_preview: responsePreview,
    files_edited: input.filesEdited ?? [],
    tools_used: input.toolsUsed ?? [],
    attached_images: input.attachedImages ?? [],
    tokens: input.tokens ?? null,
    depends_on: input.dependsOn ?? null,
    path: "",
    events: input.events ?? [],
    agent_spec: input.agentSpec ?? null,
  });
}

export async function readIndex(agent: string, n?: number): Promise<IndexEntry[]> {
  const p = transcriptIndexPath(agent);
  if (!existsSync(p)) return [];
  const text = await readFile(p, "utf8");
  const entries: IndexEntry[] = [];
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as IndexEntry & { v?: number };
    if (typeof parsed.v === "number" && parsed.v > 1) {
      throw new Error(`unsupported transcript index version: ${parsed.v}`);
    }
    entries.push(parsed as IndexEntry);
  }
  return n === undefined ? entries : entries.slice(-n);
}

export async function readTurn(agent: string, turnId: string): Promise<TurnFile> {
  return JSON.parse(await readFile(transcriptTurnPath(agent, turnId), "utf8")) as TurnFile;
}

export async function readTurnByRunId(agent: string, runId: string): Promise<TurnFile | null> {
  const entries = await readIndex(agent);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.run_id === runId) return readTurn(agent, entry.turn_id);
  }
  return null;
}

export async function readDependencyTurn(dep: TurnDependency): Promise<TurnFile | null> {
  if (dep.turn_id) {
    try {
      const turn = await readTurn(dep.agent, dep.turn_id);
      // turn_id can be reused only by a different write; validate run_id matches
      // what the dependent recorded so a stale or wrong turn doesn't surface.
      return turn.run_id === dep.run_id ? turn : null;
    } catch {
      // Fall through to scan — file may have been moved/missing; the index is
      // still the authoritative source for which turn carries this run_id.
    }
  }
  return readTurnByRunId(dep.agent, dep.run_id);
}

export async function formatTurnsAsLegacyMarkdown(
  agent: string,
  entries: readonly IndexEntry[],
): Promise<string> {
  const blocks: string[] = [];
  for (const entry of entries) {
    const turn = await readTurn(agent, entry.turn_id);
    blocks.push(
      `## Turn ${turn.ts}\n\n` +
        `### Prompt\n${turn.prompt}\n\n` +
        `### Response\n${turn.response}\n`,
    );
  }
  return blocks.join("\n");
}

export function readIndexSync(agent: string): IndexEntry[] {
  const p = transcriptIndexPath(agent);
  if (!existsSync(p)) return [];
  const entries: IndexEntry[] = [];
  for (const line of readFileSync(p, "utf8").split(/\n/)) {
    if (!line.trim()) continue;
    const parsed = JSON.parse(line) as IndexEntry & { v?: number };
    if (typeof parsed.v === "number" && parsed.v > 1) {
      throw new Error(`unsupported transcript index version: ${parsed.v}`);
    }
    entries.push(parsed as IndexEntry);
  }
  return entries;
}

export function readTurnSync(agent: string, turnId: string): TurnFile {
  return JSON.parse(readFileSync(transcriptTurnPath(agent, turnId), "utf8")) as TurnFile;
}

export function readDependencyTurnSync(dep: TurnDependency): TurnFile | null {
  if (dep.turn_id) {
    try {
      const turn = readTurnSync(dep.agent, dep.turn_id);
      if (turn.run_id === dep.run_id) return turn;
    } catch {
      // Fall through to scan.
    }
  }
  const entries = readIndexSync(dep.agent);
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (entry.run_id === dep.run_id) return readTurnSync(dep.agent, entry.turn_id);
  }
  return null;
}

export function formatTurnsAsLegacyMarkdownSync(
  agent: string,
  entries: readonly IndexEntry[],
): string {
  return entries
    .map((entry) => {
      const turn = readTurnSync(agent, entry.turn_id);
      return (
        `## Turn ${turn.ts}\n\n` +
        `### Prompt\n${turn.prompt}\n\n` +
        `### Response\n${turn.response}\n`
      );
    })
    .join("\n");
}
