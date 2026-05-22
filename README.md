# relevo

A tiny REPL that sits in front of multiple coding-agent CLIs so you can drive
Claude Code, Codex, OpenCode, Cursor CLI, Antigravity (`agy`), and similar tools
from one terminal. Each agent's transcript is fed back to the others as context,
and you can fan a prompt out to several agents in parallel.

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

You log into each CLI normally once. This script just shells out, so your
existing auth is reused.

## Quickstart

```bash
# from a clone
npm install
npm run build
npm start

# or run from source during development
npm run dev
```

Once published you can also run it without cloning:

```bash
npx relevo
# or install globally
npm i -g relevo && relevo
```

First run creates `agents.json` with six agents wired up: `claude`, `codex`,
`cursor`, `opencode`, `agy` (Antigravity), and `pi`. Type `/help` inside the REPL.

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
- Recent transcript turns, default 3, are prepended as context. For agents
  without native sessions, this can include their own prior turns.
- Each agent runs in your current working directory, exactly as if you had typed
  the CLI command directly. They share files in that directory.
- Per-project state lives in `./.relay/`. Add it to your project's `.gitignore`.
- Work is organized by task. A repo can have many tasks, each isolated.
  - `.relay/tasks/<task>/transcripts/<agent>.md`: what each agent said in this task
  - `.relay/tasks/<task>/sessions.json`: native session IDs for resumable agents
  - `.relay/current`: which task is active
- `/task new <name>` starts a task. `/task switch <name>` changes tasks.
  `/task list` shows them all. `/task end` returns to the `default` task.
- For a clean review, start a fresh task first. Reusing `default` also reuses
  its existing transcript context.
- Claude, Codex, Cursor, and agy have native session support by default. They
  keep their own conversation memory across turns; transcript replay is the
  fallback for other agents.

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
| `/task switch <name>` | switch to an existing task |
| `/task end` | switch back to the default task |
| `/open <agent>` | open a resumable native session in a new terminal window |
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

Edit `agents.json` to change commands or add agents. The generated defaults look
like this:

```json
{
  "agents": {
    "claude": {
      "cmd": "claude -p --dangerously-skip-permissions {prompt}",
      "init_template": "claude -p --session-id {session_id} --dangerously-skip-permissions {prompt}",
      "resume_template": "claude -p --resume {session_id} --dangerously-skip-permissions {prompt}",
      "open_template": "claude --resume {session_id}",
      "pre_generate_id": "uuid"
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
- `context_turns` controls how many recent turns are injected when you call an
  agent. For agents without an active native session, this can include the target agent's own prior turns.

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
