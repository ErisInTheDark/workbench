/*
 * Exports:
 * - default GitTestFixtureCache: build immutable content-addressed Git test bundles and copy fresh disposable repositories. Keywords: git, test, fixture, cache, bundle.
 * - GitTestFixtureSpec/GitTestFixtureCopy/GitTestFixturePrepareContext: describe deterministic commit graphs, prepared scenarios, and copied repositories. Keywords: git, fixture, scenario, cleanup.
 * - GIT_TEST_FIXTURE_MANIFEST_ENV/gitTestFixtureKey: connect runner-prepared fixture copies to isolated Node test workers. Keywords: test runner, manifest, allocation, process.
 */
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { projectRoot } from "../../project";

const execFileAsync = promisify(execFile);
const CACHE_FORMAT_VERSION = 2;
export const GIT_TEST_FIXTURE_MANIFEST_ENV = "WORKBENCH_GIT_TEST_FIXTURE_MANIFEST";
const inFlightTemplates = new Map<string, Promise<string>>();
interface PreparedFixtureSlot {
  bundleRoot: string;
  root: string;
  state: object;
  storageRootPath: string;
  temporaryRoot: string;
}

interface PreparedFixtureManifest {
  fixtures: Record<string, Record<string, PreparedFixtureSlot[]>>;
  version: 1;
}

let loadedManifest: Promise<PreparedFixtureManifest> | null = null;
let loadedManifestPath: string | null = null;

type EmptyFixtureState = Record<string, never>;

export interface GitTestFixturePrepareContext {
  bundleRoot: string;
  repositoryRoot: string;
  runGit: (
    args: string[],
    options?: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => Promise<string>;
}

export interface GitTestFixtureSpec<State extends object = EmptyFixtureState> {
  commits: Array<{
    files: Record<string, string | null>;
    message: string;
  }>;
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

interface FixtureDescriptor {
  commits: Array<{
    files: Array<[string, string | null]>;
    message: string;
  }>;
  formatVersion: number;
  name: string;
  prepared: boolean;
  revision: number;
}

function descriptor<State extends object>(spec: GitTestFixtureSpec<State>): FixtureDescriptor {
  const name = String(spec.name ?? "").trim();
  if (!name) throw new Error("A Git test fixture name is required.");
  if (!spec.commits.length) throw new Error("A Git test fixture requires at least one commit.");
  const revision = spec.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("A Git test fixture revision must be a positive integer.");
  }
  return {
    commits: spec.commits.map((commit) => ({
      files: Object.entries(commit.files).sort(([left], [right]) => left.localeCompare(right)),
      message: commit.message,
    })),
    formatVersion: CACHE_FORMAT_VERSION,
    name,
    prepared: spec.prepare !== undefined,
    revision,
  };
}

function cacheKey(value: FixtureDescriptor) {
  const name = value.name.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "fixture";
  const hash = createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 20);
  return `${name}-${hash}`;
}

export function gitTestFixtureKey<State extends object>(spec: GitTestFixtureSpec<State>) {
  return cacheKey(descriptor(spec));
}

async function preparedManifest() {
  const manifestPath = process.env[GIT_TEST_FIXTURE_MANIFEST_ENV]?.trim() ?? "";
  if (!manifestPath) return null;
  if (loadedManifest && loadedManifestPath === manifestPath) return await loadedManifest;
  loadedManifestPath = manifestPath;
  loadedManifest = fs.readFile(manifestPath, "utf8").then((contents) => {
    const parsed = JSON.parse(contents) as Partial<PreparedFixtureManifest>;
    if (parsed.version !== 1 || !parsed.fixtures || typeof parsed.fixtures !== "object") {
      throw new Error("The prepared Git test fixture manifest is invalid.");
    }
    return parsed as PreparedFixtureManifest;
  });
  return await loadedManifest;
}

function isWithin(candidate: string, root: string) {
  const normalizedCandidate = path.resolve(candidate).toLowerCase();
  const normalizedRoot = path.resolve(root).toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`);
}

async function runGit(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return (await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env,
    windowsHide: true,
  })).stdout;
}

export default class GitTestFixtureCache {
  constructor(
    private readonly root = path.join(projectRoot, ".workbench", "test-fixtures", "git"),
  ) {}

  async copy<State extends object = EmptyFixtureState>(spec: GitTestFixtureSpec<State>): Promise<GitTestFixtureCopy<State>> {
    const manifest = await preparedManifest();
    if (manifest) return await this.claimPreparedCopy(manifest, spec);
    return await this.copyFresh(spec);
  }

  async copyFresh<State extends object = EmptyFixtureState>(spec: GitTestFixtureSpec<State>): Promise<GitTestFixtureCopy<State>> {
    const templateRepository = await this.template(spec);
    const templateRoot = path.dirname(path.dirname(templateRepository));
    const templateBundle = path.join(templateRoot, "bundle");
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-git-fixture-copy-"));
    const bundleRoot = path.join(temporaryRoot, "bundle");
    try {
      await fs.cp(templateBundle, bundleRoot, { errorOnExist: true, force: false, recursive: true });
      const state = JSON.parse(await fs.readFile(path.join(templateRoot, "state.json"), "utf8")) as State;
      return {
        bundleRoot,
        dispose: async () => await fs.rm(temporaryRoot, { force: true, recursive: true }),
        root: path.join(bundleRoot, "repo"),
        state,
        storageRootPath: path.join(bundleRoot, "storage"),
        temporaryRoot,
      };
    } catch (error) {
      await fs.rm(temporaryRoot, { force: true, recursive: true });
      throw error;
    }
  }

  async prepareCopy<State extends object = EmptyFixtureState>(spec: GitTestFixtureSpec<State>) {
    const fixture = await this.copyFresh(spec);
    return { fixture, key: gitTestFixtureKey(spec) };
  }

  async template<State extends object = EmptyFixtureState>(spec: GitTestFixtureSpec<State>) {
    const fixtureDescriptor = descriptor(spec);
    const key = cacheKey(fixtureDescriptor);
    const templateRoot = path.join(this.root, key);
    const inFlightKey = `${this.root}\0${key}`;
    const existing = inFlightTemplates.get(inFlightKey);
    if (existing) return await existing;
    const pending = this.ensureTemplate(templateRoot, fixtureDescriptor, spec).finally(() => {
      if (inFlightTemplates.get(inFlightKey) === pending) inFlightTemplates.delete(inFlightKey);
    });
    inFlightTemplates.set(inFlightKey, pending);
    return await pending;
  }

  private async buildTemplate<State extends object>(
    stagingRoot: string,
    fixtureDescriptor: FixtureDescriptor,
    spec: GitTestFixtureSpec<State>,
  ) {
    const bundleRoot = path.join(stagingRoot, "bundle");
    const repositoryRoot = path.join(bundleRoot, "repo");
    await fs.mkdir(repositoryRoot, { recursive: true });
    await runGit(repositoryRoot, ["init", "-b", "main"]);
    await runGit(repositoryRoot, ["config", "user.name", "Workbench Fixture"]);
    await runGit(repositoryRoot, ["config", "user.email", "fixture@workbench.invalid"]);
    await runGit(repositoryRoot, ["config", "core.autocrlf", "false"]);
    for (const [index, commit] of fixtureDescriptor.commits.entries()) {
      for (const [relativePath, contents] of commit.files) {
        const filePath = path.resolve(repositoryRoot, relativePath);
        if (!relativePath || !isWithin(filePath, repositoryRoot) || filePath === repositoryRoot) {
          throw new Error(`Git fixture path must stay inside the repository: ${relativePath}`);
        }
        if (contents === null) await fs.rm(filePath, { force: true });
        else {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, contents, "utf8");
        }
      }
      await runGit(repositoryRoot, ["add", "-A"]);
      const timestamp = `${946684800 + index} +0000`;
      await runGit(repositoryRoot, ["commit", "--quiet", "-m", commit.message], {
        ...process.env,
        GIT_AUTHOR_DATE: timestamp,
        GIT_COMMITTER_DATE: timestamp,
      });
    }
    const state = spec.prepare
      ? await spec.prepare({
          bundleRoot,
          repositoryRoot,
          runGit: async (args, options = {}) => await runGit(
            options.cwd ?? repositoryRoot,
            args,
            options.env ?? process.env,
          ),
        })
      : {};
    await runGit(repositoryRoot, ["fsck", "--strict"]);
    await fs.writeFile(path.join(stagingRoot, "state.json"), `${JSON.stringify(state)}\n`, "utf8");
    await fs.writeFile(
      path.join(stagingRoot, "manifest.json"),
      `${JSON.stringify(fixtureDescriptor)}\n`,
      "utf8",
    );
  }

  private async ensureTemplate<State extends object>(
    templateRoot: string,
    fixtureDescriptor: FixtureDescriptor,
    spec: GitTestFixtureSpec<State>,
  ) {
    if (await this.isValidTemplate(templateRoot, fixtureDescriptor)) return path.join(templateRoot, "bundle", "repo");
    await fs.mkdir(this.root, { recursive: true });
    const stagingRoot = path.join(this.root, `.building-${process.pid}-${randomUUID()}`);
    try {
      await this.buildTemplate(stagingRoot, fixtureDescriptor, spec);
      try {
        await fs.rename(stagingRoot, templateRoot);
      } catch (error) {
        const code = error instanceof Error && "code" in error ? error.code : null;
        if (code !== "EEXIST" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      }
    } finally {
      await fs.rm(stagingRoot, { force: true, recursive: true });
    }
    if (!await this.isValidTemplate(templateRoot, fixtureDescriptor)) {
      throw new Error(`Git test fixture cache is invalid at ${templateRoot}.`);
    }
    return path.join(templateRoot, "bundle", "repo");
  }

  private async isValidTemplate(templateRoot: string, fixtureDescriptor: FixtureDescriptor) {
    try {
      const manifest = await fs.readFile(path.join(templateRoot, "manifest.json"), "utf8");
      if (manifest !== `${JSON.stringify(fixtureDescriptor)}\n`) return false;
      await fs.readFile(path.join(templateRoot, "state.json"), "utf8");
      return (await fs.stat(path.join(templateRoot, "bundle", "repo", ".git"))).isDirectory();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async claimPreparedCopy<State extends object>(
    manifest: PreparedFixtureManifest,
    spec: GitTestFixtureSpec<State>,
  ): Promise<GitTestFixtureCopy<State>> {
    const key = gitTestFixtureKey(spec);
    const testFile = path.basename(process.argv[1] ?? "");
    const slots = manifest.fixtures[testFile]?.[key];
    if (!slots?.length) throw new Error(`Git test fixture ${spec.name} was not prepared by the project test runner.`);
    const slot = slots.shift()!;
    return {
      bundleRoot: slot.bundleRoot,
      dispose: async () => undefined,
      root: slot.root,
      state: slot.state as State,
      storageRootPath: slot.storageRootPath,
      temporaryRoot: slot.temporaryRoot,
    };
  }
}
