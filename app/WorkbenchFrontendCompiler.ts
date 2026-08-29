/*
 * Exports:
 * - WorkbenchFrontendCompilerOptions: repository, output, environment, and diagnostic seams. Keywords: frontend, compiler, configuration.
 * - default WorkbenchFrontendCompiler: own initial esbuild/Tailwind output and both watch lifecycles. Keywords: frontend, compiler, watch, controller.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

import WorkbenchAppLogger from "./WorkbenchAppLogger.ts";

export interface WorkbenchFrontendCompilerOptions {
  environment?: NodeJS.ProcessEnv;
  logger?: WorkbenchAppLogger;
  onDiagnostic?: (message: string) => void;
  outputDirectoryPath?: string;
  repositoryRootPath?: string;
}

const moduleDirectoryPath = path.dirname(fileURLToPath(import.meta.url));
const defaultRepositoryRootPath = path.resolve(moduleDirectoryPath, "..");
const require = createRequire(import.meta.url);
const tailwindCliPath = path.join(path.dirname(require.resolve("@tailwindcss/cli/package.json")), "dist", "index.mjs");

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
  private readonly repositoryRootPath: string;
  private esbuildContext: esbuild.BuildContext | null = null;
  private tailwindWatcher: ChildProcess | null = null;

  constructor(options: WorkbenchFrontendCompilerOptions = {}) {
    this.repositoryRootPath = path.resolve(options.repositoryRootPath ?? defaultRepositoryRootPath);
    this.appDirectoryPath = path.join(this.repositoryRootPath, "app");
    this.environment = { ...process.env, ...options.environment };
    const workbenchLibraryRoot = path.resolve(
      this.environment.WORKBENCH_LIBRARY_ROOT?.trim() || path.join(os.homedir(), ".workbench"),
    );
    this.outputDirectoryPath = path.resolve(
      options.outputDirectoryPath ?? path.join(workbenchLibraryRoot, "runtime", "app"),
    );
    this.logger = options.logger ?? new WorkbenchAppLogger();
    this.onDiagnostic = options.onDiagnostic ?? ((message) => console.error(message));
  }

  async buildOnce() {
    await this.prepareStaticOutput();
    await Promise.all([
      esbuild.build(this.esbuildOptions()),
      this.runTailwindOnce(),
    ]);
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
    ]);
  }

  private esbuildOptions(): esbuild.BuildOptions {
    return {
      absWorkingDir: this.repositoryRootPath,
      alias: {
        "next/navigation": path.join(this.appDirectoryPath, "browser-navigation.ts"),
      },
      assetNames: "assets/[name]-[hash]",
      bundle: true,
      define: {
        "process.env": JSON.stringify({
          NEXT_PUBLIC_CODEX_APP_SERVER_PORT: this.environment.NEXT_PUBLIC_CODEX_APP_SERVER_PORT ?? "4500",
          NEXT_PUBLIC_CODEX_APP_SERVER_URL: this.environment.NEXT_PUBLIC_CODEX_APP_SERVER_URL,
          NEXT_PUBLIC_DISABLE_REACT_SCAN: this.environment.NEXT_PUBLIC_DISABLE_REACT_SCAN,
          NEXT_PUBLIC_LOCAL_WORKBENCH_ORIGIN: this.environment.NEXT_PUBLIC_LOCAL_WORKBENCH_ORIGIN,
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
      plugins: [this.esbuildLoggingPlugin()],
      sourcemap: "linked",
      target: ["es2022"],
    };
  }

  private esbuildLoggingPlugin(): esbuild.Plugin {
    let startedAt = 0;
    return {
      name: "workbench-app-logging",
      setup: (build) => {
        build.onStart(() => {
          startedAt = performance.now();
        });
        build.onEnd((result) => {
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

  private async prepareStaticOutput() {
    const assetsDirectoryPath = path.join(this.outputDirectoryPath, "assets");
    const tabIconsDirectoryPath = path.join(this.outputDirectoryPath, "tab-icons");
    await Promise.all([
      mkdir(assetsDirectoryPath, { recursive: true }),
      mkdir(tabIconsDirectoryPath, { recursive: true }),
    ]);
    await Promise.all([
      copyFile(path.join(this.appDirectoryPath, "index.html"), path.join(this.outputDirectoryPath, "index.html")),
      copyFile(path.join(this.appDirectoryPath, "manifest.webmanifest"), path.join(this.outputDirectoryPath, "manifest.webmanifest")),
      ...["active.png", "default.png", "questionnaire.png"].map((fileName) => copyFile(
        path.join(this.repositoryRootPath, "webapp", "public", "tab-icons", fileName),
        path.join(tabIconsDirectoryPath, fileName),
      )),
    ]);
  }

  private tailwindArguments(watch: boolean) {
    return [
      tailwindCliPath,
      "--input",
      path.join(this.appDirectoryPath, "tailwind.css"),
      "--output",
      path.join(this.outputDirectoryPath, "assets", "app.css"),
      "--cwd",
      path.join(this.repositoryRootPath, "webapp"),
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
    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => stderr.write(chunk));
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
