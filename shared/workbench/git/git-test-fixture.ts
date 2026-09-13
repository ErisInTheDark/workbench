/*
 * Exports:
 * - GitTestFixtureSpec/GitTestFixtureCopy/GitTestFixturePrepareContext: fixture preparation and copy contracts.
 * - GitTestFixtureDescriptor/describeGitTestFixture/gitTestFixtureKey: stable fixture identity and cache format.
 * - GIT_TEST_FIXTURE_MANIFEST_ENV/claimPreparedGitTestFixture: claim runner-allocated repositories once per worker.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const GIT_TEST_FIXTURE_MANIFEST_ENV = "WORKBENCH_GIT_TEST_FIXTURE_MANIFEST";
const CACHE_FORMAT_VERSION = 2;
type EmptyFixtureState = Record<string, never>;

export interface GitTestFixturePrepareContext {
  bundleRoot: string;
  repositoryRoot: string;
  runGit: (args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<string>;
}

export interface GitTestFixtureSpec<State extends object = EmptyFixtureState> {
  commits: Array<{ files: Record<string, string | null>; message: string }>;
  name: string;
  prepare?: (context: GitTestFixturePrepareContext) => Promise<State>;
  revision?: number;
}

export interface GitTestFixtureCopy<State extends object = EmptyFixtureState> {
  bundleRoot: string;
  dispose: () => Promise<void>;
  root: string;
  state: State;
  storageRootPath: string;
  temporaryRoot: string;
}

export interface GitTestFixtureDescriptor {
  commits: Array<{ files: Array<[string, string | null]>; message: string }>;
  formatVersion: number;
  name: string;
  prepared: boolean;
  revision: number;
}

interface PreparedFixtureManifest {
  fixtures: Record<string, Record<string, Array<Omit<GitTestFixtureCopy<object>, "dispose">>>>;
  version: 1;
}

let loadedManifest: Promise<PreparedFixtureManifest> | null = null;
let loadedManifestPath: string | null = null;

export function describeGitTestFixture<State extends object>(spec: GitTestFixtureSpec<State>): GitTestFixtureDescriptor {
  const name = String(spec.name ?? "").trim();
  if (!name) throw new Error("A Git test fixture name is required.");
  const revision = spec.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("A Git test fixture revision must be a positive integer.");
  }
  return {
    commits: spec.commits.map(commit => ({
      files: Object.entries(commit.files).sort(([left], [right]) => left.localeCompare(right)),
      message: commit.message,
    })),
    formatVersion: CACHE_FORMAT_VERSION,
    name,
    prepared: spec.prepare !== undefined,
    revision,
  };
}

export function gitTestFixtureKey<State extends object>(spec: GitTestFixtureSpec<State>) {
  const value = describeGitTestFixture(spec);
  const name = value.name.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "fixture";
  const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
  return `${name}-${hash}`;
}

async function preparedManifest() {
  const manifestPath = process.env[GIT_TEST_FIXTURE_MANIFEST_ENV]?.trim() ?? "";
  if (!manifestPath) throw new Error("A runner-prepared Git test fixture manifest is required.");
  if (loadedManifest && loadedManifestPath === manifestPath) return await loadedManifest;
  loadedManifestPath = manifestPath;
  loadedManifest = fs.readFile(manifestPath, "utf8").then(contents => {
    const parsed = JSON.parse(contents) as Partial<PreparedFixtureManifest>;
    if (parsed.version !== 1 || !parsed.fixtures || typeof parsed.fixtures !== "object") {
      throw new Error("The prepared Git test fixture manifest is invalid.");
    }
    return parsed as PreparedFixtureManifest;
  });
  return await loadedManifest;
}

export async function claimPreparedGitTestFixture<State extends object = EmptyFixtureState>(
  spec: GitTestFixtureSpec<State>,
): Promise<GitTestFixtureCopy<State>> {
  const manifest = await preparedManifest();
  const key = gitTestFixtureKey(spec);
  const testFile = path.basename(process.argv[1] ?? "");
  const slots = manifest.fixtures[testFile]?.[key];
  if (!slots?.length) throw new Error(`Git test fixture ${spec.name} was not prepared by the project test runner.`);
  const slot = slots.shift()!;
  return { ...slot, dispose: async () => undefined, state: slot.state as State };
}
