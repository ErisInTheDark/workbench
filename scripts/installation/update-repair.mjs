/*
 * Exports:
 * - prepareInstallationRuntime: make the managed PowerShell runtime ready without dependency repair.
 * - preparePulledInstallationRuntime: execute runtime preparation from the freshly pulled checkout.
 * - runRepair: resume the durable dependency repair before any dependency loads; cancellable while it owns the lock, busy while it runs.
 * - readRepairActivity: the journal plus the live repair lock owner, for watchers.
 * - requestRepairCancel: ask one exact live repair owner to cancel.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import WorkbenchBootstrapCommand from "../../package/WorkbenchBootstrapCommand.mjs";
import WorkbenchToolchain from "../../package/WorkbenchToolchain.mjs";
import { DAEMON_DEPENDENCY_IMPORTERS, hasDependencyDrift } from "../../shared/pnpm-dependency-state.mjs";
import WorkbenchBusyLease from "../../shared/WorkbenchBusyLease.mjs";
import WorkbenchPowerShell from "./WorkbenchPowerShell.mjs";
import { resolveDataRoot, readJournal, writeJournal, isRepairPending, journalPath } from "./update-journal.mjs";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = error => (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f]/gu, " ").slice(0, 512);
const POLL_MS = 250;
const OWNER_PATTERN = /^owner-(\d+)-[a-f0-9-]{36}$/u;
const OUTPUT_TAIL = 65536;
const FAILURE_TAIL = 4096;
// pnpm's defaults (2 retries, 10s then 60s apart) stall an unreachable registry for minutes per package.
const REPAIR_FETCH_ENVIRONMENT = {
  pnpm_config_fetch_retries: "1",
  pnpm_config_fetch_retry_mintimeout: "2000",
  pnpm_config_fetch_retry_maxtimeout: "10000",
};
const NETWORK_FAILURE = /ENETUNREACH|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ERR_PNPM_[A-Z_]*FETCH/u;

function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

const lockPath = dataRoot => path.join(dataRoot, "update", "repair.lock");
const cancelPath = (dataRoot, token) => path.join(dataRoot, "update", `cancel-${token}`);

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

async function stopHost(endpoint, alive, log, signal) {
  const origin = loopbackOrigin(endpoint);
  if (!/^[a-f0-9]{64}$/u.test(endpoint.token)) throw new Error("Invalid Workbench host control publication.");
  signal?.throwIfAborted();
  const socket = new WebSocket(`${origin.origin.replace("http:", "ws:")}/control`, ["workbench-service", endpoint.token]);
  await new Promise((resolve, reject) => {
    let requestId = randomUUID();
    let stopping = false;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearInterval(monitor);
      signal?.removeEventListener("abort", aborted);
      socket.removeEventListener("message", message);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", closed);
      socket.removeEventListener("open", opened);
      socket.close();
      error ? reject(error) : resolve();
    };
    const aborted = () => finish(signal.reason);
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
    }, POLL_MS);
    signal?.addEventListener("abort", aborted, { once: true });
    socket.addEventListener("message", message);
    socket.addEventListener("error", failed);
    socket.addEventListener("close", closed);
    socket.addEventListener("open", opened, { once: true });
  });
}

/** `host: false` leaves the host and its daemon running: only the app's own dependencies are changing. */
async function stopProcesses(dataRoot, { files, alive, sleep, log, terminate, verify, quitApp, host: includeHost, signal }) {
  const pause = async () => { await sleep(POLL_MS); signal?.throwIfAborted(); };
  const names = includeHost ? ["service", "app", "daemon"] : ["app"];
  // Snapshot all publications before stopping the host, which removes daemon publications.
  const publications = await Promise.all(names.map(async name =>
    ({ name, endpoint: await publication(path.join(dataRoot, name, "runtime.json"), files) })));
  const endpoints = publications.filter(({ endpoint }) => endpoint);
  const host = publications.find(({ name }) => name === "service")?.endpoint;
  if (host && host.pid !== process.pid && alive(host.pid)) {
    await log(`Stopping Workbench host (${host.pid}).`);
    await stopHost(host, alive, log, signal);
    let polls = 0;
    while (alive(host.pid)) {
      if (polls++ % 20 === 0) await log(`Waiting for Workbench host crash unit to exit (${host.pid}).`);
      await pause();
    }
  }
  const pids = [...new Set(endpoints.map(({ endpoint }) => endpoint.pid))].filter(pid => pid !== process.pid);
  // `wb repair` can run while the app or a standalone daemon is still open.
  // Retire those published roots rather than waiting forever for voluntary exit.
  for (const { name, endpoint } of endpoints) {
    const pid = endpoint.pid;
    if (pid === host?.pid || !alive(pid)) continue;
    if (pid === process.pid) continue;
    signal?.throwIfAborted();
    await verify(endpoint, name);
    await log(`Stopping published Workbench process (${pid}).`);
    if (name === "app") await quitApp(endpoint);
    else await terminate(pid);
  }
  let polls = 0;
  while (true) {
    const remaining = pids.filter(alive);
    // Observe new publications too: an already-starting process must not escape the barrier.
    for (const name of names) {
      const endpoint = await publication(path.join(dataRoot, name, "runtime.json"), files);
      if (endpoint && endpoint.pid !== process.pid && alive(endpoint.pid) && !pids.includes(endpoint.pid)) {
        throw new Error(`Workbench ${name} restarted during dependency repair (pid ${endpoint.pid}). Stop it before retrying.`);
      }
    }
    if (!remaining.length) return;
    if (polls++ % 20 === 0) await log(`Waiting for Workbench processes to exit: ${remaining.join(", ")}.`);
    await pause();
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

async function liveOwners(dataRoot, files, alive) {
  let entries;
  try { entries = await files.readdir(lockPath(dataRoot)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return entries.map(token => {
    const match = token.match(OWNER_PATTERN);
    if (!match) throw new Error("Workbench repair lock has an invalid owner.");
    return { pid: Number(match[1]), token };
  }).filter(({ pid }) => alive(pid));
}

export async function readRepairActivity(dataRoot = resolveDataRoot(), { files = fs, alive = isAlive } = {}) {
  const [journal, owners] = await Promise.all([readJournal(dataRoot, files), liveOwners(dataRoot, files, alive)]);
  return { journal, owner: owners[0] ?? null };
}

/** Keyed to one owner token, so a stale request can never cancel a later repair. */
export async function requestRepairCancel(dataRoot, token, files = fs) {
  if (!OWNER_PATTERN.test(token)) throw new Error("Invalid repair owner.");
  await files.writeFile(cancelPath(dataRoot, token), "");
}

async function waitingNotice(dataRoot, files, pid) {
  let logPath = null;
  try { logPath = (await readJournal(dataRoot, files))?.logPath ?? null; }
  catch { /* An unreadable journal only loses the log hint; the owner reports it. */ }
  return `Workbench dependency repair is running in process ${pid}${logPath ? ` (log: ${logPath})` : ""}. Run \`wb view\` to watch or cancel it.`;
}

async function withRepairLock(dataRoot, files, alive, sleep, log, operation) {
  const directory = path.join(dataRoot, "update");
  await files.mkdir(directory, { recursive: true });
  const owner = `owner-${process.pid}-${randomUUID()}`;
  const candidate = path.join(directory, `.${owner}`);
  const lock = lockPath(dataRoot);
  await files.mkdir(candidate);
  await files.writeFile(path.join(candidate, owner), "");
  let acquired = false;
  let announced = null;
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
          const match = entry.match(OWNER_PATTERN);
          if (!match) throw new Error("Workbench repair lock has an invalid owner.");
          const pid = Number(match[1]);
          if (!alive(pid)) {
            // Remove only the exact stale owner, never recursively remove a
            // lock another contender might already have acquired.
            try { await files.unlink(path.join(lock, entry)); }
            catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
          } else if (announced !== pid) {
            announced = pid;
            await log(await waitingNotice(dataRoot, files, pid));
          }
        }
        try { await files.rmdir(lock); }
        catch (removeError) { if (!["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM", "EACCES"].includes(removeError.code)) throw removeError; }
        await sleep(POLL_MS);
      }
    }
    return await operation(owner);
  } finally {
    const ownedDirectory = acquired ? lock : candidate;
    await files.unlink(path.join(ownedDirectory, owner));
    try { await files.rmdir(ownedDirectory); }
    catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTEMPTY") throw error; }
  }
}

/** The lock owner's one cancellation: its caller's signal, terminal or supervisor signals, or a watcher's request. */
async function withCancellation({ dataRoot, files, sleep, signal }, owner, operation) {
  const controller = new AbortController();
  const cancel = message => { if (!controller.signal.aborted) controller.abort(new Error(message)); };
  const interrupt = () => cancel("Interrupted.");
  const forward = () => cancel("Cancelled.");
  const request = cancelPath(dataRoot, owner);
  let done = false;
  const watching = (async () => {
    while (!done && !controller.signal.aborted) {
      try { await files.readFile(request, "utf8"); cancel("Cancelled from wb view."); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      await sleep(POLL_MS);
    }
  })();
  if (signal?.aborted) forward();
  signal?.addEventListener("abort", forward, { once: true });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try { return await operation(controller.signal); }
  finally {
    done = true;
    signal?.removeEventListener("abort", forward);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await watching.catch(() => {});
    try { await files.unlink(request); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export async function runRepair(options = {}) {
  // In-memory journal seams keep unit tests independent of real user data.
  if (options.readJournal || options.writeJournal) return repair(options);
  const dataRoot = options.dataRoot ?? resolveDataRoot();
  const files = options.files ?? fs;
  const sleep = options.sleep ?? delay;
  return withRepairLock(dataRoot, files, options.alive ?? isAlive, sleep,
    options.log ?? (line => process.stderr.write(`${line}\n`)),
    owner => withCancellation({ dataRoot, files, sleep, signal: options.signal }, owner,
      signal => repair({ ...options, dataRoot, signal })));
}

export async function prepareInstallationRuntime(options = {}) {
  const dataRoot = options.dataRoot ?? resolveDataRoot();
  const files = options.files ?? fs;
  const read = options.readJournal ?? (() => readJournal(dataRoot, files));
  const journal = await read();
  if (isRepairPending(journal)) return runRepair({ ...options, dataRoot });
  const commandOutput = { write() {} };
  const commands = options.commands ?? new WorkbenchBootstrapCommand({ output: commandOutput, errorOutput: commandOutput });
  const powerShell = options.powerShell ?? new WorkbenchPowerShell({ dataRoot, commands });
  await powerShell.ensure({ onOutput: text => process.stderr.write(text) });
  return journal;
}

export async function preparePulledInstallationRuntime(root, {
  signal,
  execute = promisify(execFile),
} = {}) {
  const checkout = path.resolve(root);
  await execute(process.execPath, [
    path.join(checkout, "scripts", "installation", "update-repair.mjs"),
    "--runtime",
  ], { cwd: checkout, windowsHide: true, signal });
}

async function repair(options) {
  const busy = options.busy ?? new WorkbenchBusyLease({
    dataRoot: options.dataRoot ?? resolveDataRoot(), holder: "repair", warn: line => process.stderr.write(`${line}\n`),
  });
  busy.hold("installing", "installing dependencies");
  try { return await repairJournal(options); }
  finally { busy.close(); }
}

async function repairJournal(options) {
  const root = options.root ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const dataRoot = options.dataRoot ?? resolveDataRoot();
  const files = options.files ?? fs;
  const now = options.now ?? Date.now;
  const signal = options.signal;
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
  const toolchain = options.toolchain ?? new WorkbenchToolchain({ dataRoot, commands });
  const powerShell = options.powerShell ?? new WorkbenchPowerShell({ dataRoot, commands });
  const stop = options.stop ?? (({ host }) => stopProcesses(dataRoot, {
    files, alive: options.alive ?? isAlive, sleep: options.sleep ?? delay, log, host, signal,
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
  const daemonDependencyDrift = options.daemonDependencyDrift ?? (() => hasDependencyDrift(root, DAEMON_DEPENDENCY_IMPORTERS));
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
  /** Output tail for one command, also streamed to the log and to an attached terminal. */
  const capture = () => {
    let output = "";
    return {
      get output() { return output; },
      onOutput: text => {
        output = (output + text).slice(-OUTPUT_TAIL);
        if (!options.commands) appendFileSync(journal.logPath, text);
        if (process.stderr.isTTY) process.stderr.write(text);
      },
    };
  };
  // Cancellation and unreachable registries are not dependency damage: keep the rung and remove nothing.
  const resumable = async (error, output) => {
    if (signal?.aborted) {
      await failure(new Error("Cancelled."));
      await log(`Workbench update repair cancelled (${bounded(signal.reason)}); the next launch or \`wb repair\` resumes this step.`);
      return true;
    }
    if (NETWORK_FAILURE.test(`${error?.code ?? ""} ${bounded(error)} ${output.slice(-FAILURE_TAIL)}`)) {
      await failure(new Error(`Dependency download failed (network): ${bounded(error)}`));
      await log(`${journal.phase === "clean-installing" ? "" : "Nothing was removed. "}Fix the network, then relaunch Workbench or run \`wb repair\`.`);
      return true;
    }
    return false;
  };
  // Every entry point retries a stranded repair from the clean-install rung: locks that stranded it (an open editor,
  // a stuck process) are often gone by the next launch or after a reboot.
  let phase = (options.force && fresh) || journal.phase === "stranded" ? "clean-installing" : journal.phase;
  if (["pending", "stopping"].includes(phase)) phase = "installing";
  if (phase === "rolling-back" && !journal.fromSha) phase = "clean-installing";
  const toolchainOutput = capture();
  try {
    await log(`Workbench update repair log: ${journal.logPath}`);
    const onToolchainOutput = text => {
      toolchainOutput.onOutput(text);
      if (!process.stderr.isTTY) process.stderr.write(text);
    };
    await toolchain.ensure({ onOutput: onToolchainOutput });
    await powerShell.ensure({ onOutput: onToolchainOutput });
    await toolchain.run(["env", "install"], {
      cwd: root, onOutput: onToolchainOutput, signal, environment: REPAIR_FETCH_ENVIRONMENT,
    });
    // Keep the recovery rung durable on resume; a second crash during stopping
    // must not accidentally move a rollback/clean repair back to the first rung.
    if (journal.phase === "pending") await persist("stopping");
    if (phase === "clean-installing" && journal.phase !== phase) await persist(phase);
    // Only the first plain install can leave the host running; every escalation replaces everything.
    let hostStopped = phase !== "installing" || await daemonDependencyDrift();
    await stop({ host: hostStopped });
    while (true) {
      if (!hostStopped) {
        hostStopped = phase !== "installing";
        if (hostStopped) await stop({ host: true });
      }
      // Only a rollback leaves the user without the update they asked for, so only it records a failure for the app
      // to hand to an agent; a clean reinstall that succeeds is fully recovered.
      if (phase === "rolling-back" && !journal.failure) {
        journal = { ...journal, failure: { at: now(), logPath: journal.logPath,
          message: `Installing the update's dependencies failed, so Workbench went back to the previous version: ${journal.lastError ?? "unknown error"}`.slice(0, 512) } };
      }
      await persist(phase);
      let succeeded = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        const command = capture();
        try {
          if (phase === "rolling-back") {
            await log(`Rolling checkout back to ${journal.fromSha}.`);
            await commands.run("git", ["reset", "--keep", journal.fromSha], { cwd: root, onOutput: command.onOutput, signal });
          }
          if (phase === "clean-installing") await clean();
          signal?.throwIfAborted();
          await log("Running vp install.");
          await toolchain.run(["install"], {
            cwd: root, onOutput: command.onOutput, signal, environment: REPAIR_FETCH_ENVIRONMENT,
          });
          succeeded = true;
          break;
        } catch (error) {
          if (await resumable(error, command.output)) return journal;
          await failure(error);
          if (attempt === 0 && /EBUSY|EPERM|resource busy|sharing violation/iu.test(`${error.code ?? ""} ${bounded(error)} ${command.output}`)) {
            await log("Locked files detected; confirming Workbench exited before one retry.");
            hostStopped = true;
            await stop({ host: true });
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
    if (await resumable(error, toolchainOutput.output)) return journal;
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
    const args = process.argv.slice(2);
    if (args.length > 1 || args.length === 1 && args[0] !== "--runtime") {
      throw new Error("Usage: update-repair.mjs [--runtime]");
    }
    const journal = args[0] === "--runtime"
      ? await prepareInstallationRuntime()
      : await runRepair({ force: true });
    if (journal?.phase === "stranded") throw new Error(`Workbench update repair failed: ${journal.lastError}. Run \`wb repair\` (log: ${journal.logPath}).`);
  } catch (error) {
    process.stderr.write(`${bounded(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
