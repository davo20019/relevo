import { spawn } from "node:child_process";
import { projectDir } from "./paths.js";

export type LocalCommandResult = {
  command: string;
  cwd: string;
  shell: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  cancelled: boolean;
};

export type LocalCommandStream = {
  stdout?: (chunk: string) => void;
  stderr?: (chunk: string) => void;
};

export type LocalCommandOptions = {
  signal?: AbortSignal;
  // ms to wait between SIGTERM and SIGKILL when the signal aborts.
  killGraceMs?: number;
};

export function shellForLocalCommand(): string {
  return process.env.SHELL || "bash";
}

const CAPTURE_LIMIT_BYTES = 128 * 1024;

type Capture = { text: string; bytes: number; truncated: boolean };

function appendCaptured(capture: Capture, chunk: string): Capture {
  const chunkBytes = Buffer.byteLength(chunk, "utf8");
  const combined = capture.text + chunk;
  const combinedBytes = capture.bytes + chunkBytes;
  if (combinedBytes <= CAPTURE_LIMIT_BYTES) {
    return { text: combined, bytes: combinedBytes, truncated: capture.truncated };
  }
  const buf = Buffer.from(combined, "utf8");
  return {
    text: buf.subarray(Math.max(0, buf.length - CAPTURE_LIMIT_BYTES)).toString("utf8"),
    bytes: CAPTURE_LIMIT_BYTES,
    truncated: true,
  };
}

export function runLocalCommand(
  command: string,
  stream: LocalCommandStream = {},
  options: LocalCommandOptions = {},
): Promise<LocalCommandResult> {
  const cwd = projectDir();
  const shell = shellForLocalCommand();
  const start = Date.now();
  const child = spawn(shell, ["-lc", command], {
    cwd,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout: Capture = { text: "", bytes: 0, truncated: false };
  let stderr: Capture = { text: "", bytes: 0, truncated: false };
  let cancelled = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    stdout = appendCaptured(stdout, chunk);
    stream.stdout?.(chunk);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = appendCaptured(stderr, chunk);
    stream.stderr?.(chunk);
  });

  const grace = options.killGraceMs ?? 2000;
  let killTimer: NodeJS.Timeout | null = null;
  const killChildTree = (signal: NodeJS.Signals): void => {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to the shell process if process-group signalling fails.
      }
    }
    child.kill(signal);
  };
  const onAbort = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    cancelled = true;
    killChildTree("SIGTERM");
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) killChildTree("SIGKILL");
    }, grace);
  };

  if (options.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  return new Promise((resolve, reject) => {
    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        command,
        cwd,
        shell,
        exitCode: code ?? (signal ? 128 : 1),
        signal,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Date.now() - start,
        cancelled,
      });
    });
  });
}
