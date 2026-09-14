/*
 * Exports:
 * - typecheckProjectConfigs: lists every portable TypeScript project checked by the public command.
 * - summarizeTypecheckDiagnostics: retains bounded unique compiler diagnostics across project runs.
 * - runProjectTypechecks: runs every local compiler project and preserves failure after the complete sequence.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const tscPath = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

export const typecheckProjectConfigs = [
  "daemon/tsconfig.typecheck.json",
  "app/tsconfig.json",
  "daemon/host/tsconfig.json",
  "shared/tsconfig.json",
  "test/tsconfig.typecheck.json",
];

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

export async function runProjectTypechecks() {
  let failed = false;
  const outputs = [];
  for (const configPath of typecheckProjectConfigs) {
    const result = await runCompiler(configPath);
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

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  void runProjectTypechecks().then(
    (exitCode) => { process.exitCode = exitCode; },
    (error) => {
      console.error(`Workbench typecheck runner failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    },
  );
}
