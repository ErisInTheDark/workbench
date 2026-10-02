/*
 * Exports:
 * - readDeviceIdentity: read this machine's stable OS identifier for project store key derivation; never logged.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

async function readWindows() {
  const { stdout } = await run("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"], { windowsHide: true });
  return /MachineGuid\s+REG_SZ\s+(\S+)/u.exec(stdout)?.[1] ?? "";
}

async function readMac() {
  const { stdout } = await run("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
  return /"IOPlatformUUID"\s*=\s*"([^"]+)"/u.exec(stdout)?.[1] ?? "";
}

async function readLinux() {
  for (const file of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const value = (await fs.readFile(file, "utf8")).trim();
      if (value) return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return "";
}

export async function readDeviceIdentity() {
  const value = process.platform === "win32" ? await readWindows()
    : process.platform === "darwin" ? await readMac() : await readLinux();
  if (!value) throw new Error("This device has no readable machine identifier, so the project store is unavailable.");
  return value;
}
