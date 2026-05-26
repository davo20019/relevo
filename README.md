# relevo

[![CI](https://github.com/davo20019/relevo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/davo20019/relevo/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/relevo.svg)](https://www.npmjs.com/package/relevo)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A multi-agent coding workspace that sits in front of local coding-agent CLIs so
you can drive Claude Code, Codex, OpenCode, Cursor CLI, Antigravity (`agy`), and
similar tools from one terminal. Each agent's transcript is fed back to the
others as context, and you can fan a prompt out to several agents in parallel.

![Relevo usage demo](assets/relevo-demo.gif)

## Why

You finish a task with one agent, want another to review it, take the feedback
back to the first, and compare answers. Today that usually means juggling
terminals and copy-pasting context.

Relevo wraps the headless modes of the CLIs you already use (same logins, no
API keys). You route explicitly with `@mentions`, each agent runs in your
project directory, and turns are written under `.relay/` so the next agent gets
structured handoff context—not a pasted chat log. When you want the normal
interactive CLI, `/open <agent>` continues the native session in a new window.

```
> @claude @codex review the API design
> @cursor apply the safest changes from their feedback
> @claude re-review
> /open claude
```

> **One writer at a time.** Use multiple agents in parallel for review or
> exploration; chain writers serially (review first, then implement). Parallel
> writers on the same files will stomp each other — relevo dispatches and
> renders, but does not coordinate file access between CLIs.

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

## Automation defaults

Headless multi-agent dispatch cannot block on per-tool approval dialogs in each
pane. Built-in `agents.json` therefore uses each CLI's documented unattended
flags (`-p`, `exec`, `run`, and similar) so `@` mentions and parallel fan-out
keep moving. Tool permissions are effectively **pre-approved** on those paths;
you remain the operator—edit templates in `agents.json` if you want prompts
back.

| Agent | Unattended behavior (summary) |
|---|---|
| `claude` | Skips permission prompts (`--dangerously-skip-permissions`) |
| `codex` | Workspace-write sandbox; edits allowed in the project |
| `cursor` | Applies edits, sandbox off, MCPs approved (`--force`, `--trust`, `--approve-mcps`) |
| `opencode` | Non-interactive `run`; auto-approves permissions |
| `agy` | Skips permission prompts (`--dangerously-skip-permissions`) |
| `pi` | Headless `-p` only; no extra automation flags in relevo defaults |

Edit `~/.config/relevo/agents.json`, a project-local `./agents.json`, or
`RELEVO_CONFIG` to run agents in a more cautious mode. Per-flag notes and
revert examples are in [Default Agent Notes](#default-agent-notes).

## Vendor terms

Relevo shells out to each vendor's official CLI under your existing login —
it does not extract OAuth tokens or proxy API calls. You are responsible for
complying with each vendor's terms when you drive their CLI from Relevo.

- **Claude Code** ([terms](https://www.anthropic.com/legal/consumer-terms)) —
  Anthropic's docs explicitly bless headless/scripted use of the `claude`
  binary. Token-extracting wrappers (OpenClaw, Roo Code) were blocked in
  Jan 2026; shelling out to the official binary is the supported pattern.
- **Cursor CLI** ([terms](https://cursor.com/terms-of-service)) — no
  restrictions on automation or headless use. Don't resell the service or
  train a competing model on its output.
- **Codex** ([terms](https://openai.com/policies/terms-of-use/)) —
  `codex exec` is documented for non-interactive use. OpenAI has **not**
  explicitly confirmed third-party wrappers are permitted under a **ChatGPT
  subscription**
  ([discussion](https://github.com/openai/codex/discussions/8338)); using
  an OpenAI **API key** avoids that ambiguity.
- **Antigravity (`agy`)** ([terms](https://antigravity.google/terms)) —
  Google's terms forbid "third party software, tools, or services to access
  the Service," and they have suspended subscribers over OAuth-proxy tools.
  Relevo only shells out to the official `agy` binary, but Google's
  enforcement here has been aggressive; if you rely on Antigravity, weigh
  the risk and consider Vertex/AI Studio API-key auth.
- **pi** — MIT-licensed, no restrictions on wrapping.
- **opencode** — open source; check its own license.

## Quickstart

```bash
npx relevo
# or install globally
npm i -g relevo && relevo
```

First run creates `~/.config/relevo/agents.json` with six agents wired up:
`claude`, `codex`, `cursor`, `opencode`, `agy` (Antigravity), and `pi`. Those
defaults use the [automation flags above](#automation-defaults). Type `/help`
inside the REPL.

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
> !npm test
> @claude @local debug the failure
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
  saved prompt. Use `/default <agent>` to set a global default recipient so
  untagged prompts go there in every future session. Use `/default local <agent>`
  for a per-project override in `.relay/settings.json`.
- Other agents' turns are not prepended by default. Mention a peer agent in the
  prompt when you want handoff context, such as
  `@claude review @codex response`. For agents without native sessions, up to
  `context_turns` (default 3) of their own prior turns are still included.
- Each agent runs in your current working directory, exactly as if you had typed
  the CLI command directly. They share files in that directory.
- New task transcripts and native session ids live in a user-private Relevo
  application state directory, keyed by `.relay/project.json`. Project-local
  `.relay/` contains local identity and settings only; add it to your project's
  `.gitignore`. Deleting `.relay/project.json` disconnects this checkout from
  its existing state bucket, but it does not delete the user-private state
  directory. Override the state root with `RELEVO_STATE_HOME` if you need a
  custom location (e.g. for tests or shared sandboxes).
- **Upgrading from earlier versions:** existing `.relay/tasks/…` directories
  keep working in place via a legacy fallback, so no migration is required.
  Only newly created tasks land in the user-private state directory.
- Work is organized by task. Each relevo invocation starts fresh by default; a
  task is created lazily on your first prompt and auto-named from that prompt.
  Use `/resume` to pick up a previous task in this project.
  Legacy tasks created by older Relevo versions remain readable and continue
  writing their old Markdown transcripts after `/resume`.
- `/task list` shows tasks on disk. `/task rename <new>` renames the current
  task. `/resume` shows the 12 most recent tasks; older tasks remain on disk
  and can still be listed with `/task list`.
- Two terminals open in the same project no longer share a session by default.
  Use `/resume` in either terminal to opt into the other one's task.
- Claude, Codex, Cursor, and agy have native session support by default. They
  keep their own conversation memory across turns; transcript replay is the
  fallback for other agents.
- `!<command>` runs a local shell command in the project directory without
  invoking an agent. Each `!` is a one-shot `bash -lc`: state from `cd`,
  `export`, `source`, virtualenv activation, or backgrounded jobs does **not**
  persist into the next `!` call. Chain with `&&` when state needs to span
  (e.g. `!cd src && python script.py`), or open a real terminal for iterative
  shell work. Output is captured into the task transcript under `@local`, so a
  later prompt like `@claude @local debug the failure` gives the agent the
  exact command, exit code, and stderr. Press Esc to cancel a running local
  command (SIGTERM to the process group, then SIGKILL after 2s). Local
  commands can't run while an agent dispatch is in flight; cancel the dispatch
  first. Queued images from `/image` stay queued for the next agent dispatch
  — they are not attached to local commands. Captured stdout/stderr are each
  capped to the last 128 KiB in the transcript; live output streams in full.

## Task Workspace Model

One relevo terminal represents one task. Agents inside that terminal share the
same working directory and task transcripts. Use `@agent` mentions to route
prompts to one or more collaborators in that task.

Relevo keeps chronological scrollback as the source of truth. `/default` sets the
default recipient for untagged prompts (global and optional per-project); explicit
`@other` mentions still override for that line without changing the default.

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
| `/clear` | wipe transcripts and saved native sessions for the current task |
| `/reset` | same as `/clear` |
| `/task` | show the current task |
| `/task list` | list tasks |
| `/task new <name>` | create and switch to a task |
| `/task rename <new>` | rename the current task |
| `/resume` | list recent tasks; `/resume <n>` switches to one |
| `/open <agent>` | open a resumable native session in a new terminal window |
| `/default <agent>` | set global default recipient (all projects, future sessions) |
| `/default global <agent>` | same as `/default <agent>` |
| `/default local <agent>` | project override in `.relay/settings.json` |
| `/default session <agent>` | temporary override until quit |
| `/default` | show global, project, and active default |
| `/default clear [global\|local\|session]` | clear saved or session default |
| `/after @agent: <prompt>` | queue a prompt to fire after that agent's current/last run finishes (any terminal state); the dispatched prompt is prefixed with a structured handoff block describing the exact upstream turn (run id, files touched, response preview, full-turn file path) |
| `/cancel @<agent>` | cancel only that agent's active run(s); Esc still cancels every active run |
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
Dropped or pasted images that need a stable path are copied to Relevo's OS
cache directory and cleaned up on startup after 30 days.

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
      "cmd": "agent -p --force --model auto --output-format stream-json --sandbox disabled --trust --approve-mcps {prompt}",
      "init_template": "agent -p --force --model auto --output-format stream-json --sandbox disabled --trust --approve-mcps --resume {session_id} {prompt}",
      "resume_template": "agent -p --force --model auto --output-format stream-json --sandbox disabled --trust --approve-mcps --resume {session_id} {prompt}",
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
  "context_turns": 3,
  "context_compaction": {
    "enabled": true,
    "maxCharsPerBlock": 24000,
    "maxLineLength": 700
  }
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
  replayed when it has no active native session. Other agents contribute their
  latest turn only when they are explicitly mentioned in the prompt, such as
  `@claude compare this with @codex`.
- `context_compaction` trims oversized recent-activity blocks before they are
  injected into a future dispatch. Full transcripts remain unchanged on disk.

## Default Agent Notes

Per-agent detail for the [automation defaults](#automation-defaults) table:

- `claude --dangerously-skip-permissions`: bypasses Claude Code permission
  prompts for unattended runs.
- `codex -c sandbox_mode=workspace-write`: lets Codex edit the current project
  while keeping Codex's own sandboxing enabled. This form is used because it
  works for both fresh `codex exec` runs and `codex exec resume`.
- `agent -p --force --model auto --output-format stream-json --sandbox disabled --trust --approve-mcps`:
  Cursor's new CLI binary (replaces `cursor-agent`). Without `--force` it only
  proposes diffs; `--model auto` is required on free plans. `--sandbox disabled`,
  `--trust`, and `--approve-mcps` mirror the unattended automation of Claude/Codex
  defaults. `--output-format stream-json` plus the `cursor-json` parser keep output
  quiet. Native session continuity uses a pre-generated UUID via `--resume <id>`.
- `opencode run`: auto-approves permissions in non-interactive mode.
- `agy --dangerously-skip-permissions -p`: Antigravity's headless print mode with
  auto-approved tool permissions. Flags must come BEFORE `-p` since agy parses
  arguments after `-p` as the prompt body.

If you want an agent to stay cautious, edit its `cmd` to remove the automation
flag or switch Claude back to `--permission-mode acceptEdits`.

## Notes And Gotchas

- Native sessions are supported when the underlying CLI exposes a stable resume
  mechanism. Claude, Codex, Cursor, and agy are configured this way by default.
- Transcript replay is still used as the cross-agent coordination mechanism,
  but peer context is opt-in per prompt. Agents do not talk to each other
  directly.
- Parallel dispatch starts every selected agent from the same user prompt.
  Their outputs become available for later explicit handoff prompts, not for
  each other during the same fanout.
- Press `Ctrl+C` to clear whatever you have typed in the prompt. Press `Ctrl+C`
  twice within two seconds to quit (or use `/exit`).
- Press `Esc` to cancel a running dispatch or clear a queued prompt.
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

## Security

relevo is a **local orchestration layer**: it spawns coding-agent CLIs you
already trust and runs them in your project directory with the permissions those
CLIs grant. It does not call cloud APIs on its own.

- See [SECURITY.md](SECURITY.md) for how to report vulnerabilities, supported
  versions, and the threat model.
- Default `agents.json` templates use unattended automation flags (permission
  skips, sandbox-off, MCP auto-approval). See
  [Automation defaults](#automation-defaults) and tighten per-agent commands if
  you need a more cautious setup.

### Running in untrusted repositories

If you clone a repository you do not trust and run `relevo` from that
directory, a project-local `./agents.json` can override your user config and
define arbitrary commands for agent names. That is the same class of risk as
running `npm install` or `make` in an untrusted repo: only run relevo in
directories you trust, or point `RELEVO_CONFIG` at a config file you control.

Do not commit `.relay/` or relevo state directories; they can contain prompts,
transcripts, and session identifiers from your work.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for local
setup and testing. The project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

## Not Goals

- Not a kanban board or a worktree manager. For that look at `claude-squad`,
  `vibe-kanban`, or `Crystal`.
- Not an alternative LLM client. It does not talk to APIs directly; it shells out
  to the CLIs you already use.
