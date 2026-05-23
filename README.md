# relevo

A multi-agent coding workspace that sits in front of local coding-agent CLIs so
you can drive Claude Code, Codex, OpenCode, Cursor CLI, Antigravity (`agy`), and
similar tools from one terminal. Each agent's transcript is fed back to the
others as context, and you can fan a prompt out to several agents in parallel.

## Why

You finish a task with one agent, want another to review it, take the feedback
back to the first, and then compare their answers. Today that usually means
juggling terminal windows and copy-pasting. This wraps the CLIs you already have
installed, using their existing logins and no API keys, and lets you say:

```
> @claude @codex review the API design
> @cursor apply the safest changes from their feedback
> @claude re-review
> /open claude
```

## Requirements

- Node.js 20+
- Any coding-agent CLI that has a headless mode and is on your `$PATH`

Built-in defaults are provided for:

- `claude -p ...` (Claude Code)
- `codex exec ...` (Codex)
- `opencode run ...`
- `agent -p ...` (Cursor CLI, new binary; replaces `cursor-agent`)
- `agy --dangerously-skip-permissions -p ...` (Google Antigravity)
- `pi -p ...` (`@earendil-works/pi-coding-agent`)

Other CLIs such as Gemini or Aider can be added by editing `agents.json`.

You log into each CLI normally once. relevo just shells out, so your
existing auth is reused.

## Quickstart

```bash
npx relevo
# or install globally
npm i -g relevo && relevo
```

First run creates `~/.config/relevo/agents.json` with six agents wired up:
`claude`, `codex`, `cursor`, `opencode`, `agy` (Antigravity), and `pi`. Type
`/help` inside the REPL.

### From source

```bash
git clone https://github.com/davo20019/relevo.git
cd relevo
npm install
npm run dev   # or: npm run build && npm start
```

## Usage

```
> @claude write spec.md for a Redis-backed work queue
> @codex review spec.md
> @claude @codex review the latest diff
> review the latest diff @cursor
> /tail codex 2
> /open claude
> /exit
```

- `@<agent> <prompt>` dispatches to one agent.
- `@<agent1> @<agent2> <prompt>` dispatches to several agents in parallel, each
  in its own live panel. Parallel fanout only happens with two or more leading agent mentions; later mentions are treated as prompt text.
- `@all <prompt>` dispatches to configured agents that are enabled and whose CLI
  executable is available on your `PATH`; disabled or unavailable entries are skipped.
- Trailing mentions route to one agent, so `review this @codex` is equivalent
  to `@codex review this`.
- If you submit a prompt without an agent tag, relevo keeps it pending and
  asks you to pick an agent. Type `@codex` or another agent tag to send that
  saved prompt.
- The last turn from each other agent is prepended as handoff context. For agents
  without native sessions, up to `context_turns` (default 3) of their own prior
  turns are also included.
- Each agent runs in your current working directory, exactly as if you had typed
  the CLI command directly. They share files in that directory.
- Per-project state lives in `./.relay/`. Add it to your project's `.gitignore`.
- Work is organized by task. Each relevo invocation starts fresh by default; a
  task is created lazily on your first prompt and auto-named from that prompt.
  Use `/resume` to pick up a previous task in this project.
  - `.relay/tasks/<task>/transcripts/<agent>.md`: what each agent said in this task
  - `.relay/tasks/<task>/sessions.json`: native session IDs for resumable agents
- `/task list` shows tasks on disk. `/task rename <new>` renames the current
  task. `/resume` shows the 12 most recent tasks; older tasks remain on disk
  and can still be listed with `/task list`.
- Two terminals open in the same project no longer share a session by default.
  Use `/resume` in either terminal to opt into the other one's task.
- Claude, Codex, Cursor, and agy have native session support by default. They
  keep their own conversation memory across turns; transcript replay is the
  fallback for other agents.

## Task Workspace Model

One relevo terminal represents one task. Agents inside that terminal share the
same working directory and task transcripts. Use `@agent` mentions to route
prompts to one or more collaborators in that task.

Relevo keeps chronological scrollback as the source of truth. `/focus <agent>`
narrows live output while a run is active, but historical output remains in the
normal task scrollback.

## Worktrees

Relevo's default is one terminal per task in the current working directory. Use a
git worktree when the task itself needs isolation, such as a risky refactor,
dependency upgrade, migration, or competing implementation attempt.

Do not create a separate worktree per agent unless you intentionally want
isolated experiments that you will merge yourself.

Recommended workflow:

```bash
git worktree add ../my-project-feature feature/my-project-feature
cd ../my-project-feature
relevo
```

## Slash Commands

| Command | What it does |
|---|---|
| `/agents` | list configured agents and availability |
| `/agents enable <agent>` | enable an agent for `@all` |
| `/agents disable <agent>` | disable an agent for `@all` |
| `/last <agent>` | show that agent's most recent turn |
| `/tail <agent> [n]` | show the last n turns from that agent |
| `/clear` | wipe transcripts for the current task |
| `/reset` | wipe transcripts and saved native sessions for the current task |
| `/task` | show the current task |
| `/task list` | list tasks |
| `/task new <name>` | create and switch to a task |
| `/task rename <new>` | rename the current task |
| `/resume` | list recent tasks; `/resume <n>` switches to one |
| `/open <agent>` | open a resumable native session in a new terminal window |
| `/focus <agent>` | show only one agent's live output |
| `/focus` | show all live output |
| `/sync [@agents...]` | reserved for task-state rebroadcasting; not implemented yet |
| `/image <path>` | queue an image file for the next dispatch |
| `/image paste` | queue the clipboard image, requires `pngpaste` |
| `/image list` | show queued images |
| `/image clear` | drop queued images |
| `/cwd`, `/pwd`, `/workspace` | show the shared working directory |
| `/verbose` | show shell commands and file edits in live output |
| `/quiet` | turn verbose mode off |
| `/help` | help |
| `/exit`, `/quit` | quit |

You can also drag and drop an image file into your prompt. Existing image paths
are extracted, attached to the next dispatch, and removed from the prompt text.

## Configuration

Edit your user config at `~/.config/relevo/agents.json` to change commands or
add agents. If `./agents.json` exists in the directory where you launch
`relevo`, it is used as a project-local override. You can also set
`RELEVO_CONFIG=/path/to/agents.json` to point at a specific config file. The
generated defaults look like this:

```json
{
  "agents": {
    "claude": {
      "cmd": "claude -p --output-format stream-json --verbose --dangerously-skip-permissions {prompt}",
      "init_template": "claude -p --output-format stream-json --verbose --session-id {session_id} --dangerously-skip-permissions {prompt}",
      "resume_template": "claude -p --output-format stream-json --verbose --resume {session_id} --dangerously-skip-permissions {prompt}",
      "open_template": "claude --resume {session_id}",
      "pre_generate_id": "uuid",
      "parser": "claude-json"
    },
    "codex": {
      "cmd": "codex exec -c sandbox_mode=workspace-write --skip-git-repo-check --json --color never {prompt}",
      "resume_template": "codex exec resume -c sandbox_mode=workspace-write --skip-git-repo-check --json {session_id} {prompt}",
      "open_template": "codex resume {session_id}",
      "parser": "codex-json"
    },
    "cursor": {
      "cmd": "agent -p --force --model auto --output-format stream-json {prompt}",
      "init_template": "agent -p --force --model auto --output-format stream-json --resume {session_id} {prompt}",
      "resume_template": "agent -p --force --model auto --output-format stream-json --resume {session_id} {prompt}",
      "open_template": "agent --resume {session_id}",
      "pre_generate_id": "uuid",
      "parser": "cursor-json"
    },
    "opencode": {
      "cmd": "opencode run {prompt}"
    },
    "pi": {
      "cmd": "pi -p {prompt}"
    },
    "agy": {
      "cmd": "agy --dangerously-skip-permissions -p {prompt}",
      "resume_template": "agy --conversation {session_id} --dangerously-skip-permissions -p {prompt}",
      "open_template": "agy --conversation {session_id}",
      "session_id_from_dir": "~/.gemini/antigravity-cli/conversations",
      "session_id_strip_ext": ".pb",
      "parser": "agy-text"
    }
  },
  "context_turns": 3
}
```

To add another CLI, merge new entries into the existing `agents` object:

```json
"gemini": {
  "cmd": "gemini -p --yolo {prompt}"
},
"aider": {
  "cmd": "aider --yes --message {prompt}"
}
```

## How Command Templates Work

- If the template contains `{prompt}`, the prompt is substituted into argv.
- If it does not contain `{prompt}`, the prompt is piped via stdin. This is
  useful for very long prompts or CLIs that prefer stdin.
- If an agent has a `resume_template` and a saved session ID, future turns use
  the resume template.
- If an agent has `pre_generate_id: "uuid"`, relevo creates a UUID before the
  first run and uses `init_template`.
- If an agent has `open_template`, `/open <agent>` can continue that native
  session interactively in a new terminal window.
- Set `"enabled": false` on an agent to keep it configured but skip it from
  `@all`, which is useful when a CLI is installed but out of quota or has a
  broken provider/model setting.
- You can also toggle this from inside the REPL with
  `/agents enable <agent>` and `/agents disable <agent>`.
- `session_id_from_dir` snapshots a directory before and after a run. The newest
  new file becomes the saved native session ID.
- `session_id_strip_ext` removes a file extension from that captured session ID.
- `parser` selects an output parser. Codex uses `codex-json` and Cursor uses
  `cursor-json` so relevo can filter event-streamed JSON into messages,
  command counts, edit counts, and session IDs. `agy-text` is a heuristic parser
  for Antigravity's text output.
- `context_turns` controls how many of the target agent's own prior turns are
  replayed when it has no active native session. Other agents always contribute
  their latest turn only.

## Default Agent Notes

- `claude --dangerously-skip-permissions`: bypasses Claude Code permission
  prompts for unattended runs.
- `codex -c sandbox_mode=workspace-write`: lets Codex edit the current project
  while keeping Codex's own sandboxing enabled. This form is used because it
  works for both fresh `codex exec` runs and `codex exec resume`.
- `agent -p --force --model auto --output-format stream-json`: Cursor's new CLI
  binary (replaces `cursor-agent`). Without `--force` it only proposes diffs;
  `--model auto` is required on free plans. `--output-format stream-json` plus
  the `cursor-json` parser keep default output quiet by hiding thinking deltas
  and tool chatter, matching Codex/Claude behavior. Native session continuity
  uses a pre-generated UUID via `--resume <id>`.
- `opencode run`: auto-approves permissions in non-interactive mode.
- `agy --dangerously-skip-permissions -p`: Antigravity's headless print mode with
  auto-approved tool permissions. Flags must come BEFORE `-p` since agy parses
  arguments after `-p` as the prompt body.

If you want an agent to stay cautious, edit its `cmd` to remove the automation
flag or switch Claude back to `--permission-mode acceptEdits`.

## Notes And Gotchas

- Native sessions are supported when the underlying CLI exposes a stable resume
  mechanism. Claude, Codex, Cursor, and agy are configured this way by default.
- Transcript replay is still used as the cross-agent coordination mechanism.
  Agents do not talk to each other directly.
- Parallel dispatch starts every selected agent from the same pre-existing
  transcript context. Their outputs become context for the next turn, not for
  each other during the same fanout.
- Press `Esc` to cancel a running single-agent or parallel dispatch.
- If an agent's saved native session is no longer valid (the underlying CLI
  reports the session as expired or missing), relevo drops the stale session
  ID and automatically retries the call once with a fresh session. You'll see
  a `session expired, retrying with a fresh session` line when this happens.
- The shared cwd is the directory where you launched `relevo`.
- relevo is an interactive terminal UI, not a PTY automation API or log-safe
  batch interface. Run it directly in a terminal; use each underlying CLI
  directly for scripted or captured automation.
- macOS caps argv at roughly 256KB. If you hit that, switch the agent template to
  one without `{prompt}` so the prompt goes via stdin.
- `/open` uses iTerm2 when available via `TERM_PROGRAM`, otherwise Terminal.app.
  It currently targets macOS.
- Anything that works as `claude`, `codex`, or another configured CLI in your
  normal terminal should work here.

## Not Goals

- Not a kanban board or a worktree manager. For that look at `claude-squad`,
  `vibe-kanban`, or `Crystal`.
- Not an alternative LLM client. It does not talk to APIs directly; it shells out
  to the CLIs you already use.
