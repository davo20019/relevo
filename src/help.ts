import { type AgentConfig, unavailableAgentReasons } from "./config.js";
import { projectDir, transcriptDir } from "./paths.js";
import { getActiveTask } from "./tasks.js";

function safeTranscriptDir(): string {
  return getActiveTask() ? transcriptDir() : "(none yet)";
}

function annotateAgent(name: string, reason: string | undefined): string {
  if (!reason) return `@${name}`;
  if (reason === "disabled") return `@${name} (off)`;
  if (reason === "not installed") return `@${name} (missing)`;
  return `@${name} (${reason})`;
}

export function buildHelpText(config: AgentConfig): string {
  const reasons = unavailableAgentReasons(config.agents);
  const agents = Object.keys(config.agents)
    .map((n) => annotateAgent(n, reasons[n]))
    .join(", ");
  return `
relevo

Pattern: one writer at a time. Use multiple agents for parallel review or
exploration; chain writers serially (e.g. @claude reviews, then @cursor
implements). Parallel writers on the same files will stomp each other —
relevo dispatches and renders but does not coordinate file access.

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
  /default <agent>      set global default agent (all projects, future sessions)
  /default global <agent>   same as /default <agent>
  /default local <agent>    project override in .relay/settings.json
  /default session <agent>  temporary override until quit
  /default              show global, project, and active default
  /default clear [global|local|session]  clear saved or session default
  /after @agent: <prompt>  queue prompt after that agent's current/last run
                           finishes (fires on any terminal state)
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
  /cancel @<agent>     cancel only that agent's active run(s); Esc still cancels all
  /help               this message
  /exit               quit

Agents: ${agents}
Current task: ${getActiveTask() ?? "(none yet; type a prompt to start one)"}
Working directory: ${projectDir()}
Transcripts: ${safeTranscriptDir()}
`;
}
