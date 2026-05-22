import type { AgentConfig } from "./config.js";
import { currentTask, projectDir, transcriptDir } from "./paths.js";

export function buildHelpText(config: AgentConfig): string {
  const agents = Object.keys(config.agents)
    .map((n) => `@${n}`)
    .join(", ");
  return `
relevo

Usage:
  @<agent> <prompt>            dispatch to one agent
  @<a1> @<a2> ... <prompt>     dispatch to several agents in parallel (each in its own panel)
  @all <prompt>                dispatch to every enabled, available CLI agent in parallel
  /agents                      list configured agents and availability
  /agents enable <agent>       include an agent in @all again
  /agents disable <agent>      skip an agent from @all

  /task               show current task
  /task list          list all tasks (current is marked *)
  /task new <name>    create a new task and switch to it
  /task switch <name> switch to an existing task
  /task end           end current task, switch back to default

  /open <agent>       continue an agent's session in a new Terminal window (interactive)

  /image <path>       queue an image to attach to the next dispatch
  /image paste        paste clipboard image (requires \`brew install pngpaste\`)
  /image list         show queued images
  /image clear        drop queued images
  (you can also just drag and drop an image file into your prompt)

  /last <agent>       show the most recent turn from an agent
  /tail <agent> [n]   show the last n turns from an agent (default 1)
  /clear              wipe transcripts for current task
  /reset              wipe transcripts AND agent sessions for current task
  /cwd                show the working directory
  /verbose            toggle showing each command/edit an agent runs (default: hidden)
  /quiet              turn verbose off
  /help               this message
  /exit               quit

Agents: ${agents}
Current task: ${currentTask()}
Working directory: ${projectDir()}
Transcripts: ${transcriptDir()}
`;
}
