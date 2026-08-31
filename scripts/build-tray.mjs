/*
 * Functions:
 * - runCommand: runs one inherited child command and preserves its failure.
 * - validateWindowsX64Executable: validates a file as a Windows x64 PE image.
 * - removeRetiredLauncher: removes an unlocked retired launcher and reports a live image lock.
 * - removeRetiredLaunchers: cleans retired launcher images from Cargo release storage.
 * - publishLauncher: swaps a validated release candidate into the committed launcher path with rollback.
 * - runTrayBuild: owns Cargo release build and launcher artifact publication.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRootPath = path.resolve(path.dirname(scriptPath), "..");
const trayRootPath = path.join(repositoryRootPath, "tray");
const manifestPath = path.join(trayRootPath, "Cargo.toml");
const releaseDirectoryPath = path.join(trayRootPath, "target", "release");
const builtLauncherPath = path.join(releaseDirectoryPath, "workbench-tray.exe");
const artifactDirectoryPath = path.join(trayRootPath, "bin", "windows-x64");
const artifactPath = path.join(artifactDirectoryPath, "workbench-tray.exe");
const retiredLauncherPattern = /^workbench-tray\.retired-[0-9a-f-]+\.exe$/u;

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRootPath,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(
        `${command} failed with ${signal ? `signal ${signal}` : `status ${code ?? "unknown"}`}.`,
      ));
    });
  });
}

async function validateWindowsX64Executable(filePath) {
  const file = await fs.open(filePath, "r");
  try {
    const dosHeader = Buffer.alloc(64);
    const dosRead = await file.read(dosHeader, 0, dosHeader.length, 0);
    if (dosRead.bytesRead !== dosHeader.length || dosHeader.readUInt16LE(0) !== 0x5A4D) {
      throw new Error(`Built launcher is not a Windows PE executable: ${filePath}`);
    }

    const peHeaderOffset = dosHeader.readUInt32LE(0x3C);
    const peHeader = Buffer.alloc(6);
    const peRead = await file.read(peHeader, 0, peHeader.length, peHeaderOffset);
    if (peRead.bytesRead !== peHeader.length || peHeader.readUInt32LE(0) !== 0x00004550) {
      throw new Error(`Built launcher has an invalid Windows PE header: ${filePath}`);
    }

    const machine = peHeader.readUInt16LE(4);
    if (machine !== 0x8664) {
      throw new Error(
        `Built launcher targets machine 0x${machine.toString(16).toUpperCase().padStart(4, "0")}; `
        + "expected Windows x64 machine 0x8664.",
      );
    }
  } finally {
    await file.close();
  }
}

async function removeRetiredLauncher(filePath) {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error?.code === "EBUSY" || error?.code === "EPERM") {
      console.warn(`Retained running tray image until a later build: ${filePath}`);
      return;
    }
    throw error;
  }
}

async function removeRetiredLaunchers() {
  let entries;
  try {
    entries = await fs.readdir(releaseDirectoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && retiredLauncherPattern.test(entry.name)) {
      await removeRetiredLauncher(path.join(releaseDirectoryPath, entry.name));
    }
  }
}

async function publishLauncher() {
  const publicationId = randomUUID();
  const candidatePath = path.join(
    releaseDirectoryPath,
    `workbench-tray.publish-${publicationId}.exe`,
  );
  const retiredPath = path.join(
    releaseDirectoryPath,
    `workbench-tray.retired-${publicationId}.exe`,
  );
  let retiredCurrentArtifact = false;

  await fs.copyFile(builtLauncherPath, candidatePath);
  try {
    await validateWindowsX64Executable(candidatePath);
    await fs.mkdir(artifactDirectoryPath, { recursive: true });
    try {
      await fs.rename(artifactPath, retiredPath);
      retiredCurrentArtifact = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await fs.rename(candidatePath, artifactPath);
  } catch (publicationError) {
    const recoveryErrors = [];
    if (retiredCurrentArtifact) {
      try {
        await fs.rename(retiredPath, artifactPath);
      } catch (rollbackError) {
        recoveryErrors.push(rollbackError);
      }
    }
    try {
      await fs.unlink(candidatePath);
    } catch (cleanupError) {
      if (cleanupError?.code !== "ENOENT") recoveryErrors.push(cleanupError);
    }
    if (recoveryErrors.length > 0) {
      throw new AggregateError(
        [publicationError, ...recoveryErrors],
        "Tray launcher publication failed and recovery was incomplete.",
      );
    }
    throw publicationError;
  }

  if (retiredCurrentArtifact) await removeRetiredLauncher(retiredPath);
  return await fs.stat(artifactPath);
}

async function runTrayBuild() {
  await runCommand("cargo", ["build", "--release", "--manifest-path", manifestPath]);
  await validateWindowsX64Executable(builtLauncherPath);
  await removeRetiredLaunchers();
  const artifact = await publishLauncher();
  console.log(`Updated tray/bin/windows-x64/workbench-tray.exe (${artifact.size} bytes).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  void runTrayBuild().catch((error) => {
    console.error("Workbench tray build failed.");
    console.error(error);
    process.exitCode = 1;
  });
}
