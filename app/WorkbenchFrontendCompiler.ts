/*
 * Exports:
 * - WorkbenchFrontendCompilerOptions: repository, output, environment, and diagnostic seams. Keywords: frontend, compiler, configuration.
 * - default WorkbenchFrontendCompiler: own frontend output, generation identity, and esbuild/Tailwind watch lifecycles. Keywords: frontend, compiler, watch, generation, controller.
 */
import { createHash, randomUUID } from "node:crypto";
import { type ChildProcess, spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import WorkbenchAppLogger from "./WorkbenchAppLogger.ts";
import {
  type WorkbenchFrontendGeneration,
  WORKBENCH_STYLESHEET_GENERATION_PROPERTY,
} from "workbench-shared/frontend-generation";
import resolveWorkbenchLibraryRoot from "./workbench-library-root.ts";

export interface WorkbenchFrontendCompilerOptions {
  environment?: NodeJS.ProcessEnv;
  logger?: WorkbenchAppLogger;
  onDiagnostic?: (message: string) => void;
  outputDirectoryPath?: string;
  readReactDevelopmentMode?: () => boolean;
  repositoryRootPath?: string;
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
  private readonly logger: WorkbenchAppLogger;
  private readonly onDiagnostic: (message: string) => void;
  private readonly readReactDevelopmentMode: () => boolean;
  private readonly repositoryRootPath: string;
  private readonly staticDirectoryPath: string;
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
    const workbenchLibraryRoot = resolveWorkbenchLibraryRoot(this.environment.WORKBENCH_LIBRARY_ROOT);
    this.outputDirectoryPath = path.resolve(
      options.outputDirectoryPath ?? path.join(workbenchLibraryRoot, "runtime", "app"),
    );
    this.readReactDevelopmentMode = options.readReactDevelopmentMode ?? (() => false);
    this.logger = options.logger ?? new WorkbenchAppLogger();
    this.onDiagnostic = options.onDiagnostic ?? ((message) => console.error(message));
  }

  async buildOnce() {
    await this.prepareStaticOutput();
    await Promise.all([
      esbuild.build(this.esbuildOptions()),
      this.runTailwindOnce(),
    ]);
    await this.refreshStylesheetGeneration();
    return this.outputDirectoryPath;
  }

  async startWatching() {
    if (this.esbuildContext || this.tailwindWatcher) {
      throw new Error("Workbench frontend compiler is already watching.");
    }

    await this.prepareStaticOutput();
    const context = await esbuild.context(this.esbuildOptions());
    this.esbuildContext = context;

    try {
      await Promise.all([
        context.rebuild(),
        this.runTailwindOnce(),
      ]);
      await this.refreshStylesheetGeneration();
      await context.watch();
      this.tailwindWatcher = this.startTailwindWatcher();
      return this.outputDirectoryPath;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    const context = this.esbuildContext;
    const tailwindWatcher = this.tailwindWatcher;
    this.esbuildContext = null;
    this.tailwindWatcher = null;

    if (tailwindWatcher && tailwindWatcher.exitCode === null && tailwindWatcher.signalCode === null) {
      tailwindWatcher.kill();
    }
    await Promise.all([
      context?.dispose(),
      tailwindWatcher ? waitForExit(tailwindWatcher).catch((error) => {
        if (tailwindWatcher.killed) return;
        this.onDiagnostic(`Tailwind watcher shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      }) : undefined,
      this.stylesheetGenerationTail,
    ]);
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
        build.onEnd((result) => {
          if (!result.errors.length) this.javascriptGeneration = candidateGeneration;
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
    const operation = this.stylesheetGenerationTail.then(async () => {
      const stylesheetPath = path.join(this.outputDirectoryPath, "assets", "app.css");
      const current = await readFile(stylesheetPath, "utf8");
      const source = current.replace(STYLESHEET_GENERATION_PATTERN, "\n");
      const generation = createHash("sha256").update(source).digest("hex");
      const marker = `:root{${WORKBENCH_STYLESHEET_GENERATION_PROPERTY}:${generation}}`;
      const sourceMapIndex = source.lastIndexOf("/*# sourceMappingURL=");
      const next = sourceMapIndex < 0
        ? `${source.trimEnd()}\n${marker}\n`
        : `${source.slice(0, sourceMapIndex).trimEnd()}\n${marker}\n${source.slice(sourceMapIndex)}`;
      if (next !== current) await writeFile(stylesheetPath, next, "utf8");
      this.stylesheetGeneration = generation;
    });
    this.stylesheetGenerationTail = operation.catch(() => undefined);
    return operation;
  }

  private async prepareStaticOutput() {
    const assetsDirectoryPath = path.join(this.outputDirectoryPath, "assets");
    await cp(this.staticDirectoryPath, this.outputDirectoryPath, { recursive: true });
    await mkdir(assetsDirectoryPath, { recursive: true });
  }

  private tailwindArguments(watch: boolean) {
    return [
      tailwindCliPath,
      "--input",
      path.join(this.appDirectoryPath, "tailwind.css"),
      "--output",
      path.join(this.outputDirectoryPath, "assets", "app.css"),
      "--cwd",
      this.appDirectoryPath,
      "--map",
      path.join(this.outputDirectoryPath, "assets", "app.css.map"),
      ...(watch ? ["--watch=always"] : []),
    ];
  }

  private async runTailwindOnce() {
    const child = spawn(process.execPath, this.tailwindArguments(false), {
      cwd: this.repositoryRootPath,
      env: this.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    const child = spawn(process.execPath, this.tailwindArguments(true), {
      cwd: this.repositoryRootPath,
      env: this.environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = this.logger.createLineStream("tailwind");
    const stderr = this.logger.createLineStream("tailwind", true);
    const observeCompletion = () => {
      let pending = "";
      return (chunk: Buffer) => {
        pending += chunk.toString();
        const lines = pending.split(/\r?\n/u);
        pending = lines.pop() ?? "";
        if (!lines.some((line) => line.includes("Done in "))) return;
        void this.refreshStylesheetGeneration().catch((error) => {
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
