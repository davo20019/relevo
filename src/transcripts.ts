import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { currentTask, projectDir, transcriptDir } from "./paths.js";
import { getActiveTaskStorage } from "./tasks.js";
import {
  appendStructuredTurn,
  formatTurnsAsLegacyMarkdownSync,
  readIndexSync,
} from "./transcriptStore.js";

export function transcriptPath(agent: string): string {
  if (getActiveTaskStorage() === "legacy") {
    return path.join(projectDir(), ".relay", "tasks", currentTask(), "transcripts", `${agent}.md`);
  }
  return path.join(transcriptDir(), `${agent}.md`);
}

export function readLastTurns(agent: string, n: number): string {
  if (getActiveTaskStorage() !== "legacy") {
    const entries = readIndexSync(agent).slice(-n);
    if (entries.length > 0) return formatTurnsAsLegacyMarkdownSync(agent, entries);
  }
  const p = transcriptPath(agent);
  if (!existsSync(p)) return "";
  const text = readFileSync(p, "utf8");
  const turns = text.split("## Turn ");
  if (turns.length <= 1) return "";
  const tail = turns.slice(-n);
  return "## Turn " + tail.join("## Turn ");
}

export async function appendTurn(
  agent: string,
  userPrompt: string,
  response: string,
): Promise<void> {
  if (getActiveTaskStorage() !== "legacy") {
    await appendStructuredTurn(agent, {
      runId: randomUUID(),
      status: "completed",
      userPrompt,
      response,
    });
    return;
  }
  const p = transcriptPath(agent);
  await mkdir(path.dirname(p), { recursive: true });
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  const block =
    `\n## Turn ${ts}\n\n` +
    `### Prompt\n${userPrompt}\n\n` +
    `### Response\n${response}\n`;
  await appendFile(p, block);
}
