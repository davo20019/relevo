import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { transcriptDir } from "./paths.js";

export function transcriptPath(agent: string): string {
  return path.join(transcriptDir(), `${agent}.md`);
}

export function readLastTurns(agent: string, n: number): string {
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
  const p = transcriptPath(agent);
  await mkdir(path.dirname(p), { recursive: true });
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "");
  const block =
    `\n## Turn ${ts}\n\n` +
    `### Prompt\n${userPrompt}\n\n` +
    `### Response\n${response}\n`;
  await appendFile(p, block);
}
