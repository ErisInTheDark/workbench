/*
 * Exports:
 * - typecheckProjects: maps each public filter flag to the TypeScript project configs it checks.
 * - selectTypecheckConfigs: resolves filter flags to unique configs; no flags selects every project.
 * - summarizeTypecheckDiagnostics: retains bounded unique compiler diagnostics across project runs.
 * - runProjectTypechecks: runs selected compiler projects, through an arc tree overlay when one holds paths, and
 *   preserves failure after the complete sequence.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import WorkbenchArcTree from "../package/WorkbenchArcTree.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const tscPath = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

export const typecheckProjects = {
  app: ["app/tsconfig.json"],
  daemon: ["daemon/tsconfig.typecheck.json", "daemon/host/tsconfig.json"],
  host: ["daemon/host/tsconfig.json"],
  shared: ["shared/tsconfig.json"],
  test: ["test/tsconfig.typecheck.json"],
};

export function selectTypecheckConfigs(args) {
  const projectNames = Object.keys(typecheckProjects);
  const { values } = parseArgs({
    args,
    strict: true,
    options: Object.fromEntries(projectNames.map((name) => [name, { type: "boolean" }])),
  });
  const selected = projectNames.filter((name) => values[name]);
  const names = selected.length > 0 ? selected : projectNames;
  return [...new Set(names.flatMap((name) => typecheckProjects[name]))];
}

function runCompiler(configPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tscPath, "--noEmit", "--project", configPath], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const forward = (stream, destination) => stream?.on("data", (chunk) => {
      const text = chunk.toString();
      output += text;
      destination.write(text);
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      resolve({ code, output });
    };
    child.once("error", (error) => {
      console.error(`Unable to start local TypeScript for ${configPath}: ${error.message}`);
      finish(1);
    });
    child.once("exit", (code) => finish(code ?? 1));
  });
}

export function summarizeTypecheckDiagnostics(outputs, limit = 100) {
  const diagnostics = [];
  const seen = new Set();
  for (const output of outputs) {
    for (const line of output.split(/\r?\n/u)) {
      if (!/error TS\d+:/u.test(line) || seen.has(line)) continue;
      seen.add(line);
      diagnostics.push(line);
      if (diagnostics.length === limit) return diagnostics;
    }
  }
  return diagnostics;
}

/** The compiler over an arc tree overlay; an unusable TypeScript API falls back to the plain compiler, saying so. */
async function runOverlayCompiler(configPath, overlay) {
  try {
    const { typecheckWithArcOverlay } = await import("../test/arc-overlay/arc-overlay-typecheck.ts");
    const result = typecheckWithArcOverlay(projectRoot, configPath, overlay);
    process.stdout.write(result.output);
    return result;
  } catch (error) {
    console.error(`arc overlay typecheck failed (${error instanceof Error ? error.message : String(error)}); checking ${configPath} with plain tsc, including other threads' live edits.`);
    return await runCompiler(configPath);
  }
}

export async function runProjectTypechecks(configPaths, overlay = null) {
  let failed = false;
  const outputs = [];
  for (const configPath of configPaths) {
    const result = overlay && !overlay.isEmpty ? await runOverlayCompiler(configPath, overlay) : await runCompiler(configPath);
    const passed = result.code === 0;
    const status = passed ? "\x1b[32mpass\x1b[0m" : "\x1b[31mfail\x1b[0m";
    process.stdout.write(`${configPath}: ${status}\n`);
    outputs.push(result.output);
    failed ||= !passed;
  }
  const summary = summarizeTypecheckDiagnostics(outputs);
  if (summary.length > 0) process.stderr.write(`\nTypecheck diagnostics:\n${summary.join("\n")}\n`);
  return failed ? 1 : 0;
}

/** Agent runs check other threads' held paths as the caller's arc tree has them; other runs read the filesystem. */
async function loadArcOverlay() {
  return await WorkbenchArcTree.load({ cwd: projectRoot, warn: (line) => process.stdout.write(`${line}\n`) });
}

function selectCliConfigs() {
  try {
    return selectTypecheckConfigs(process.argv.slice(2));
  } catch (error) {
    const flags = Object.keys(typecheckProjects).map((name) => `[--${name}]`).join(" ");
    console.error(`${error instanceof Error ? error.message : String(error)}\nUsage: pnpm typecheck ${flags}; no flags checks every project.`);
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const configPaths = selectCliConfigs();
  if (configPaths === null) process.exitCode = 1;
  else void loadArcOverlay().then(async (overlay) => await runProjectTypechecks(configPaths, overlay)).then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      console.error(`Workbench typecheck runner failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
