/*
 * Exports:
 * - VisCommandRunner: runs one shell command as a thread, inside that thread's sandbox.
 * - VisRenderRuns: hands out run ids and collects what `wb vis render` delivers for them.
 * - visShellCommand: pipe a quoted argument vector into `wb vis render` through the user's login shell.
 * - VisBuildContext/WORKBENCH_KIT_VIS_CONFIG: where a session's commands run, and Workbench's own kit commands.
 * - compileVisCss/buildVisDocument: run a context's `vis.css` or `vis.build` command for one file.
 */
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { WORKBENCH_PROJECT_CONFIG_FILE } from "workbench-shared/workbench/project-config/workbench-project-config";
import { expandVisProjectCommand, VisBuildOutputSchema, type VisProjectCommand } from "workbench-shared/workbench/vis/vis-project-config";
import { readWorkbenchProjectConfig } from "../project-config/read-workbench-project-config";

export type VisCommandRunner = (
  request: { command: string[]; cwd: string },
  signal: AbortSignal,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * A project command's result never travels back as command output, which agent shells bound for transcripts.
 * It is piped into `wb vis render`, which posts it to the daemon against an unguessable run id.
 */
export class VisRenderRuns {
  readonly #runs = new Map<string, { content: string | null }>();

  open() {
    const runId = randomUUID();
    const run = { content: null as string | null };
    this.#runs.set(runId, run);
    return { runId, take: () => run.content, close: () => { this.#runs.delete(runId); } };
  }

  /** False for an unknown, closed or already answered run. */
  accept(runId: string, content: string) {
    const run = this.#runs.get(runId);
    if (!run || run.content !== null) return false;
    run.content = content;
    return true;
  }
}

/**
 * Runs through the user's login shell, as `wb shell` does, so tool shims on PATH resolve. Every argument is
 * single-quoted, so nothing in it is interpreted, and a failing producer fails the whole pipeline.
 */
export function visShellCommand(argv: readonly string[], runId: string, platform: NodeJS.Platform = process.platform, shell = process.env.SHELL) {
  if (platform === "win32") {
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
    return ["pwsh", "-Command",
      `$ErrorActionPreference = 'Stop'; $PSNativeCommandUseErrorActionPreference = $true; & ${argv.map(quote).join(" ")} | wb vis render --run ${quote(runId)}`];
  }
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [shell?.trim() || "/bin/sh", "-lc", `set -o pipefail; ${argv.map(quote).join(" ")} | wb vis render --run ${quote(runId)}`];
}

function bounded(text: string) {
  const trimmed = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, "").trim();
  return trimmed.length > 1_200 ? `${trimmed.slice(0, 1_200)}…` : trimmed;
}

/**
 * Where a session's commands run. `config` is fixed for Workbench's kit context; projects read theirs from
 * `.wb.json` at `rootPath` on every render, so edits apply without restarting the session.
 */
export interface VisBuildContext {
  rootPath: string;
  config: { css?: VisProjectCommand; build?: VisProjectCommand } | null;
}

/** Workbench's own build, run from its checkout: Workbench Tailwind, and `.tsx` files may import `workbench/kit`. */
export const WORKBENCH_KIT_VIS_CONFIG: NonNullable<VisBuildContext["config"]> = {
  css: {
    command: ["node", "app/node_modules/@tailwindcss/cli/dist/index.mjs", "--input", "{input}"],
    input: "@import \"{root}/app/client/components/vis-kit/vis-page.css\";\n@source \"{file}\";\n",
  },
  build: { command: ["node", "--disable-warning=ExperimentalWarning", "--import", "tsx", "scripts/vis-build.mts", "--kit", "{file}"] },
};

async function readCommand(context: VisBuildContext, kind: "css" | "build") {
  if (context.config) {
    const command = context.config[kind];
    if (!command) throw new Error(`Workbench's kit vis context has no ${kind} command.`);
    return command;
  }
  const { config, ignored } = await readWorkbenchProjectConfig(context.rootPath);
  const command = config.vis?.[kind];
  if (!command) {
    const need = kind === "css" ? "This file asks for project CSS" : "Rendering .tsx and .jsx files needs a project build";
    const invalid = ignored.filter((entry) => entry === "(top level)" || entry.startsWith("(the whole") || entry === "vis" || entry.startsWith(`vis.${kind}`));
    throw new Error(invalid.length
      ? `${need}, but ${WORKBENCH_PROJECT_CONFIG_FILE} has an invalid vis.${kind} (${invalid.join(", ")}), so it was ignored.`
      : `${need}, but ${path.join(context.rootPath, WORKBENCH_PROJECT_CONFIG_FILE)} has no vis.${kind} command. Configure it, or start the session with project "kit" to use Workbench's kit.`);
  }
  return command;
}

interface ProjectCommandInput {
  file: string;
  context: VisBuildContext;
  /** A Workbench-owned file the command can read through `{input}`; removed afterwards. */
  scratchPath: string;
  run: VisCommandRunner;
  runs: VisRenderRuns;
  signal: AbortSignal;
}

async function runProjectCommand(kind: "css" | "build", input: ProjectCommandInput) {
  const configured = await readCommand(input.context, kind);
  input.signal.throwIfAborted();
  const expanded = expandVisProjectCommand(configured, { file: input.file, root: input.context.rootPath, input: input.scratchPath });
  const render = input.runs.open();
  try {
    if (expanded.input !== null) {
      await mkdir(path.dirname(input.scratchPath), { recursive: true });
      await writeFile(input.scratchPath, expanded.input, "utf8");
    }
    const result = await input.run({ command: visShellCommand(expanded.command, render.runId), cwd: input.context.rootPath }, input.signal);
    const label = kind === "css" ? "CSS" : "build";
    if (result.exitCode !== 0) throw new Error(`The ${label} command exited with code ${result.exitCode}.\n${bounded(result.stderr || result.stdout)}`);
    const content = render.take();
    if (content === null) throw new Error(`The ${label} command finished, but its output never reached wb vis render.\n${bounded(result.stderr || result.stdout)}`);
    return content;
  } finally {
    render.close();
    if (expanded.input !== null) await rm(input.scratchPath, { force: true });
  }
}

export async function compileVisCss(input: ProjectCommandInput) {
  return await runProjectCommand("css", input);
}

export async function buildVisDocument(input: ProjectCommandInput) {
  const output = await runProjectCommand("build", input);
  let json: unknown;
  try { json = JSON.parse(output); }
  catch { throw new Error("The build command's output is not JSON with a document and its inputs."); }
  const parsed = VisBuildOutputSchema.safeParse(json);
  if (!parsed.success) throw new Error(`The build command's output is invalid at ${parsed.error.issues[0]?.path.join(".") || "the top level"}.`);
  return parsed.data;
}
