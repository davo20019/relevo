import type { AgentConfig } from "./config.js";
import { projectDir, transcriptDir } from "./paths.js";
import { getActiveTask } from "./tasks.js";

function safeTranscriptDir(): string {
  return getActiveTask() ? transcriptDir() : "(none yet)";
}

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
  @claude review @codex ...    include @codex's latest turn as explicit handoff context
  /agents                      list configured agents and availability
  /agents enable <agent>       include an agent in @all again
  /agents disable <agent>      skip an agent from @all

  /task               show current task
  /task list          list all tasks on disk (current is marked *)
  /task new <name>    create a new task and switch to it
  /task rename <new>  rename the current task

  /resume             list recent tasks; /resume <n> to pick one

  /open <agent>       open agent's CLI natively in a new window, resumed at this session
  /focus <agent>      set global default (all projects, future sessions)
  /focus global <agent>   same as /focus <agent>
  /focus local <agent>    project override in .relay/settings.json
  /focus session <agent>  temporary override until quit
  /focus              show global, project, and active default
  /focus clear [global|local|session]  clear saved or session default
  /sync [@agents...]  reserved; task-state sync is not implemented yet

  /image <path>       queue an image to attach to the next dispatch
  /image paste        paste clipboard image to Relevo's cache (requires \`brew install pngpaste\`)
  /image list         show queued images
  /image clear        drop queued images
  (you can also just drag and drop an image file into your prompt)

  /last <agent>       show the most recent turn from an agent
  /tail <agent> [n]   show the last n turns from an agent (default 1)
  /clear              wipe transcripts AND agent sessions for current task
  /reset              same as /clear
  /cwd                show the working directory
  /verbose            toggle showing each command/edit an agent runs (default: hidden)
  /quiet              turn verbose off
  /help               this message
  /exit               quit

Subcommands:
  relevo audit        cache-hit audit for each auditable agent CLI (run \`relevo audit --help\`)

Agents: ${agents}
Current task: ${getActiveTask() ?? "(none yet; type a prompt to start one)"}
Working directory: ${projectDir()}
Transcripts: ${safeTranscriptDir()}
`;
}
