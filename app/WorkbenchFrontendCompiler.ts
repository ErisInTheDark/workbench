/*
 * Keywords: frontend, installation, compilation, watch, output.
 * Exports:
 * - WorkbenchFrontendCompilerOptions: repository, output, environment, and diagnostic seams. Keywords: frontend, compiler, configuration.
 * - default WorkbenchFrontendCompiler: own frontend output, generation identity, and esbuild/Tailwind watch lifecycles. Keywords: frontend, compiler, watch, generation, controller.
 */
import { createHash, randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import WorkbenchProcessLogger from "workbench-shared/process/WorkbenchProcessLogger";
import {
  type WorkbenchFrontendGeneration,
  WORKBENCH_STYLESHEET_GENERATION_PROPERTY,
} from "workbench-shared/frontend-generation";
import resolveWorkbenchRuntimeRoot from "./workbench-runtime-root.ts";

export interface WorkbenchFrontendCompilerOptions {
  createContext?: (options: esbuild.BuildOptions) => Promise<esbuild.BuildContext>;
  stopService?: () => void | Promise<void>;
  environment?: NodeJS.ProcessEnv;
  logger?: WorkbenchProcessLogger;
  onDiagnostic?: (message: string) => void;
  outputDirectoryPath?: string;
  readReactDevelopmentMode?: () => boolean;
  repositoryRootPath?: string;
  spawnTailwind?: (args: readonly string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"];
  }) => ChildProcess;
}

const moduleDirectoryPath = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRootPath = path.resolve(moduleDirectoryPath, "..");
const require = createRequire(import.meta.url);
const tailwindCliPath = path.join(path.dirname(require.resolve("@tailwindcss/cli/package.json")), "dist", "index.mjs");
const FRONTEND_GENERATION_NAMESPACE = "workbench-frontend-generation";
const FRONTEND_GENERATION_MODULE_SPECIFIER = "workbench-shared/frontend-generation";
const STYLESHEET_GENERATION_PATTERN = new RegExp(
  String.raw`\n:root\{${WORKBENCH_STYLESHEET_GENERATION_PROPERTY}:[a-f0-9]{64}\}\n`,
  "gu",
);

function boundedOutput(value: string, limit = 8_000) {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n[output truncated]`;
}

function waitForExit(child: ChildProcess) {
  if (child.signalCode) return Promise.reject(new Error(`Tailwind exited after signal ${child.signalCode}.`));
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`Tailwind exited after signal ${signal}.`));
      else resolve(code ?? 1);
    });
  });
}

export default class WorkbenchFrontendCompiler {
  readonly outputDirectoryPath: string;

  private readonly appDirectoryPath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly logger: WorkbenchProcessLogger;
  private readonly onDiagnostic: (message: string) => void;
  private readonly readReactDevelopmentMode: () => boolean;
  private readonly repositoryRootPath: string;
  private readonly staticDirectoryPath: string;
  private readonly workingDirectoryPath: string;
  private readonly generation = new AbortController();
  private readonly createContext: NonNullable<WorkbenchFrontendCompilerOptions["createContext"]>;
  private readonly stopService: NonNullable<WorkbenchFrontendCompilerOptions["stopService"]>;
  private readonly nativeServiceStopped = Promise.withResolvers<void>();
  private readonly spawnTailwind: NonNullable<WorkbenchFrontendCompilerOptions["spawnTailwind"]>;
  private readonly children = new Set<ChildProcess>();
  private javascriptOutput: { generation: string; files: esbuild.OutputFile[] } | null = null;
  private stylesheetOutput: { generation: string; contents: string; sourceMap: Buffer } | null = null;
  private publishing = true;
  private staticPublished = false;
  private publicationTail = Promise.resolve();
  private startTask: Promise<string> | null = null;
  private retirement: Promise<void> | null = null;
  private stylesheetGeneration: string | null = null;
  private stylesheetGenerationTail = Promise.resolve();
  private esbuildContext: esbuild.BuildContext | null = null;
  private javascriptGeneration: string | null = null;
  private tailwindWatcher: ChildProcess | null = null;

  constructor(options: WorkbenchFrontendCompilerOptions = {}) {
    this.repositoryRootPath = path.resolve(options.repositoryRootPath ?? defaultRepositoryRootPath);
    this.appDirectoryPath = path.join(this.repositoryRootPath, "app");
    this.staticDirectoryPath = path.join(this.repositoryRootPath, "static");
    this.environment = { ...process.env, ...options.environment };
    this.outputDirectoryPath = path.resolve(
      options.outputDirectoryPath ?? path.join(resolveWorkbenchRuntimeRoot(this.repositoryRootPath), "frontend"),
    );
    this.workingDirectoryPath = `${this.outputDirectoryPath}.build-${randomUUID()}`;
    this.createContext = options.createContext ?? esbuild.context;
    this.stopService = options.stopService ?? esbuild.stop;
    this.spawnTailwind = options.spawnTailwind ?? ((args, spawnOptions) => spawn(process.execPath, args, spawnOptions));
    this.readReactDevelopmentMode = options.readReactDevelopmentMode ?? (() => false);
    this.logger = options.logger ?? new WorkbenchProcessLogger();
    this.onDiagnostic = options.onDiagnostic ?? ((message) => console.error(message));
  }

  async buildOnce() {
    this.generation.signal.throwIfAborted();
    await this.prepareStaticOutput();
    await Promise.all([
      esbuild.build(this.esbuildOptions()),
      this.runTailwindOnce(),
    ]);
    await this.refreshStylesheetGeneration();
    return this.outputDirectoryPath;
  }

  async startWatching() {
    this.generation.signal.throwIfAborted();
    if (this.startTask || this.esbuildContext || this.tailwindWatcher) {
      throw new Error("Workbench frontend compiler is already watching.");
    }
    const start = this.startWatchingOwned();
    this.startTask = start;
    try {
      return await start;
    } finally {
      if (this.startTask === start) this.startTask = null;
    }
  }

  private async startWatchingOwned() {
    const signal = this.generation.signal;
    try {
      await this.prepareStaticOutput();
      signal.throwIfAborted();
      const context = await this.createContext(this.esbuildOptions());
      if (signal.aborted) {
        await this.disposeContext(context);
        signal.throwIfAborted();
      }
      this.esbuildContext = context;
      await Promise.all([
        context.rebuild(),
        this.runTailwindOnce(),
      ]);
      signal.throwIfAborted();
      await this.refreshStylesheetGeneration();
      signal.throwIfAborted();
      await context.watch();
      signal.throwIfAborted();
      this.tailwindWatcher = this.startTailwindWatcher();
      return this.outputDirectoryPath;
    } catch (error) {
      this.retire();
      throw error;
    }
  }

  async close() {
    if (this.retirement) return await this.retirement;
    this.generation.abort(new Error("Workbench frontend compiler is retired."));
    this.publishing = false;
    const context = this.esbuildContext;
    const children = [...this.children];
    this.esbuildContext = null;
    this.tailwindWatcher = null;

    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    this.retirement = Promise.allSettled([
      context ? this.disposeContext(context) : undefined,
      ...children.map(child => waitForExit(child).catch((error: unknown) => {
        if (child.killed) return;
        throw error;
      })),
      this.stylesheetGenerationTail,
      this.publicationTail,
    ]).then(async (results) => {
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Compiler retirement failed.");
      await rm(this.workingDirectoryPath, { recursive: true, force: true });
    });
    await this.retirement;
  }

  async shutdown() {
    const closing = this.close();
    await this.stopService();
    this.nativeServiceStopped.resolve();
    await closing;
  }

  private disposeContext(context: esbuild.BuildContext) {
    // A force-stopped service may never answer its pending disposal RPC.
    const disposal = context.dispose().catch((error: unknown) => {
      this.onDiagnostic(`Compiler context disposal failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
      throw error;
    });
    return Promise.race([disposal, this.nativeServiceStopped.promise]);
  }

  retire() {
    // Native disposal remains owned and observed, but cannot hold a user reload hostage.
    void this.close().catch((error: unknown) => {
      this.onDiagnostic(`Compiler retirement failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
    });
  }

  isRetirement(error: unknown) {
    return this.generation.signal.aborted && error === this.generation.signal.reason;
  }

  async suspend() {
    this.publishing = false;
    await this.publicationTail;
  }

  async resumeAfterFailedReload() {
    this.generation.signal.throwIfAborted();
    this.publishing = true;
    await this.publishOutput();
  }

  retainPublishedGeneration(generation: WorkbenchFrontendGeneration | null) {
    this.javascriptGeneration = generation?.javascript ?? null;
    this.stylesheetGeneration = generation?.stylesheet ?? null;
  }

  getFrontendGeneration(): WorkbenchFrontendGeneration | null {
    if (!this.javascriptGeneration || !this.stylesheetGeneration) return null;
    return {
      javascript: this.javascriptGeneration,
      stylesheet: this.stylesheetGeneration,
    };
  }

  private esbuildOptions(): esbuild.BuildOptions {
    return {
      absWorkingDir: this.repositoryRootPath,
      assetNames: "assets/[name]-[hash]",
      bundle: true,
      define: {
        // Keep this separate from the process.env object so esbuild folds React's runtime branch.
        "process.env.NODE_ENV": JSON.stringify(this.readReactDevelopmentMode() ? "development" : "production"),
        "process.env": JSON.stringify({
          WORKBENCH_CODEX_APP_SERVER_PORT: this.environment.WORKBENCH_CODEX_APP_SERVER_PORT ?? "4500",
          WORKBENCH_CODEX_APP_SERVER_URL: this.environment.WORKBENCH_CODEX_APP_SERVER_URL,
          WORKBENCH_DISABLE_REACT_SCAN: this.environment.WORKBENCH_DISABLE_REACT_SCAN,
        }),
      },
      entryPoints: [path.join(this.appDirectoryPath, "browser-entry.tsx")],
      format: "esm",
      jsx: "automatic",
      loader: {
        ".gif": "file",
        ".jpeg": "file",
        ".jpg": "file",
        ".png": "file",
        ".svg": "file",
      },
      logLevel: "silent",
      outfile: path.join(this.outputDirectoryPath, "assets", "app.js"),
      platform: "browser",
      plugins: [this.esbuildLifecyclePlugin()],
      sourcemap: "linked",
      target: ["es2022"],
      write: false,
    };
  }

  private esbuildLifecyclePlugin(): esbuild.Plugin {
    let candidateGeneration = "";
    let startedAt = 0;
    return {
      name: "workbench-app-lifecycle",
      setup: (build) => {
        build.onStart(() => {
          candidateGeneration = randomUUID();
          startedAt = performance.now();
        });
        build.onResolve({ filter: /^workbench-shared\/frontend-generation$/ }, () => {
          return { namespace: FRONTEND_GENERATION_NAMESPACE, path: FRONTEND_GENERATION_MODULE_SPECIFIER };
        });
        build.onLoad({ filter: /.*/, namespace: FRONTEND_GENERATION_NAMESPACE }, () => ({
          contents: [
            `export const WORKBENCH_STYLESHEET_GENERATION_PROPERTY = ${JSON.stringify(WORKBENCH_STYLESHEET_GENERATION_PROPERTY)};`,
            `export default ${JSON.stringify(candidateGeneration)};`,
          ].join("\n"),
          loader: "js",
          watchFiles: [
            path.join(this.appDirectoryPath, "globals.css"),
            path.join(this.appDirectoryPath, "tailwind.css"),
            path.join(this.repositoryRootPath, "shared", "frontend-generation.ts"),
          ],
        }));
        build.onEnd(async (result) => {
          if (this.generation.signal.aborted) return;
          if (!result.errors.length && result.outputFiles) {
            this.javascriptOutput = { generation: candidateGeneration, files: result.outputFiles };
            await this.publishOutput();
          }
          const duration = Math.max(0, performance.now() - startedAt);
          const durationText = duration < 1
            ? `${Math.round(duration * 1_000)}µs`
            : `${Math.round(duration)}ms`;
          const warnings = result.warnings.length
            ? ` with ${result.warnings.length} ${result.warnings.length === 1 ? "warning" : "warnings"}`
            : "";
          const message = result.errors.length
            ? `build failed with ${result.errors.length} ${result.errors.length === 1 ? "error" : "errors"} in ${durationText}`
            : `build finished${warnings} in ${durationText}`;
          this.logger.line("esbuild", message);
        });
      },
    };
  }

  private refreshStylesheetGeneration() {
    const signal = this.generation.signal;
    const operation = this.stylesheetGenerationTail.then(async () => {
      signal.throwIfAborted();
      const stylesheetPath = path.join(this.workingDirectoryPath, "assets", "app.css");
      const current = await readFile(stylesheetPath, "utf8");
      signal.throwIfAborted();
      const source = current.replace(STYLESHEET_GENERATION_PATTERN, "\n");
      const generation = createHash("sha256").update(source).digest("hex");
      const marker = `:root{${WORKBENCH_STYLESHEET_GENERATION_PROPERTY}:${generation}}`;
      const sourceMapIndex = source.lastIndexOf("/*# sourceMappingURL=");
      const next = sourceMapIndex < 0
        ? `${source.trimEnd()}\n${marker}\n`
        : `${source.slice(0, sourceMapIndex).trimEnd()}\n${marker}\n${source.slice(sourceMapIndex)}`;
      const sourceMap = await readFile(`${stylesheetPath}.map`);
      signal.throwIfAborted();
      this.stylesheetOutput = { generation, contents: next, sourceMap };
      await this.publishOutput();
    });
    this.stylesheetGenerationTail = operation.catch(() => undefined);
    return operation;
  }

  private async prepareStaticOutput() {
    await mkdir(path.join(this.workingDirectoryPath, "assets"), { recursive: true });
    if (this.generation.signal.aborted) {
      await rm(this.workingDirectoryPath, { recursive: true, force: true });
      this.generation.signal.throwIfAborted();
    }
  }

  private publishOutput() {
    const javascript = this.javascriptOutput;
    const stylesheet = this.stylesheetOutput;
    if (!javascript || !stylesheet || !this.publishing || this.generation.signal.aborted) return Promise.resolve();
    const publication = this.publicationTail.then(async () => {
      if (!this.publishing || this.generation.signal.aborted) return;
      if (!this.staticPublished) {
        await cp(this.staticDirectoryPath, this.outputDirectoryPath, { recursive: true });
        this.staticPublished = true;
      }
      for (const file of javascript.files) {
        await mkdir(path.dirname(file.path), { recursive: true });
        await writeFile(file.path, file.contents);
      }
      const stylesheetPath = path.join(this.outputDirectoryPath, "assets", "app.css");
      await writeFile(stylesheetPath, stylesheet.contents, "utf8");
      await writeFile(`${stylesheetPath}.map`, stylesheet.sourceMap);
      this.javascriptGeneration = javascript.generation;
      this.stylesheetGeneration = stylesheet.generation;
    });
    this.publicationTail = publication.catch(() => undefined);
    return publication;
  }

  private tailwindArguments(watch: boolean) {
    return [
      tailwindCliPath,
      "--input",
      path.join(this.appDirectoryPath, "tailwind.css"),
      "--output",
      path.join(this.workingDirectoryPath, "assets", "app.css"),
      "--cwd",
      this.appDirectoryPath,
      "--map",
      path.join(this.workingDirectoryPath, "assets", "app.css.map"),
      ...(watch ? ["--watch=always"] : []),
    ];
  }

  private async runTailwindOnce() {
    this.generation.signal.throwIfAborted();
    const child = this.spawnTailwind(this.tailwindArguments(false), {
      cwd: this.repositoryRootPath,
      env: this.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    child.once("error", () => { if (!child.pid) this.children.delete(child); });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk.toString();
    });
    const exitCode = await waitForExit(child);
    if (exitCode !== 0) {
      throw new Error(`Tailwind compilation failed with exit code ${exitCode}.\n${boundedOutput(output)}`);
    }
  }

  private startTailwindWatcher() {
    this.generation.signal.throwIfAborted();
    const child = this.spawnTailwind(this.tailwindArguments(true), {
      cwd: this.repositoryRootPath,
      env: this.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.children.add(child);
    child.once("exit", () => this.children.delete(child));
    child.once("error", () => { if (!child.pid) this.children.delete(child); });
    const stdout = this.logger.createLineStream("tailwind");
    const stderr = this.logger.createLineStream("tailwind", true);
    const observeCompletion = () => {
      let pending = "";
      return (chunk: Buffer) => {
        if (this.generation.signal.aborted) return;
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        if (!lines.some((line) => line.includes("Done in "))) return;
        void this.refreshStylesheetGeneration().catch((error) => {
          if (error === this.generation.signal.reason) return;
          this.onDiagnostic(`Tailwind generation stamping failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      };
    };
    const observeStdoutCompletion = observeCompletion();
    const observeStderrCompletion = observeCompletion();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.write(chunk);
      observeStdoutCompletion(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr.write(chunk);
      observeStderrCompletion(chunk);
    });
    child.once("error", (error) => {
      this.logger.error("tailwind", `watcher failed: ${error.message}`);
    });
    child.once("exit", (code, signal) => {
      stdout.flush();
      stderr.flush();
      if (this.tailwindWatcher !== child) return;
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 1}`;
      this.logger.error("tailwind", `watcher stopped unexpectedly after ${reason}`);
      this.tailwindWatcher = null;
    });
    return child;
  }
}
