/*
 * No exports. Worker-thread side of GitProcessHost: spawns git, relays its output, and kills it on request, so process
 * creation (synchronous CreateProcess on Windows) never runs on the daemon event loop. Children finish from their exit
 * once their output goes quiet, since another process can inherit a pipe handle and hold it open indefinitely.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { parentPort } from "node:worker_threads";
import type { GitProcessEnvironmentDelta, GitProcessWorkerRequest, GitProcessWorkerEvent } from "./GitProcessHost";

const port = parentPort;
if (!port) throw new Error("git-process-worker must run inside a worker thread.");

const children = new Map<number, ChildProcessWithoutNullStreams>();

/** Quiet time after exit before stdio counts as drained; the dead writer's remaining output is already in the pipe. */
const EXITED_PIPE_QUIET_MS = 1_000;

/**
 * `close` waits for stdio EOF, which never comes while a process spawned concurrently on another thread holds an
 * inherited pipe handle. Ending the streams after a quiet exit lets `close` fire with the real exit code.
 */
function settleAfterExit(child: ChildProcessWithoutNullStreams, args: readonly string[]) {
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      console.warn(`[git-process-worker] git ${args.join(" ").slice(0, 200)} exited but its output pipes stayed open (another process holds them); finishing from its exit.`);
      child.stdout.destroy();
      child.stderr.destroy();
    }, EXITED_PIPE_QUIET_MS);
  };
  child.once("exit", () => {
    arm();
    child.stdout.on("data", arm);
    child.stderr.on("data", arm);
  });
  child.once("close", () => clearTimeout(timer));
}

function post(event: GitProcessWorkerEvent, transfer: ArrayBuffer[] = []) {
  port!.postMessage(event, transfer);
}

function bytes(chunk: Buffer) {
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy;
}

function environment(delta: GitProcessEnvironmentDelta) {
  const keys = Object.keys(delta);
  if (!keys.length) return process.env;
  const env = { ...process.env };
  for (const key of keys) {
    const value = delta[key];
    if (value === null || value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

function start(request: Extract<GitProcessWorkerRequest, { kind: "run" | "open" }>) {
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn("git", request.args, {
      cwd: request.cwd, env: environment(request.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
  } catch (error) {
    post({ kind: "spawnError", id: request.id, message: error instanceof Error ? error.message : String(error) });
    return;
  }
  children.set(request.id, child);
  settleAfterExit(child, request.args);
  if (request.kind === "run") {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > request.maxBuffer) {
        overflow = true;
        child.kill();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr.push(chunk); });
    child.once("error", error => {
      children.delete(request.id);
      post({ kind: "spawnError", id: request.id, message: error.message });
    });
    child.once("close", (code, signal) => {
      if (!children.delete(request.id)) return;
      const out = bytes(Buffer.concat(stdout));
      post({
        kind: "result", id: request.id, code, signal, overflow,
        stdout: out, stderr: Buffer.concat(stderr).toString("utf8"),
      }, [out.buffer as ArrayBuffer]);
    });
    child.stdin.on("error", () => { /* An early-exiting git closes stdin; its exit code reports the failure. */ });
    child.stdin.end(request.input ?? undefined);
    return;
  }
  child.stdout.on("data", (chunk: Buffer) => {
    const data = bytes(chunk);
    post({ kind: "stdout", id: request.id, data }, [data.buffer as ArrayBuffer]);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const data = bytes(chunk);
    post({ kind: "stderr", id: request.id, data }, [data.buffer as ArrayBuffer]);
  });
  child.stdin.on("error", error => post({ kind: "stdinError", id: request.id, message: error.message }));
  child.once("error", error => post({ kind: "spawnError", id: request.id, message: error.message }));
  child.once("close", (code, signal) => {
    children.delete(request.id);
    post({ kind: "close", id: request.id, code, signal });
  });
}

port.on("message", (request: GitProcessWorkerRequest) => {
  if (request.kind === "run" || request.kind === "open") start(request);
  else if (request.kind === "write") children.get(request.id)?.stdin.write(request.data);
  else if (request.kind === "end") children.get(request.id)?.stdin.end();
  else if (request.kind === "kill") children.get(request.id)?.kill();
});
