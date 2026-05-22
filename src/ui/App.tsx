import { Box, Static, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AGENT_COLORS,
  agentIsEnabled,
  availableAgentNames,
  loadConfig,
  saveConfig,
  SLASH_COMMANDS,
  unavailableAgentReasons,
  type AgentConfig,
  type AgentSpec,
} from "../config.js";
import { buildContext } from "../context.js";
import { buildHelpText } from "../help.js";
import { extractImagePaths, formatPromptWithImages, IMAGE_EXTS, pasteClipboardImage } from "../images.js";
import { openInNewTerminal } from "../openWindow.js";
import {
  currentTask,
  ensureTask,
  listTasks,
  projectDir,
  setCurrentTask,
  transcriptDir,
} from "../paths.js";
import { clearAgentSession, clearSessions, loadSessions } from "../sessions.js";
import { appendTurn, readLastTurns } from "../transcripts.js";
import { existsSync, readdirSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ALL_TOKEN,
  expandAll,
  parseLine,
  parseMulti,
  prepareDispatchLine,
} from "../routing.js";
import {
  newRun,
  prepareCommand,
  resetRunForRetry,
  spawnProc,
  streamToRun,
  cancelRuns,
  captureDirSession,
  type AgentRunState,
} from "../run.js";
import { BottomToolbar } from "./BottomToolbar.js";
import { MultilineInput } from "./MultilineInput.js";
import { PanelRow } from "./PanelRow.js";
import { Separator } from "./Separator.js";
import { UserPrompt } from "./UserPrompt.js";

function formatClockLabel(turn: { at: Date; task: string }): string {
  const hh = String(turn.at.getHours()).padStart(2, "0");
  const mm = String(turn.at.getMinutes()).padStart(2, "0");
  const ss = String(turn.at.getSeconds()).padStart(2, "0");
  // Include the task name on double separators implicitly through the heavier
  // rule; the timestamp alone is enough text in the rule.
  return `${hh}:${mm}:${ss}  ·  ${turn.task}`;
}

type LogLine = { id: string; text: string; color?: string };
type CompletedTurn = {
  id: string;
  prompt: string;
  runs: AgentRunState[];
  task: string;
  at: Date;
};
type HistoryItem =
  | { kind: "log"; line: LogLine }
  | { kind: "turn"; turn: CompletedTurn };

let HIST_SEQ = 0;
const nextId = () => `h${++HIST_SEQ}`;

export function App({ initialConfig }: { initialConfig: AgentConfig }) {
  const { exit } = useApp();
  const [config, setConfig] = useState<AgentConfig>(initialConfig);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [activeRuns, setActiveRuns] = useState<AgentRunState[]>([]);
  const [activePromptText, setActivePromptText] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  const sessionStateRef = useRef({
    lastAgent: null as string | null,
    lastStatus: null as string | null,
    lastElapsed: 0,
    verbose: false,
    pendingImages: [] as string[],
    pendingPrompt: null as string | null,
  });
  const activeProcsRef = useRef<Array<ReturnType<typeof spawnProc>>>([]);

  const agents = useMemo(() => Object.keys(config.agents), [config]);
  const agentColor = useMemo(() => {
    const m: Record<string, string> = {};
    agents.forEach((n, i) => (m[n] = AGENT_COLORS[i % AGENT_COLORS.length]!));
    return m;
  }, [agents]);

  useEffect(() => {
    if (activeRuns.length === 0) return;
    const id = setInterval(() => setTick((t) => t + 1), 100);
    return () => clearInterval(id);
  }, [activeRuns.length]);

  useInput((_input, key) => {
    if (key.escape && activeRuns.length > 0) {
      const procs = activeProcsRef.current
        .map((r) => (r && "proc" in r ? r.proc : null))
        .filter((p): p is NonNullable<typeof p> => Boolean(p));
      cancelRuns(activeRuns, procs);
    }
  });

  const log = useCallback((text: string, color?: string) => {
    setHistory((h) => [...h, { kind: "log", line: { id: nextId(), text, color } }]);
  }, []);

  const dispatchSingle = useCallback(
    async (agentName: string, spec: AgentSpec, userPrompt: string, fullPrompt: string) => {
      const run = newRun(agentName, agentColor[agentName] ?? "cyan");
      setActiveRuns([run]);
      setActivePromptText(userPrompt);
      const prep = await prepareCommand(agentName, spec, fullPrompt);
      const spawned = spawnProc(prep.args, prep.viaStdin, fullPrompt);
      if (spawned.error) {
        log(spawned.error, "red");
        setActiveRuns([]);
        setActivePromptText(null);
        return null;
      }
      const proc = spawned.proc!;
      activeProcsRef.current = [spawned];
      let activePrep = prep;
      try {
        const result = await streamToRun({
          run,
          proc,
          parser: prep.parser,
          agentName,
          preGen: prep.preGen,
          sessionId: prep.sessionId,
          verbose: sessionStateRef.current.verbose,
        });
        const recoverable =
          result.sessionInvalid &&
          result.exitCode !== 0 &&
          !run.cancelled &&
          !run.interrupted &&
          Boolean(spec.resume_template);
        if (recoverable) {
          await clearAgentSession(agentName);
          const retryPrep = await prepareCommand(agentName, spec, fullPrompt);
          const retrySpawned = spawnProc(retryPrep.args, retryPrep.viaStdin, fullPrompt);
          if (retrySpawned.error) {
            log(`@${agentName} session expired and retry failed: ${retrySpawned.error}`, "red");
          } else {
            log(`@${agentName} ↻ session expired, retrying with a fresh session`, "yellow");
            resetRunForRetry(run, "");
            activeProcsRef.current = [retrySpawned];
            activePrep = retryPrep;
            await streamToRun({
              run,
              proc: retrySpawned.proc!,
              parser: retryPrep.parser,
              agentName,
              preGen: retryPrep.preGen,
              sessionId: retryPrep.sessionId,
              verbose: sessionStateRef.current.verbose,
            });
          }
        }
      } finally {
        activeProcsRef.current = [];
      }
      if (!run.cancelled && !run.interrupted && run.finalStatus === "done") {
        await captureDirSession(agentName, spec, activePrep.dirSnapshot);
      }
      sessionStateRef.current.lastAgent = agentName;
      sessionStateRef.current.lastElapsed = (run.end! - run.start) / 1000;
      sessionStateRef.current.lastStatus =
        run.cancelled ? "cancelled" : run.interrupted ? "interrupted" : run.finalStatus ?? "?";

      const completed: CompletedTurn = {
        id: nextId(),
        prompt: userPrompt,
        runs: [run],
        task: currentTask(),
        at: new Date(),
      };
      setHistory((h) => [...h, { kind: "turn", turn: completed }]);
      setActiveRuns([]);
      setActivePromptText(null);
      if (run.cancelled || run.interrupted) return null;
      return run.responseChunks.join("");
    },
    [agentColor, log],
  );

  const dispatchParallel = useCallback(
    async (
      agentNames: string[],
      userPrompt: string,
      perAgentFullPrompts: Record<string, string>,
    ) => {
      // Live preview height scales with terminal rows so tall windows show
      // more context per panel. Capped at 24 so very tall screens don't make
      // a single dispatch eat the whole transcript area.
      const rows = process.stdout.rows ?? 30;
      const liveMax = Math.max(8, Math.min(24, Math.floor(rows / 3)));
      const runs = agentNames.map((n) => newRun(n, agentColor[n] ?? "cyan", liveMax));
      setActiveRuns(runs);
      setActivePromptText(userPrompt);

      const prepared = await Promise.all(
        agentNames.map(async (name, i) => {
          const spec = config.agents[name]!;
          const fullPrompt = perAgentFullPrompts[name]!;
          const prep = await prepareCommand(name, spec, fullPrompt);
          const spawned = spawnProc(prep.args, prep.viaStdin, fullPrompt);
          return { name, spec, prep, spawned, run: runs[i]! };
        }),
      );

      activeProcsRef.current = prepared.map((p) => p.spawned);

      await Promise.all(
        prepared.map(async (p, i) => {
          if (p.spawned.error) {
            p.run.running = false;
            p.run.finalStatus = p.spawned.error;
            p.run.end = Date.now();
            return;
          }
          const result = await streamToRun({
            run: p.run,
            proc: p.spawned.proc!,
            parser: p.prep.parser,
            agentName: p.name,
            preGen: p.prep.preGen,
            sessionId: p.prep.sessionId,
            verbose: sessionStateRef.current.verbose,
          });
          const recoverable =
            result.sessionInvalid &&
            result.exitCode !== 0 &&
            !p.run.cancelled &&
            !p.run.interrupted &&
            Boolean(p.spec.resume_template);
          if (!recoverable) return;
          const fullPrompt = perAgentFullPrompts[p.name]!;
          await clearAgentSession(p.name);
          const retryPrep = await prepareCommand(p.name, p.spec, fullPrompt);
          const retrySpawned = spawnProc(retryPrep.args, retryPrep.viaStdin, fullPrompt);
          if (retrySpawned.error) {
            log(`@${p.name} session expired and retry failed: ${retrySpawned.error}`, "red");
            return;
          }
          log(`@${p.name} ↻ session expired, retrying with a fresh session`, "yellow");
          resetRunForRetry(p.run, "");
          p.spawned = retrySpawned;
          p.prep = retryPrep;
          activeProcsRef.current[i] = retrySpawned;
          await streamToRun({
            run: p.run,
            proc: retrySpawned.proc!,
            parser: retryPrep.parser,
            agentName: p.name,
            preGen: retryPrep.preGen,
            sessionId: retryPrep.sessionId,
            verbose: sessionStateRef.current.verbose,
          });
        }),
      );

      // Uncap structured parsers (codex-json, cursor-json, raw with a clean
      // CLI) so their final answer renders fully. Keep the live-preview cap
      // on for noisy plain-text parsers (agy-text) so the panel doesn't
      // expand to dump the full intermediate transcript when the run ends.
      for (const p of prepared) {
        if (p.spec.parser !== "agy-text") p.run.liveMaxLines = null;
      }
      activeProcsRef.current = [];

      for (const p of prepared) {
        if (
          !p.spawned.error &&
          !p.run.cancelled &&
          !p.run.interrupted &&
          p.run.finalStatus === "done"
        ) {
          await captureDirSession(p.name, p.spec, p.prep.dirSnapshot);
        }
      }

      const elapsedMax = Math.max(...runs.map((r) => (r.end! - r.start) / 1000), 0);
      const okCount = prepared.filter(
        (p) =>
          !p.spawned.error &&
          !p.run.cancelled &&
          !p.run.interrupted &&
          p.run.finalStatus === "done",
      ).length;
      sessionStateRef.current.lastAgent = agentNames.join("+");
      sessionStateRef.current.lastElapsed = elapsedMax;
      sessionStateRef.current.lastStatus =
        okCount === prepared.length ? `✓×${okCount}` : `${okCount}/${prepared.length} ok`;

      const completed: CompletedTurn = {
        id: nextId(),
        prompt: userPrompt,
        runs,
        task: currentTask(),
        at: new Date(),
      };
      setHistory((h) => [...h, { kind: "turn", turn: completed }]);
      setActiveRuns([]);
      setActivePromptText(null);

      for (const p of prepared) {
        if (!p.spawned.error && !p.run.cancelled && !p.run.interrupted) {
          await appendTurn(p.name, userPrompt, p.run.responseChunks.join(""));
        }
      }

      // One dim hint line for every agent in this fanout that completed cleanly
      // AND has an open_template (i.e. is actually resumable). Mirrors the
      // single-agent hint shape so the affordance discovery is consistent.
      const openable = prepared
        .filter(
          (p) =>
            !p.spawned.error &&
            !p.run.cancelled &&
            !p.run.interrupted &&
            p.run.finalStatus === "done" &&
            Boolean(p.spec.open_template),
        )
        .map((p) => `/open ${p.name}`);
      if (openable.length > 0) {
        log(`continue any session:  ${openable.join("  ·  ")}`);
      }
    },
    [agentColor, config.agents, log],
  );

  const handleSlash = useCallback(
    async (cmd: string): Promise<boolean> => {
      const trimmed = cmd.trim();
      if (trimmed === "/exit" || trimmed === "/quit" || trimmed === "/q") return false;
      if (trimmed === "/help" || trimmed === "/h" || trimmed === "/?") {
        log(buildHelpText(config));
        return true;
      }
      if (trimmed === "/verbose" || trimmed === "/v") {
        sessionStateRef.current.verbose = !sessionStateRef.current.verbose;
        log(`verbose mode: ${sessionStateRef.current.verbose ? "on" : "off"}`);
        return true;
      }
      if (trimmed === "/quiet") {
        sessionStateRef.current.verbose = false;
        log("verbose mode: off");
        return true;
      }
      if (trimmed === "/agents" || trimmed.startsWith("/agents ")) {
        await handleAgentsCommand(trimmed);
        return true;
      }
      if (trimmed.startsWith("/last")) {
        const parts = trimmed.split(/\s+/, 2);
        if (parts.length === 2) {
          const name = parts[1]!.replace(/^@/, "");
          const recent = readLastTurns(name, 1);
          log(recent.trim() ? recent : `no transcript yet for @${name}`);
        } else log("usage: /last <agent>");
        return true;
      }
      if (trimmed.startsWith("/tail")) {
        const parts = trimmed.split(/\s+/);
        if (parts.length >= 2) {
          const name = parts[1]!.replace(/^@/, "");
          const n = parts[2] ? parseInt(parts[2], 10) || 1 : 1;
          const recent = readLastTurns(name, n);
          log(recent.trim() ? recent : `no transcript yet for @${name}`);
        } else log("usage: /tail <agent> [n]");
        return true;
      }
      if (trimmed === "/clear") {
        const dir = transcriptDir();
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".md")) unlinkSync(path.join(dir, f));
          }
        }
        log(`cleared transcripts for task ${currentTask()}`);
        return true;
      }
      if (trimmed === "/reset") {
        const dir = transcriptDir();
        if (existsSync(dir)) {
          for (const f of readdirSync(dir)) {
            if (f.endsWith(".md")) unlinkSync(path.join(dir, f));
          }
        }
        clearSessions();
        log(`reset task ${currentTask()}: transcripts and sessions cleared`);
        return true;
      }
      if (trimmed.startsWith("/task")) {
        await handleTaskCommand(trimmed);
        return true;
      }
      if (trimmed === "/cwd" || trimmed === "/pwd" || trimmed === "/workspace") {
        log(`  ${projectDir()}`);
        return true;
      }
      if (trimmed.startsWith("/open")) {
        const rest = trimmed.replace(/^\/open\s*/, "");
        await handleOpenCommand(rest);
        return true;
      }
      if (trimmed.startsWith("/image")) {
        await handleImageCommand(trimmed);
        return true;
      }
      log(`unknown command: ${trimmed} (try /help)`, "red");
      return true;

      async function handleAgentsCommand(cmd: string) {
        const parts = cmd.split(/\s+/);
        if (parts.length === 1) {
          const unavail = unavailableAgentReasons(config.agents);
          const out: string[] = [];
          for (const [name, spec] of Object.entries(config.agents)) {
            const reason = unavail[name];
            const status =
              reason === "disabled"
                ? "disabled"
                : reason
                  ? `unavailable (${reason})`
                  : "available";
            out.push(`  @${name}  ${status} · ${spec.cmd}`);
          }
          log(out.join("\n"));
          return;
        }
        if (parts.length !== 3 || (parts[1] !== "enable" && parts[1] !== "disable")) {
          log("usage: /agents | /agents enable <agent> | /agents disable <agent>");
          return;
        }
        const action = parts[1]!;
        const name = parts[2]!.replace(/^@/, "");
        const spec = config.agents[name];
        if (!spec) {
          log(`unknown agent: @${name} (try /agents)`, "red");
          return;
        }
        spec.enabled = action === "enable";
        saveConfig(config);
        setConfig({ ...config });
        log(`@${name} ${spec.enabled ? "enabled" : "disabled"}`);
      }

      async function handleTaskCommand(cmd: string) {
        const parts = cmd.split(/\s+/, 3);
        if (parts.length === 1) {
          log(`  current task: ${currentTask()}`);
          return;
        }
        const sub = parts[1]!;
        if (sub === "list") {
          await ensureTask();
          const tasks = listTasks();
          const cur = currentTask();
          const lines = (tasks.length ? tasks : [cur]).map((t) =>
            t === cur ? `* ${t}` : `  ${t}`,
          );
          log(lines.join("\n"));
          return;
        }
        if (sub === "new") {
          if (parts.length < 3) {
            log("usage: /task new <name>");
            return;
          }
          const name = parts[2]!.trim().replace(/\s+/g, "-");
          await ensureTask(name);
          await setCurrentTask(name);
          log(`created and switched to task: ${name}`);
          return;
        }
        if (sub === "switch") {
          if (parts.length < 3) {
            log("usage: /task switch <name>");
            return;
          }
          const name = parts[2]!.trim();
          if (!listTasks().includes(name)) {
            log(`no such task: ${name} (use /task new ${name} to create)`, "red");
            return;
          }
          await setCurrentTask(name);
          log(`switched to task: ${name}`);
          return;
        }
        if (sub === "end") {
          const cur = currentTask();
          if (cur !== "default") {
            await setCurrentTask("default");
            await ensureTask("default");
            log(`ended task ${cur}, back to default`);
          } else log("already on default task");
          return;
        }
        log(`unknown /task subcommand: ${sub}`);
      }

      async function handleOpenCommand(rest: string) {
        const name = rest.replace(/^@/, "").trim();
        if (!name) return log("usage: /open <agent>");
        const spec = config.agents[name];
        if (!spec) return log(`unknown agent: @${name} (try /agents)`, "red");
        const tmpl = spec.open_template;
        if (!tmpl)
          return log(
            `@${name} has no open_template configured (only agents with native session support can be opened in a new window)`,
          );
        const sid = loadSessions()[name];
        if (!sid)
          return log(
            `no session yet for @${name} in task '${currentTask()}'. run @${name} at least once first.`,
            "yellow",
          );
        const cmdToRun = tmpl.replace("{session_id}", sid);
        const { ok, error } = await openInNewTerminal(cmdToRun, projectDir());
        if (ok)
          log(
            `opened @${name} in a new Terminal window (session ${sid.slice(0, 8)}...); relevo still tracks this session; avoid using both at once`,
          );
        else log(`could not open new window: ${error}`, "red");
      }

      async function handleImageCommand(cmd: string) {
        const m = /^\/image\s*(.*)$/.exec(cmd);
        const rest = (m?.[1] ?? "").trim();
        const state = sessionStateRef.current;

        if (!rest || rest === "list") {
          if (state.pendingImages.length === 0) {
            log("no images queued. /image <path> or /image paste to add.");
          } else {
            log(
              `${state.pendingImages.length} queued for next dispatch:\n` +
                state.pendingImages.map((p) => "  " + p).join("\n"),
            );
          }
          return;
        }
        if (rest === "clear") {
          const n = state.pendingImages.length;
          state.pendingImages = [];
          log(`cleared ${n} pending image(s)`);
          return;
        }
        if (rest === "paste") {
          const { path: p, error } = await pasteClipboardImage();
          if (error) return log(error, "red");
          state.pendingImages.push(p!);
          log(`queued from clipboard: ${p}`);
          return;
        }
        const tokens = rest
          .split(/\s+/)
          .map((t) => t.replace(/^"|"$/g, "").replace(/^'|'$/g, ""));
        let added = 0;
        for (const tok of tokens) {
          const resolved = tok.startsWith("~")
            ? path.join(os.homedir(), tok.slice(1))
            : tok;
          if (!existsSync(resolved) || !statSync(resolved).isFile()) {
            log(`not a file: ${tok}`, "red");
            continue;
          }
          if (!IMAGE_EXTS.has(path.extname(resolved).toLowerCase())) {
            log(`warning: ${path.extname(resolved)} is not a recognized image extension; queuing anyway`, "yellow");
          }
          const abs = path.resolve(resolved);
          state.pendingImages.push(abs);
          added++;
          log(`queued: ${abs}`);
        }
        if (added === 0 && tokens.length)
          log("usage: /image <path> | /image paste | /image list | /image clear");
      }
    },
    [config, log],
  );

  const handleSubmit = useCallback(
    async (line: string) => {
      setInput("");
      if (!line.trim()) return;
      setBusy(true);
      try {
        let expanded = line;
        if (ALL_TOKEN.test(line.trimStart())) {
          const available = availableAgentNames(config.agents);
          const unavail = unavailableAgentReasons(config.agents);
          const skipped = agents.filter((n) => unavail[n]);
          if (skipped.length) {
            // Render as an aligned column block, one agent per line. Easier
            // to scan than a comma-joined run-on sentence.
            const nameWidth = Math.max(...skipped.map((n) => n.length + 1));
            const rows = skipped
              .map((n) => `   @${n.padEnd(nameWidth)}  ${unavail[n]}`)
              .join("\n");
            log(`@all skipped:\n${rows}`);
          }
          if (available.length === 0) {
            log("no available CLI agents for @all", "yellow");
            return;
          }
          expanded = expandAll(line, available);
        } else {
          expanded = expandAll(line, agents);
        }

        const state = sessionStateRef.current;

        const multi = parseMulti(expanded, agents);
        if (multi && multi.body) {
          const { images: extracted, cleaned } = extractImagePaths(multi.body);
          const allImages = [...state.pendingImages, ...extracted];
          const userPrompt = formatPromptWithImages(cleaned, allImages);
          if (allImages.length) {
            log(
              `attaching ${allImages.length} image(s) to ${multi.agents.map((a) => "@" + a).join(", ")}`,
            );
          }
          const perAgent: Record<string, string> = {};
          for (const name of multi.agents) {
            const ctx = buildContext(name, config.agents, config.context_turns ?? 3);
            perAgent[name] = ctx ? ctx + userPrompt : userPrompt;
          }
          await dispatchParallel(multi.agents, userPrompt, perAgent);
          state.pendingImages = [];
          return;
        }
        if (multi && !multi.body) {
          log("multi-dispatch needs a prompt after the agent list");
          return;
        }

        const routingState = {
          get pendingPrompt() {
            return state.pendingPrompt;
          },
          set pendingPrompt(v: string | null) {
            state.pendingPrompt = v;
          },
        };
        const routed = prepareDispatchLine(expanded, agents, routingState);
        if (routed === null) {
          const choices = agents.map((n) => "@" + n).join(" ");
          const suffix = state.pendingPrompt ? " Type one of those tags to send it." : "";
          log(`no agent tagged. Pick one: ${choices}.${suffix}`, "yellow");
          return;
        }
        const parsed = parseLine(routed);
        if (parsed.kind === "empty") return;
        if (parsed.kind === "command") {
          const keep = await handleSlash(parsed.content);
          if (!keep) exit();
          return;
        }
        if (parsed.kind === "untagged") {
          const choices = agents.map((n) => "@" + n).join(" ");
          log(`no agent tagged. Pick one: ${choices}.`, "yellow");
          return;
        }
        const agent = parsed.agent;
        if (!config.agents[agent]) {
          log(`unknown agent: @${agent} (try /agents)`, "red");
          return;
        }
        if (!agentIsEnabled(config.agents[agent]!)) {
          log(`@${agent} is disabled. Run /agents enable ${agent} to use it.`, "yellow");
          return;
        }
        // If the user wrote other known @<agent> mentions in the prompt body
        // but they didn't shape it as multi-dispatch ("@a @b hi" / "@a and @b hi"),
        // surface a one-line hint so the silent single-dispatch isn't mistaken
        // for a parallel one. Catches things like
        //   "@claude please ask @codex about X"  →  routes to claude only.
        const otherMentions = new Set<string>();
        for (const m of parsed.content.matchAll(/@([A-Za-z0-9_\-]+)/g)) {
          const n = m[1]!;
          if (n !== agent && config.agents[n]) otherMentions.add(n);
        }
        if (otherMentions.size > 0) {
          const others = [...otherMentions].map((n) => `@${n}`).join(", ");
          log(
            `routing to @${agent}. ${others} also mentioned — use ` +
              `@${agent} ${[...otherMentions].map((n) => `@${n}`).join(" ")} <prompt> for parallel dispatch.`,
          );
        }
        const { images: extracted, cleaned } = extractImagePaths(parsed.content);
        const allImages = [...state.pendingImages, ...extracted];
        if (!cleaned.trim() && allImages.length === 0) {
          log("empty prompt");
          return;
        }
        const userPrompt = formatPromptWithImages(cleaned, allImages);
        if (allImages.length) log(`attaching ${allImages.length} image(s) to @${agent}`);

        const ctx = buildContext(agent, config.agents, config.context_turns ?? 3);
        const fullPrompt = ctx ? ctx + userPrompt : userPrompt;
        const response = await dispatchSingle(agent, config.agents[agent]!, userPrompt, fullPrompt);
        state.pendingImages = [];
        if (response !== null) {
          await appendTurn(agent, userPrompt, response);
          const spec = config.agents[agent]!;
          if (spec.open_template && sessionStateRef.current.lastStatus === "done") {
            log(`/open ${agent} to continue this session in a new Terminal window`);
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [agents, config, dispatchParallel, dispatchSingle, exit, handleSlash, log],
  );

  const toolbarState = {
    lastAgent: sessionStateRef.current.lastAgent,
    lastStatus: sessionStateRef.current.lastStatus,
    lastElapsed: sessionStateRef.current.lastElapsed,
    verbose: sessionStateRef.current.verbose,
    agentCount: agents.length,
  };

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(item, index) => {
          if (item.kind === "log") {
            return (
              <Text key={item.line.id} color={item.line.color}>
                {item.line.text}
              </Text>
            );
          }
          // Determine if a separator belongs above this turn — and how heavy.
          // None for the very first turn ever, single `─` between turns in the
          // same task, double `═` when the task changed.
          let prevTurn: CompletedTurn | null = null;
          for (let i = index - 1; i >= 0; i--) {
            const it = history[i];
            if (it && it.kind === "turn") {
              prevTurn = it.turn;
              break;
            }
          }
          const sepKind: "none" | "single" | "double" = !prevTurn
            ? "none"
            : prevTurn.task !== item.turn.task
              ? "double"
              : "single";
          const label = formatClockLabel(item.turn);
          return (
            <Box key={item.turn.id} flexDirection="column">
              {sepKind !== "none" && <Separator kind={sepKind} label={label} />}
              <UserPrompt prompt={item.turn.prompt} />
              <PanelRow runs={item.turn.runs} tick={0} keyPrefix={item.turn.id} />
            </Box>
          );
        }}
      </Static>
      {activePromptText !== null && <UserPrompt prompt={activePromptText} />}
      <PanelRow runs={activeRuns} tick={tick} keyPrefix="live" />
      <MultilineInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={busy}
        slashCommands={SLASH_COMMANDS}
        agents={agents}
      />
      <BottomToolbar state={toolbarState} />
    </Box>
  );
}
