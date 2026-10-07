/*
 * Exports:
 * - NativeArtifactStageOptions: runtime root, platform/arch validation and diagnostic boundary.
 * - NativeArtifactStageRequest: one committed artifact file set to materialize.
 * - NativeArtifactStager: minimal staging port implemented by NativeArtifactStage and test fakes.
 * - NativeArtifactStage (default): copy a committed native artifact into the data root and run that copy.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import resolveWorkbenchDataRoot from "../workbench-data-root.ts";
import { validateNativeImage, type NativeImageValidationOptions } from "./NativeArtifactPublisher.ts";

export interface NativeArtifactStageOptions extends NativeImageValidationOptions {
  runtimeRoot?: string;
  warn?: (message: string) => void;
}

export interface NativeArtifactStageRequest {
  /** Short artifact noun, such as "network"; becomes the staged directory name. */
  label: string;
  /** Committed executable to copy and run. */
  executable: string;
  /** Companion files (for example voice DLLs); defaults to the executable's directory. */
  files?: string[];
}

export interface NativeArtifactStager {
  stage(request: NativeArtifactStageRequest): Promise<string>;
}

interface StageReceipt {
  version: 1;
  key: string;
  executable: string;
  files: string[];
}

const TRANSIENT_FILE = /\.(?:retired|stage)-[0-9a-f-]+$/u;
const RECEIPT_FILE = "stage.json";

/**
 * Runtime twin of NativeArtifactPublisher: a committed binary is a build output,
 * so the running process owns a data-root copy instead of the repository file.
 * git can then freely replace the committed artifact while the process runs.
 */
export default class NativeArtifactStage implements NativeArtifactStager {
  private readonly runtimeRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly warn: (message: string) => void;

  constructor(options: NativeArtifactStageOptions = {}) {
    this.runtimeRoot = options.runtimeRoot ?? resolveWorkbenchDataRoot();
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.warn = options.warn ?? console.warn;
  }

  /** Materialize one committed artifact into the data root and return its runnable path. */
  async stage(request: NativeArtifactStageRequest): Promise<string> {
    const source = path.dirname(request.executable);
    const executableName = path.basename(request.executable);
    const names = [...(request.files ?? await fs.readdir(source))]
      .filter(name => !TRANSIENT_FILE.test(name) && name !== RECEIPT_FILE);
    if (!names.includes(executableName)) names.push(executableName);
    names.sort();

    const directory = path.join(this.runtimeRoot, "native", request.label);
    const receiptPath = path.join(directory, RECEIPT_FILE);
    const key = await this.fingerprint(source, names);
    const receipt = await this.readReceipt(receiptPath);
    if (receipt?.key === key && receipt.executable === executableName && await this.allPresent(directory, names)) {
      return path.join(directory, executableName);
    }

    await fs.mkdir(directory, { recursive: true });
    const retired: string[] = [];
    const published: string[] = [];
    try {
      for (const name of names) {
        const candidate = path.join(directory, `${name}.stage-${randomUUID()}`);
        await fs.copyFile(path.join(source, name), candidate);
        await validateNativeImage(candidate, { platform: this.platform, arch: this.arch });
        if (this.platform !== "win32" && name === executableName) await fs.chmod(candidate, 0o755);
        // A running image can be renamed aside but not deleted, so publish per file.
        const previous = path.join(directory, `${name}.retired-${randomUUID()}`);
        try { await fs.rename(path.join(directory, name), previous); retired.push(previous); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await fs.rename(candidate, path.join(directory, name));
        published.push(name);
      }
      await this.writeReceipt(receiptPath, { version: 1, key, executable: executableName, files: names });
    } catch (error) {
      const failures: unknown[] = [error];
      for (const name of [...published].reverse()) {
        try { await fs.unlink(path.join(directory, name)); }
        catch (rollbackError) { failures.push(rollbackError); }
      }
      for (const previous of [...retired].reverse()) {
        try { await fs.rename(previous, path.join(directory, path.basename(previous).replace(TRANSIENT_FILE, ""))); }
        catch (rollbackError) { failures.push(rollbackError); }
      }
      if (failures.length > 1) throw new AggregateError(failures, "Native staging failed and recovery was incomplete.");
      throw error;
    }
    await this.removeRetired(directory);
    return path.join(directory, executableName);
  }

  private async fingerprint(directory: string, names: string[]) {
    const hash = createHash("sha256");
    for (const name of names) {
      hash.update(name).update("\0");
      hash.update(await fs.readFile(path.join(directory, name))).update("\0");
    }
    return hash.digest("hex");
  }

  private async readReceipt(file: string): Promise<StageReceipt | null> {
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as StageReceipt;
      if (value?.version !== 1 || typeof value.key !== "string" || typeof value.executable !== "string"
        || !Array.isArray(value.files) || value.files.some(name => typeof name !== "string")) return null;
      return value;
    } catch {
      // A missing or malformed receipt means "not staged"; re-staging is the complete handling.
      return null;
    }
  }

  private async allPresent(directory: string, names: string[]) {
    for (const name of names) {
      try { await fs.access(path.join(directory, name)); }
      catch { return false; }
    }
    return true;
  }

  private async writeReceipt(file: string, receipt: StageReceipt) {
    const candidate = `${file}.stage-${randomUUID()}`;
    await fs.writeFile(candidate, `${JSON.stringify(receipt, null, 2)}\n`);
    await fs.rename(candidate, file);
  }

  private async removeRetired(directory: string) {
    for (const entry of await fs.readdir(directory)) {
      if (!TRANSIENT_FILE.test(entry)) continue;
      try { await fs.unlink(path.join(directory, entry)); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM") throw error;
        this.warn(`Retained running native image: ${path.join(directory, entry)}`);
      }
    }
  }
}
