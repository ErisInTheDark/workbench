/*
 * Exports:
 * - ClaimedProjectTestCommandOptions: inject claim transport, selection and execution boundaries.
 * - default ClaimedProjectTestCommand: `pnpm test`: execute local tests selected by live claims (the full suite outside
 *   agent threads) or explicit inputs, reading other threads' held paths through the caller's arc tree.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import WorkbenchArcTree from "../package/WorkbenchArcTree.mjs";
import { daemonGitArcIdentity, requestDaemonGitArc } from "../package/workbench-daemon.mjs";
import { GitArcScopeClaimsResponseSchema } from "../shared/workbench/git/git-arc-scope-response";
import WorkbenchTemporaryDirectory from "../shared/WorkbenchTemporaryDirectory";
import ClaimedTestSelector, { type ClaimedTestSelection } from "../daemon/server/lib/workbench/testing/ClaimedTestSelector";
import ProjectTestCatalog from "./ProjectTestCatalog";
import ProjectTestRunner, { parseProjectTestRunnerArguments } from "./ProjectTestRunner";

export interface ClaimedProjectTestCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  output?: (message: string) => void;
  select?: (claims: string[]) => Promise<ClaimedTestSelection>;
  run?: (files: string[]) => Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
}

export default class ClaimedProjectTestCommand {
  constructor(private readonly root: string, private readonly options: ClaimedProjectTestCommandOptions = {}) {}

  async run(args: readonly string[]) {
    const root = await realpath(this.root);
    const cwd = await realpath(this.options.cwd ?? process.cwd());
    if (path.relative(root, cwd)) throw new Error("pnpm test only works from the Workbench repository root.");
    const output = this.options.output ?? console.log;
    const usage = "Usage: pnpm test [--list] [-- [<file>...]]";
    if (args.length === 1 && args[0] === "--help") {
      output(`${usage}\nDefault: select companion tests from all live claims; outside agent threads, the full suite.\nFiles (with or without --): use explicit files/directories, or the full suite when -- is empty.\n--list only prints the selection.\nAgent runs read other threads' held paths from the caller's arc tree.`);
      return { exitCode: 0, signal: null };
    }
    const separator = args.indexOf("--");
    const flags = separator < 0 ? args : args.slice(0, separator);
    const positional = flags.filter(argument => argument !== "--list");
    if (positional.some(argument => argument.startsWith("--"))) throw new Error(usage);
    const env = this.options.env ?? process.env;
    if (separator >= 0 || positional.length || !daemonGitArcIdentity(env)) {
      const { inputs } = parseProjectTestRunnerArguments([...positional, ...separator < 0 ? [] : args.slice(separator + 1)]);
      if (flags.includes("--list")) {
        const files = await new ProjectTestRunner(root).discoverTestFiles(inputs);
        output(files.map(file => path.relative(root, file)).join("\n"));
        return { exitCode: 0, signal: null };
      }
      return await this.execute(root, env, output, inputs);
    }
    const parsed = GitArcScopeClaimsResponseSchema.safeParse(
      await requestDaemonGitArc({ action: "arcScope", cwd: root }, { env, fetch: this.options.fetch }),
    );
    if (!parsed.success) throw new Error("Git arc scope response lacks valid repository-relative claims. Installed CLI and daemon must support this response.");
    const scopes = parsed.data;
    const claims = [...new Set(scopes.filter(scope => !path.relative(root, path.resolve(scope.repoRoot))).flatMap(scope => scope.claimedPaths))];
    const otherRoots = scopes.filter(scope => path.relative(root, path.resolve(scope.repoRoot)) && scope.claimedPaths.length);
    if (otherRoots.length) output(`Claims in ${otherRoots.length} other repositories are not Workbench test inputs.`);
    if (!claims.length) throw new Error("No live Workbench claims. Claim the intended files before running pnpm test.");
    const selection = await (this.options.select ?? (async paths => {
      const catalog = await ProjectTestCatalog.read(root);
      catalog.validate();
      return (await ClaimedTestSelector.load(catalog)).select(paths);
    }))(claims);
    output(`Selected ${selection.files.length} tests from ${claims.length} claims.\nReload scopes: ${selection.scopes.join(", ") || "(none)"}`);
    if (args.includes("--list")) {
      output(selection.files.map(file => path.relative(root, file)).join("\n"));
      return { exitCode: 0, signal: null };
    }
    return await this.execute(root, env, output, selection.files);
  }

  private async execute(root: string, env: NodeJS.ProcessEnv, output: (message: string) => void, files: string[]) {
    if (this.options.run) return await this.options.run(files);
    await using tree = await WorkbenchArcTree.load({ cwd: root, env, fetch: this.options.fetch, warn: output });
    const deleted = tree.deletedOnDisk.map(target => path.relative(root, target).replaceAll("\\", "/"));
    if (deleted.length) output(`arc tree: other threads deleted these files on disk, so tests can't see your baseline copies: ${deleted.join(", ")}`);
    const environment = await tree.nodeEnvironment({ env, directory: WorkbenchTemporaryDirectory.rootPath });
    return await new ProjectTestRunner(root, { environment }).run(files);
  }
}
