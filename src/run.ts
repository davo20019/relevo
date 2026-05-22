import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { AgentSpec } from "./config.js";
import { PARSERS, parserRaw, renderRawFallback, type LineParser } from "./parsers.js";
import { loadSessions, saveSessionId } from "./sessions.js";
import { projectDir } from "./paths.js";
import { shlexSplit } from "./shlex.js";

export type AgentRunState = {
  agentName: string;
  color: string;
  start: number;
  end: number | null;
  displayChunks: string[];
  responseChunks: string[];
  nCommands: number;
  nEdits: number;
  running: boolean;
  finalStatus: string | null;
  cancelled: boolean;
  interrupted: boolean;
  liveMaxLines: number | null;
};

export function newRun(agentName: string, color: string, liveMaxLines: number | null = null): AgentRunState {
  return {
    agentName,
    color,
    start: Date.now(),
    end: null,
    displayChunks: [],
    responseChunks: [],
    nCommands: 0,
    nEdits: 0,
    running: true,
    finalStatus: null,
    cancelled: false,
    interrupted: false,
    liveMaxLines,
  };
}

export function setFinal(run: AgentRunState, status: string): void {
  run.running = false;
  run.finalStatus = status;
  if (run.end === null) run.end = Date.now();
}

export function elapsedSeconds(run: AgentRunState): number {
  const now = run.running || run.end === null ? Date.now() : run.end;
  return (now - run.start) / 1000;
}

export function activitySuffix(run: AgentRunState): string {
  const parts: string[] = [];
  if (run.nCommands) parts.push(`${run.nCommands} cmd${run.nCommands === 1 ? "" : "s"}`);
  if (run.nEdits) parts.push(`${run.nEdits} edit${run.nEdits === 1 ? "" : "s"}`);
  return parts.length ? " · " + parts.join(" · ") : "";
}

export function displayText(run: AgentRunState): string {
  const text = run.displayChunks.join("");
  if (!run.liveMaxLines || run.liveMaxLines <= 0) return text;
  const lines = text.split("\n");
  if (lines.length <= run.liveMaxLines) return text;
  return lines.slice(-run.liveMaxLines).join("\n");
}

export function hiddenLines(run: AgentRunState): number {
  if (!run.liveMaxLines || run.liveMaxLines <= 0) return 0;
  const lines = run.displayChunks.join("").split("\n");
  return Math.max(0, lines.length - run.liveMaxLines);
}

type PreparedCommand = {
  args: string[];
  viaStdin: boolean;
  parser: LineParser;
  preGen: boolean;
  sessionId: string | null;
  dirSnapshot: Set<string> | null;
};

function expandHome(p: string): string {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

export async function prepareCommand(
  agentName: string,
  spec: AgentSpec,
  prompt: string,
): Promise<PreparedCommand> {
  const parser = PARSERS[spec.parser ?? "raw"] ?? parserRaw;
  const sessions = loadSessions();
  let sessionId: string | null = sessions[agentName] ?? null;

  const preGen = Boolean(spec.pre_generate_id);
  const initTemplate = spec.init_template;
  const resumeTemplate = spec.resume_template;

  let cmdTemplate: string;
  if (preGen && !sessionId) {
    sessionId = randomUUID();
    await saveSessionId(agentName, sessionId);
    const chosen = initTemplate ?? resumeTemplate ?? spec.cmd;
    cmdTemplate = chosen.replace("{session_id}", sessionId);
  } else if (sessionId && resumeTemplate) {
    cmdTemplate = resumeTemplate.replace("{session_id}", sessionId);
  } else {
    cmdTemplate = spec.cmd;
  }

  const parts = shlexSplit(cmdTemplate);
  const viaStdin = !cmdTemplate.includes("{prompt}");
  const args = parts.map((p) => (p.includes("{prompt}") ? p.replaceAll("{prompt}", prompt) : p));

  let dirSnapshot: Set<string> | null = null;
  if (!sessionId && !preGen && spec.session_id_from_dir) {
    const snapDir = expandHome(spec.session_id_from_dir);
    if (existsSync(snapDir)) {
      dirSnapshot = new Set(readdirSync(snapDir));
    } else {
      dirSnapshot = new Set();
    }
  }

  return { args, viaStdin, parser, preGen, sessionId, dirSnapshot };
}

export async function captureDirSession(
  agentName: string,
  spec: AgentSpec,
  snapshot: Set<string> | null,
): Promise<void> {
  if (snapshot === null) return;
  const snapDir = expandHome(spec.session_id_from_dir!);
  if (!existsSync(snapDir)) return;
  const current = readdirSync(snapDir);
  const newOnes = current.filter((f) => !snapshot.has(f));
  if (newOnes.length === 0) return;
  newOnes.sort(
    (a, b) =>
      statSync(path.join(snapDir, b)).mtimeMs - statSync(path.join(snapDir, a)).mtimeMs,
  );
  const fname = newOnes[0]!;
  const ext = spec.session_id_strip_ext ?? "";
  const sid = ext && fname.endsWith(ext) ? fname.slice(0, -ext.length) : fname;
  await saveSessionId(agentName, sid);
}

export type SpawnResult =
  | { proc: ChildProcessWithoutNullStreams; error?: undefined }
  | { proc?: undefined; error: string };

export function spawnProc(args: string[], viaStdin: boolean, prompt: string): SpawnResult {
  if (args.length === 0) return { error: "empty command" };
  const [bin, ...rest] = args as [string, ...string[]];
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(bin, rest, {
      stdio: [viaStdin ? "pipe" : "ignore", "pipe", "pipe"],
      cwd: projectDir(),
    }) as ChildProcessWithoutNullStreams;
  } catch (e: any) {
    return { error: `command not found: ${bin}` };
  }
  proc.on("error", () => {
    // Surfaced later via close handler / spawn callback.
  });
  if (viaStdin && proc.stdin) {
    try {
      proc.stdin.end(prompt);
    } catch {
      // EPIPE — the child may have exited before we wrote. Best-effort.
    }
  }
  return { proc };
}

export type StreamOptions = {
  run: AgentRunState;
  proc: ChildProcessWithoutNullStreams;
  parser: LineParser;
  agentName: string;
  preGen: boolean;
  sessionId: string | null;
  verbose: boolean;
};

export type StreamResult = { exitCode: number; sessionInvalid: boolean };

// Patterns emitted by various CLIs when a --resume target no longer exists.
// Conservative on purpose — false positives would trigger an unnecessary retry.
const INVALID_SESSION_RE =
  /(no conversation found with session id|conversation not found|session (?:not found|does not exist|expired|is invalid)|no such session|unknown session)/i;

export function resetRunForRetry(run: AgentRunState, note: string): void {
  run.displayChunks = note ? [note] : [];
  run.responseChunks = [];
  run.nCommands = 0;
  run.nEdits = 0;
  run.running = true;
  run.finalStatus = null;
  run.end = null;
  run.cancelled = false;
  run.interrupted = false;
  run.start = Date.now();
}

// Stream stdout/stderr lines through the parser into run state. Resolves when
// the child closes. Sets the final status based on cancelled/interrupted/exit.
export async function streamToRun(opts: StreamOptions): Promise<StreamResult> {
  const { run, proc, parser, agentName, preGen, sessionId, verbose } = opts;
  let captured = sessionId;
  let sessionInvalid = false;
  const rawTail: string[] = [];

  // Merge stdout and stderr into a single line stream (matches subprocess.STDOUT=PIPE).
  const out = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  const err = createInterface({ input: proc.stderr!, crlfDelay: Infinity });

  const handleLine = async (line: string): Promise<void> => {
    const withLf = line + "\n";
    rawTail.push(withLf);
    if (rawTail.length > 40) rawTail.shift();
    if (!sessionInvalid && INVALID_SESSION_RE.test(line)) sessionInvalid = true;
    const { kind, payload } = parser(withLf);
    if (kind === "message" && payload) {
      run.displayChunks.push(payload);
      run.responseChunks.push(payload);
    } else if (kind === "command") {
      run.nCommands++;
      if (verbose) run.displayChunks.push(`\`$ ${payload}\`\n\n`);
    } else if (kind === "edit") {
      run.nEdits++;
      if (verbose) run.displayChunks.push(`\`+ edited ${payload}\`\n\n`);
    } else if (kind === "session_id" && !captured && !preGen && payload) {
      await saveSessionId(agentName, payload);
      captured = payload;
    }
  };

  out.on("line", (l) => void handleLine(l));
  err.on("line", (l) => void handleLine(l));

  const exitCode = await new Promise<number>((resolve) => {
    proc.on("close", (code) => {
      out.close();
      err.close();
      resolve(code ?? 0);
    });
  });

  if (run.cancelled) {
    setFinal(run, "cancelled");
  } else if (run.interrupted) {
    setFinal(run, "interrupted");
  } else if (exitCode === 0) {
    setFinal(run, "done");
  } else {
    if (!run.displayChunks.join("").trim() && rawTail.length) {
      let rendered = renderRawFallback(rawTail).trim();
      if (!rendered) rendered = rawTail.join("").trim();
      if (rendered.length > 4000) {
        rendered = "... earlier output truncated ...\n" + rendered.slice(-4000);
      }
      if (rendered) {
        const diagnostic =
          `process exited with code ${exitCode} with no parsed output.\n\n${rendered}\n`;
        run.displayChunks.push(diagnostic);
        run.responseChunks.push(diagnostic);
      }
    }
    setFinal(run, `exit ${exitCode}`);
  }
  return { exitCode, sessionInvalid };
}

export function cancelRuns(runs: AgentRunState[], procs: ChildProcessWithoutNullStreams[]): void {
  for (const r of runs) r.cancelled = true;
  for (const p of procs) {
    try {
      p.kill("SIGTERM");
    } catch {
      // process may have already exited
    }
  }
}
