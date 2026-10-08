/*
 * Exports:
 * - runRepair: resume the durable dependency repair before any dependency loads.
 */
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import WorkbenchBootstrapCommand from "../package/WorkbenchBootstrapCommand.mjs";
import { resolveDataRoot, readJournal, writeJournal, isRepairPending, journalPath } from "./update-journal.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = error => (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f]/gu, " ").slice(0, 512);
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

async function publication(filename, files) {
  let text;
  try { text = await files.readFile(filename, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const value = JSON.parse(text);
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1) throw new Error(`Invalid process publication: ${filename}`);
  return value;
}

function loopbackOrigin(endpoint) {
  const origin = new URL(endpoint.origin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname) || !origin.port
    || origin.origin !== endpoint.origin || origin.username || origin.password) {
    throw new Error("Invalid Workbench process control publication.");
  }
  return origin;
}

async function controlJson(endpoint, route, method = "GET") {
  const origin = loopbackOrigin(endpoint);
  const headers = endpoint.token ? { Authorization: `Bearer ${endpoint.token}` } : {};
  const response = await fetch(`${origin.origin}${route}`, { method, headers, cache: "no-store", redirect: "error" });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("Workbench process control endpoint is unavailable.");
  }
  const chunks = [];
  let size = 0;
  for await (const bytes of response.body) {
    size += bytes.length;
    if (size > 16384) throw new Error("Workbench process control response exceeded its boundary.");
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function verifyPublication(endpoint, name) {
  const actual = await controlJson(endpoint, name === "app" ? "/_workbench-control/health" : "/healthz");
  if (actual.instanceId !== endpoint.instanceId || actual.pid !== endpoint.pid || actual.origin !== endpoint.origin) {
    throw new Error(`Workbench ${name} process identity does not match its publication; refusing to stop its pid.`);
  }
}

async function stopApp(endpoint) {
  const reply = await controlJson(endpoint, `/_workbench-control/quit/${endpoint.instanceId}`, "POST");
  if (reply.ok !== true) throw new Error("Workbench app did not acknowledge shutdown.");
}

async function stopHost(endpoint, alive, log) {
  const origin = loopbackOrigin(endpoint);
  if (!/^[a-f0-9]{64}$/u.test(endpoint.token)) throw new Error("Invalid Workbench host control publication.");
  const socket = new WebSocket(`${origin.origin.replace("http:", "ws:")}/control`, ["workbench-service", endpoint.token]);
  await new Promise((resolve, reject) => {
    let requestId = randomUUID();
    let stopping = false;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearInterval(monitor);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("open", opened);
      socket.close();
      error ? reject(error) : resolve();
    };
    const failed = () => finish(new Error("Workbench host control connection failed."));
    const closed = () => finish(new Error("Workbench host closed before acknowledging shutdown."));
    const opened = () => socket.send(JSON.stringify({ id: requestId, method: "service/process/read" }));
    const message = event => {
      try {
        if (typeof event.data !== "string" || event.data.length > 262144) throw new Error("Invalid host control response.");
        const reply = JSON.parse(event.data);
        if (reply.id !== requestId) return;
        if (reply.kind === "error") throw new Error(`Host shutdown failed: ${String(reply.message).slice(0, 512)}`);
        if (!stopping) {
          if (reply.kind !== "process" || typeof reply.instanceId !== "string" || reply.instanceId !== endpoint.instanceId) {
            throw new Error("Workbench host identity changed before shutdown.");
          }
          stopping = true;
          requestId = randomUUID();
          socket.send(JSON.stringify({ id: requestId, method: "service/stop", instanceId: reply.instanceId }));
        } else if (reply.kind === "ok") finish();
        else throw new Error("Invalid host shutdown acknowledgement.");
      } catch (error) { finish(error); }
    };
    let polls = 0;
    const monitor = setInterval(() => {
      void (async () => {
        if (!alive(endpoint.pid)) finish();
        else if (polls++ % 20 === 0) await log(`Awaiting host shutdown acknowledgement (${endpoint.pid}).`);
      })().catch(finish);
    }, 250);
    socket.addEventListener("message", message);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", closed);
    socket.addEventListener("open", opened, { once: true });
  });
}

async function stopProcesses(dataRoot, { files, alive, sleep, log, terminate, verify, quitApp }) {
  // Snapshot all publications before stopping the host, which removes daemon publications.
  const publications = await Promise.all(["service", "app", "daemon"].map(async name =>
    ({ name, endpoint: await publication(path.join(dataRoot, name, "runtime.json"), files) })));
  const endpoints = publications.filter(({ endpoint }) => endpoint);
  const host = publications.find(({ name }) => name === "service").endpoint;
  if (host && host.pid !== process.pid && alive(host.pid)) {
    await log(`Stopping Workbench host (${host.pid}).`);
    await stopHost(host, alive, log);
    let polls = 0;
    while (alive(host.pid)) {
      if (polls++ % 20 === 0) await log(`Waiting for Workbench host crash unit to exit (${host.pid}).`);
      await sleep(250);
    }
  }
  const pids = [...new Set(endpoints.map(({ endpoint }) => endpoint.pid))].filter(pid => pid !== process.pid);
  // `wb repair` can run while the app or a standalone daemon is still open.
  // Retire those published roots rather than waiting forever for voluntary exit.
  for (const { name, endpoint } of endpoints) {
    const pid = endpoint.pid;
    if (pid === host?.pid || !alive(pid)) continue;
    if (pid === process.pid) continue;
    await verify(endpoint, name);
    await log(`Stopping published Workbench process (${pid}).`);
    if (name === "app") await quitApp(endpoint);
    else await terminate(pid);
  }
  let polls = 0;
  while (true) {
    const remaining = pids.filter(alive);
    // Observe new publications too: an already-starting process must not escape the barrier.
    for (const name of ["service", "app", "daemon"]) {
      const endpoint = await publication(path.join(dataRoot, name, "runtime.json"), files);
      if (endpoint && endpoint.pid !== process.pid && alive(endpoint.pid) && !pids.includes(endpoint.pid)) {
        throw new Error(`Workbench ${name} restarted during dependency repair (pid ${endpoint.pid}). Stop it before retrying.`);
      }
    }
    if (!remaining.length) return;
    if (polls++ % 20 === 0) await log(`Waiting for Workbench processes to exit: ${remaining.join(", ")}.`);
    await sleep(250);
  }
}

async function cleanDependencies(root, files, log) {
  const workspace = await files.readFile(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const packageBlock = workspace.match(/^packages:\s*\r?\n((?:[ \t]+.*\r?\n|[ \t]*\r?\n)*)/mu)?.[1];
  if (!packageBlock) throw new Error("Cannot read workspace packages for dependency cleanup.");
  const patterns = packageBlock.split(/\r?\n/u).map(line => line.match(/^\s+-\s+(.+?)\s*(?:#.*)?$/u)?.[1])
    .filter(Boolean).map(value => value.replace(/^(['"])(.*)\1$/u, "$2"));
  if (patterns.some(pattern => pattern.startsWith("!") || path.isAbsolute(pattern) || pattern.split(/[\\/]/u).includes(".."))) {
    throw new Error("Workspace package patterns are unsafe or unsupported for dependency cleanup.");
  }
  const directories = [root];
  for (const pattern of patterns) {
    for await (const entry of files.glob(pattern, { cwd: root, exclude: ["**/node_modules/**", ".git/**"] })) {
      const directory = path.resolve(root, entry);
      if ((await files.lstat(directory)).isDirectory()) directories.push(directory);
    }
  }
  for (const directory of new Set(directories)) {
    // Canonical real paths prevent workspace symlinks escaping the checkout.
    const realRoot = await files.realpath(root);
    const realDirectory = await files.realpath(directory);
    const relative = path.relative(realRoot, realDirectory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Dependency cleanup escaped the checkout.");
    const target = path.join(realDirectory, "node_modules");
    await log(`Removing ${target}.`);
    await files.rm(target, { recursive: true, force: true });
  }
}

async function withRepairLock(dataRoot, files, alive, sleep, log, operation) {
  const directory = path.join(dataRoot, "update");
  await files.mkdir(directory, { recursive: true });
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const candidate = path.join(directory, `.${owner}`);
  const lock = path.join(directory, "repair.lock");
  await files.mkdir(candidate);
  await files.writeFile(path.join(candidate, owner), "");
  let acquired = false;
  let polls = 0;
  try {
    while (!acquired) {
      try {
        // The owner is present before publishing the directory. Existing lock
        // directories are nonempty, so rename cannot replace a live owner.
        await files.rename(candidate, lock);
        acquired = true;
      } catch (error) {
        if (!["EEXIST", "ENOTEMPTY", "EPERM", "EACCES"].includes(error.code)) throw error;
        let owners;
        try { owners = await files.readdir(lock); }
        catch (readError) { if (readError.code === "ENOENT") continue; throw readError; }
        for (const entry of owners) {
          const match = entry.match(/^owner-(\d+)-[a-f0-9-]{36}$/u);
          if (!match) throw new Error("Workbench repair lock has an invalid owner.");
          if (!alive(Number(match[1]))) {
            // Remove only the exact stale owner, never recursively remove a
            // lock another contender might already have acquired.
            try { await files.unlink(path.join(lock, entry)); }
            catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
          } else if (polls++ % 20 === 0) {
            await log(`Waiting for Workbench dependency repair owned by process ${match[1]}.`);
          }
        }
        try { await files.rmdir(lock); }
        catch (removeError) { if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(removeError.code)) throw removeError; }
        await sleep(250);
      }
    }
    return await operation();
  } finally {
    const ownedDirectory = acquired ? lock : candidate;
    await files.unlink(path.join(ownedDirectory, owner));
    try { await files.rmdir(ownedDirectory); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  }
}

export async function runRepair(options = {}) {
  // In-memory journal seams keep unit tests independent of real user data.
  if (options.readJournal || options.writeJournal) return repair(options);
  const dataRoot = options.dataRoot ?? resolveDataRoot();
  return withRepairLock(dataRoot, options.files ?? fs, options.alive ?? isAlive,
    options.sleep ?? delay, options.log ?? (line => process.stderr.write(`${line}\n`)),
    () => repair({ ...options, dataRoot }));
}

async function repair(options) {
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dataRoot = options.dataRoot ?? resolveDataRoot();
  const files = options.files ?? fs;
  const now = options.now ?? Date.now;
  const read = options.readJournal ?? (() => readJournal(dataRoot, files));
  const write = options.writeJournal ?? (journal => writeJournal(journal, dataRoot, files));
  let journal;
  try { journal = await read(); }
  catch (error) {
    // `wb repair` is the way out of every broken state, including a corrupt journal: keep it for inspection and start over.
    if (!options.force || options.readJournal) throw error;
    const aside = `${journalPath(dataRoot)}.invalid-${now()}`;
    await files.rename(journalPath(dataRoot), aside);
    await (options.log ?? (line => process.stderr.write(`${line}\n`)))(`Moved an unreadable repair journal to ${aside}.`);
    journal = null;
  }
  if (!options.force && !isRepairPending(journal)) return journal;
  const fresh = !journal || journal.phase === "done";
  if (fresh) {
    const at = now();
    journal = { version: 1, id: randomUUID(), phase: "clean-installing", fromSha: null, toSha: null,
      logPath: path.join(root, ".workbench", "logs", `workbench-update-${at}.log`),
      lastError: null, createdAt: at, updatedAt: at, failure: null };
    await write(journal);
  }
  if (path.relative(path.resolve(root, ".workbench", "logs"), path.resolve(path.dirname(journal.logPath))) !== "") {
    throw new Error("Workbench repair belongs to another checkout. Run `wb repair` from the checkout named in its update log.");
  }
  if (!options.log) await files.mkdir(path.dirname(journal.logPath), { recursive: true });
  const log = options.log ?? (line => {
    appendFileSync(journal.logPath, `${line}\n`);
    process.stderr.write(`${line}\n`);
  });
  // WorkbenchBootstrapCommand turns onOutput failures into typed child-command failures.
  // Writing in the output sink itself would escape its error boundary.
  const commandOutput = { write() {} };
  const commands = options.commands ?? new WorkbenchBootstrapCommand({ output: commandOutput, errorOutput: commandOutput });
  const stop = options.stop ?? (() => stopProcesses(dataRoot, {
    files, alive: options.alive ?? isAlive, sleep: options.sleep ?? delay, log,
    verify: options.verify ?? verifyPublication,
    quitApp: options.quitApp ?? stopApp,
    terminate: options.terminate ?? (async pid => {
      if (process.platform === "win32") {
        try {
          await commands.run("taskkill", ["/PID", String(pid), "/T", "/F"], {
            cwd: root, onOutput: text => { if (!options.commands) appendFileSync(journal.logPath, text); },
          });
        }
        catch (error) { if (isAlive(pid)) throw error; await log(`Process ${pid} exited before termination.`); }
      } else {
        try { process.kill(pid, "SIGTERM"); }
        catch (error) { if (error.code !== "ESRCH") throw error; }
      }
    }),
  }));
  const clean = options.clean ?? (() => cleanDependencies(root, files, log));
  const persist = async phase => {
    journal = { ...journal, phase, updatedAt: now() };
    await write(journal);
    await log(`Workbench update repair: ${phase}.`);
  };
  const failure = async error => {
    journal = { ...journal, lastError: bounded(error), updatedAt: now() };
    await write(journal);
    await log(`Repair failed: ${journal.lastError}`);
  };
  // Every entry point retries a stranded repair from the clean-install rung: locks that stranded it (an open editor,
  // a stuck process) are often gone by the next launch or after a reboot.
  let phase = (options.force && fresh) || journal.phase === "stranded" ? "clean-installing" : journal.phase;
  if (["pending", "stopping"].includes(phase)) phase = "installing";
  if (phase === "rolling-back" && !journal.fromSha) phase = "clean-installing";
  try {
    // Keep the recovery rung durable on resume; a second crash during stopping
    // must not accidentally move a rollback/clean repair back to the first rung.
    if (journal.phase === "pending") await persist("stopping");
    if (phase === "clean-installing" && journal.phase !== phase) await persist(phase);
    await stop();
    while (true) {
      // Only a rollback leaves the user without the update they asked for, so only it records a failure for the app
      // to hand to an agent; a clean reinstall that succeeds is fully recovered.
      if (phase === "rolling-back" && !journal.failure) {
        journal = { ...journal, failure: { at: now(), logPath: journal.logPath,
          message: `Installing the update's dependencies failed, so Workbench went back to the previous version: ${journal.lastError ?? "unknown error"}`.slice(0, 512) } };
      }
      await persist(phase);
      let succeeded = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        let output = "";
        const onOutput = text => {
          output = (output + text).slice(-65536);
          if (!options.commands) appendFileSync(journal.logPath, text);
        };
        try {
          if (phase === "rolling-back") {
            await log(`Rolling checkout back to ${journal.fromSha}.`);
            await commands.run("git", ["reset", "--keep", journal.fromSha], { cwd: root, onOutput });
          }
          if (phase === "clean-installing") await clean();
          await log("Running vp install.");
          await commands.run("vp", ["install"], { cwd: root, onOutput });
          succeeded = true;
          break;
        } catch (error) {
          await failure(error);
          if (attempt === 0 && /EBUSY|EPERM|resource busy|sharing violation/iu.test(`${error.code ?? ""} ${bounded(error)} ${output}`)) {
            await log("Locked files detected; confirming Workbench exited before one retry.");
            await stop();
            continue;
          }
          break;
        }
      }
      if (succeeded) {
        journal = { ...journal, lastError: null };
        await persist("done");
        return journal;
      }
      if (phase === "installing") phase = journal.fromSha ? "rolling-back" : "clean-installing";
      else if (phase === "rolling-back") phase = "clean-installing";
      else { await persist("stranded"); return journal; }
    }
  } catch (error) {
    await failure(error);
    await persist("stranded");
    return journal;
  }
}

async function main() {
  try {
    if (process.env.WORKBENCH_THREAD_ID?.trim() || process.env.CODEX_THREAD_ID?.trim()) {
      throw new Error("Managed threads cannot repair Workbench dependencies. Ask the user to run `wb repair`.");
    }
    const journal = await runRepair({ force: true });
    if (journal?.phase === "stranded") throw new Error(`Workbench update repair failed: ${journal.lastError}. Run \`wb repair\` (log: ${journal.logPath}).`);
  } catch (error) {
    process.stderr.write(`${bounded(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
