/*
 * Exports:
 * - WorkbenchAgentCliEnvironmentOptions: CLI shim environment configuration. Keywords: workbench, cli, environment, shim.
 * - default WorkbenchAgentCliEnvironment: generate cross-platform wb shims and install their loopback runtime environment. Keywords: workbench, cli, controller, path.
 */
import fs from "node:fs/promises";
import path from "node:path";

const SHIM_MARKER = "workbench-agent-cli-shim-v1";

export interface WorkbenchAgentCliEnvironmentOptions {
  cliEntryPath: string;
  origin: string;
  runtimeDirectoryPath: string;
}

function quotePosixSingle(value: string) {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function quotePowerShellSingle(value: string) {
  return `'${value.replace(/'/gu, "''")}'`;
}

export default class WorkbenchAgentCliEnvironment {
  private readonly cliEntryPath: string;
  private readonly origin: string;
  private readonly runtimeDirectoryPath: string;

  constructor({ cliEntryPath, origin, runtimeDirectoryPath }: WorkbenchAgentCliEnvironmentOptions) {
    this.cliEntryPath = path.resolve(cliEntryPath);
    this.origin = origin;
    this.runtimeDirectoryPath = path.resolve(runtimeDirectoryPath);
  }

  async install(env: NodeJS.ProcessEnv = process.env) {
    await fs.access(this.cliEntryPath);
    await fs.mkdir(this.runtimeDirectoryPath, { recursive: true });

    const posixShimPath = path.join(this.runtimeDirectoryPath, "wb");
    const powershellShimPath = path.join(this.runtimeDirectoryPath, "wb.ps1");
    const windowsShimPath = path.join(this.runtimeDirectoryPath, "wb.cmd");
    await Promise.all([
      assertManagedOrMissing(posixShimPath),
      assertManagedOrMissing(powershellShimPath),
      assertManagedOrMissing(windowsShimPath),
    ]);
    await Promise.all([
      fs.writeFile(posixShimPath, `#!/usr/bin/env sh\n# ${SHIM_MARKER}\nWORKBENCH_ORIGIN=${quotePosixSingle(this.origin)} exec node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ${quotePosixSingle(this.cliEntryPath)} "$@"\n`, "utf8"),
      fs.writeFile(powershellShimPath, `# ${SHIM_MARKER}\n$env:WORKBENCH_ORIGIN = ${quotePowerShellSingle(this.origin)}\n& node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON ${quotePowerShellSingle(this.cliEntryPath)} @args\nexit $LASTEXITCODE\n`, "utf8"),
      fs.writeFile(windowsShimPath, `@echo off\r\n@rem ${SHIM_MARKER}\r\n@set "WORKBENCH_ORIGIN=${this.origin.replace(/"/gu, '""')}"\r\nnode --disable-warning=MODULE_TYPELESS_PACKAGE_JSON "${this.cliEntryPath.replace(/"/gu, '""')}" %*\r\n`, "utf8"),
    ]);
    await fs.chmod(posixShimPath, 0o755);

    const currentPath = env.PATH ?? env.Path ?? "";
    const pathEntries = currentPath.split(path.delimiter).filter(Boolean);
    const hasRuntimePath = pathEntries.some((entry) => path.resolve(entry) === this.runtimeDirectoryPath);
    env.PATH = hasRuntimePath
      ? currentPath
      : [this.runtimeDirectoryPath, currentPath].filter(Boolean).join(path.delimiter);
    env.WORKBENCH_ORIGIN = this.origin;

    return {
      posixShimPath,
      powershellShimPath,
      windowsShimPath,
    };
  }
}

async function assertManagedOrMissing(filePath: string) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    if (!content.includes(SHIM_MARKER)) {
      throw new Error(`Refusing to replace non-Workbench command shim: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
