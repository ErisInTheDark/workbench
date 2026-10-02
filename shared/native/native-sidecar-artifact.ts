/*
 * Exports:
 * - NativeSidecarArtifact: describes one committed Go sidecar's source directory, executable name and manifest protocol.
 * - nativeSidecarSourceHash: fingerprint production Go sources and module identities in one directory.
 * - verifyNativeSidecarArtifact: return the verified current-platform executable path or throw a bounded rebuild message.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export interface NativeSidecarArtifact {
  /** Lowercase noun used in messages, such as "network". */
  label: string;
  /** Package script that republishes the artifact, such as "build:network". */
  buildScript: string;
  /** Repository-relative Go package directory holding `bin/manifest.json`. */
  source: string;
  /** Executable base name without platform extension. */
  executable: string;
  protocol: number;
}

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const artifactSchema = z.object({ file: z.string(), sha256: digest, sourceHash: digest }).strict();

export async function nativeSidecarSourceHash(directory: string): Promise<string> {
  const names = (await fs.readdir(directory))
    .filter(name => name === "go.mod" || name === "go.sum" || (name.endsWith(".go") && !name.endsWith("_test.go")))
    .sort();
  const hash = createHash("sha256");
  for (const name of names) {
    hash.update(name).update("\0");
    hash.update((await fs.readFile(path.join(directory, name), "utf8")).replaceAll("\r\n", "\n"));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export async function verifyNativeSidecarArtifact(root: string, sidecar: NativeSidecarArtifact): Promise<string> {
  const { label, buildScript } = sidecar;
  if (process.arch !== "x64" || (process.platform !== "win32" && process.platform !== "linux")) {
    throw new Error(`A bundled ${label} executable is not available for this host platform.`);
  }
  const manifestSchema = z.object({
    protocol: z.literal(sidecar.protocol),
    artifacts: z.object({ "windows-x64": artifactSchema.optional(), "linux-x64": artifactSchema.optional() }).strict(),
  }).strict();
  const source = path.join(root, sidecar.source);
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(await fs.readFile(path.join(source, "bin/manifest.json"), "utf8")));
  } catch {
    throw new Error(`The bundled ${label} manifest is missing or invalid. Run pnpm ${buildScript} from the Workbench repository.`);
  }
  const platform = process.platform === "win32" ? "windows-x64" : "linux-x64";
  const name = process.platform === "win32" ? `${sidecar.executable}.exe` : sidecar.executable;
  const artifact = manifest.artifacts[platform];
  if (!artifact || artifact.file !== `${platform}/${name}`) {
    throw new Error(`The ${label} executable for this host has not been published. Run pnpm ${buildScript} from the Workbench repository.`);
  }
  const executable = path.join(source, "bin", platform, name);
  const bytes = await fs.readFile(executable);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error(`The ${label} executable does not match its manifest.`);
  if (await nativeSidecarSourceHash(source) !== artifact.sourceHash) {
    throw new Error(`${label[0]!.toUpperCase()}${label.slice(1)} sources changed; rebuild the bundled executable.`);
  }
  return executable;
}
