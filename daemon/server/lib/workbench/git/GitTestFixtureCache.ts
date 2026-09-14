/*
 * Exports:
 * - default GitTestFixtureCache: build immutable Git bundles and copy fresh disposable repositories.
 * - GitTestFixtureSpec/GitTestFixtureCopy/GitTestFixturePrepareContext: shared preparation and copy contracts.
 * - GIT_TEST_FIXTURE_MANIFEST_ENV/gitTestFixtureKey: shared runner allocation protocol.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { projectRoot } from "../../project";
import WorkbenchTemporaryDirectory from "../WorkbenchTemporaryDirectory";
import {
  describeGitTestFixture,
  GIT_TEST_FIXTURE_MANIFEST_ENV,
  gitTestFixtureKey,
  type GitTestFixtureCopy,
  type GitTestFixtureDescriptor,
  type GitTestFixtureSpec,
} from "workbench-shared/workbench/git/git-test-fixture";

export {
  GIT_TEST_FIXTURE_MANIFEST_ENV,
  gitTestFixtureKey,
  type GitTestFixtureCopy,
  type GitTestFixturePrepareContext,
  type GitTestFixtureSpec,
} from "workbench-shared/workbench/git/git-test-fixture";

const execFileAsync = promisify(execFile);
const inFlightTemplates = new Map<string, Promise<string>>();
type EmptyFixtureState = Record<string, never>;

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
  private readonly root: string;
  private readonly temporaryRootPath: string;

  constructor(options: { root?: string; temporaryRootPath?: string } = {}) {
    this.root = options.root ?? path.join(projectRoot, ".workbench", "test-fixtures", "git");
    this.temporaryRootPath = options.temporaryRootPath ?? WorkbenchTemporaryDirectory.rootPath;
  }

  async copy<State extends object = EmptyFixtureState>(spec: GitTestFixtureSpec<State>): Promise<GitTestFixtureCopy<State>> {
    if (process.env[GIT_TEST_FIXTURE_MANIFEST_ENV]?.trim()) {
      // Native import shares the ESM manifest queue with direct test consumers.
      const { claimPreparedGitTestFixture } = await import("workbench-shared/workbench/git/git-test-fixture");
      return await claimPreparedGitTestFixture(spec);
    }
    return await this.copyFresh(spec);
  }

  async copyFresh<State extends object = EmptyFixtureState>(spec: GitTestFixtureSpec<State>): Promise<GitTestFixtureCopy<State>> {
    const templateRepository = await this.template(spec);
    const templateRoot = path.dirname(path.dirname(templateRepository));
    const templateBundle = path.join(templateRoot, "bundle");
    const temporaryDirectory = await WorkbenchTemporaryDirectory.create(
      "workbench-git-fixture-copy-",
      this.temporaryRootPath,
    );
    const temporaryRoot = temporaryDirectory.path;
    const bundleRoot = path.join(temporaryRoot, "bundle");
    try {
      await fs.cp(templateBundle, bundleRoot, { errorOnExist: true, force: false, recursive: true });
      const state = JSON.parse(await fs.readFile(path.join(templateRoot, "state.json"), "utf8")) as State;
      return {
        bundleRoot,
        dispose: async () => await temporaryDirectory.dispose(),
        root: path.join(bundleRoot, "repo"),
        state,
        storageRootPath: path.join(bundleRoot, "storage"),
        temporaryRoot,
      };
    } catch (error) {
      await temporaryDirectory.dispose();
      throw error;
    }
  }

  async prepareCopy<State extends object = EmptyFixtureState>(spec: GitTestFixtureSpec<State>) {
    const fixture = await this.copyFresh(spec);
    return { fixture, key: gitTestFixtureKey(spec) };
  }

  async template<State extends object = EmptyFixtureState>(spec: GitTestFixtureSpec<State>) {
    const fixtureDescriptor = describeGitTestFixture(spec);
    const key = gitTestFixtureKey(spec);
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
    fixtureDescriptor: GitTestFixtureDescriptor,
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
    fixtureDescriptor: GitTestFixtureDescriptor,
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

  private async isValidTemplate(templateRoot: string, fixtureDescriptor: GitTestFixtureDescriptor) {
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

}
