/*
 * Exports:
 * - WORKBENCH_LAUNCHER_ARTIFACT: committed Go `wb` launcher sidecar description.
 * - WorkbenchAgentCliEnvironmentOptions: checkout, staging and legacy shim locations.
 * - default WorkbenchAgentCliEnvironment: stage the verified launcher, put it first on agent PATH and retire earlier shell shims.
 */
import fs from "node:fs/promises";
import path from "node:path";

import { verifyNativeSidecarArtifact, type NativeSidecarArtifact } from "workbench-shared/native/native-sidecar-artifact";
import type { NativeArtifactStager } from "workbench-shared/process/NativeArtifactStage";

export const WORKBENCH_LAUNCHER_ARTIFACT: NativeSidecarArtifact = {
  label: "launcher", buildScript: "build:launcher", source: "daemon/launcher", executable: "wb", protocol: 1,
};

const LEGACY_SHIM_MARKER = "workbench-agent-cli-shim-v1";
const LEGACY_SHIM_NAMES = ["wb", "wb.cmd", "wb.ps1"] as const;

export interface WorkbenchAgentCliEnvironmentOptions {
  checkoutRoot: string;
  /** Where earlier releases wrote shell shims; only files carrying their marker are removed. */
  legacyShimDirectoryPath: string;
  /** Owns the running copy, so rebuilding the committed launcher waits for the next install. */
  stage: NativeArtifactStager;
  warn?: (message: string) => void;
}

export default class WorkbenchAgentCliEnvironment {
  private readonly checkoutRoot: string;
  private readonly legacyShimDirectoryPath: string;
  private readonly stage: NativeArtifactStager;
  private readonly warn: (message: string) => void;

  constructor({ checkoutRoot, legacyShimDirectoryPath, stage, warn = console.warn }: WorkbenchAgentCliEnvironmentOptions) {
    this.checkoutRoot = path.resolve(checkoutRoot);
    this.legacyShimDirectoryPath = path.resolve(legacyShimDirectoryPath);
    this.stage = stage;
    this.warn = warn;
  }

  async install(env: NodeJS.ProcessEnv = process.env) {
    const launcherPath = await verifyNativeSidecarArtifact(this.checkoutRoot, WORKBENCH_LAUNCHER_ARTIFACT, this.stage, {
      onSourceDrift: message => this.warn(`${message} Agents keep the last published launcher until then.`),
    });
    await Promise.all(LEGACY_SHIM_NAMES.map(name => this.retireLegacyShim(path.join(this.legacyShimDirectoryPath, name))));

    const launcherDirectory = path.dirname(launcherPath);
    const currentPath = env.PATH ?? env.Path ?? "";
    const entries = currentPath.split(path.delimiter).filter(Boolean);
    if (!entries.some(entry => path.resolve(entry) === launcherDirectory)) {
      env.PATH = [launcherDirectory, currentPath].filter(Boolean).join(path.delimiter);
    }
    env.WORKBENCH_CHECKOUT_ROOT = this.checkoutRoot;
    return { launcherPath };
  }

  private async retireLegacyShim(filePath: string) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (!content.includes(LEGACY_SHIM_MARKER)) return;
    try {
      await fs.rm(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "EPERM") throw error;
      this.warn(`Retained a running legacy wb shim until its command finishes: ${filePath}`);
    }
  }
}
