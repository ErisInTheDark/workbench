/*
 * Exports:
 * - ClaimedProjectTestCommandOptions: inject claim transport, selection and execution boundaries.
 * - default ClaimedProjectTestCommand: execute local tests selected by live claims or explicit inputs.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { GitArcScopeClaimsResponseSchema } from "../shared/workbench/git/git-arc-scope-response";
import { GitCheckpointRequestSchema } from "../shared/workbench/git/checkpoint-contracts";
import ClaimedTestSelector, { type ClaimedTestSelection } from "../daemon/lib/workbench/testing/ClaimedTestSelector";
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
    if (path.relative(root, cwd)) throw new Error("wb test only works from the Workbench repository root.");
    const output = this.options.output ?? console.log;
    const usage = "Usage: wb test [--list] [-- [<file>...]]";
    if (args.length === 1 && args[0] === "--help") {
      output(`${usage}\nDefault: select companion tests from all live claims.\nAfter --: use explicit files/directories, or the full suite when empty.\n--list only prints the selection.`);
      return { exitCode: 0, signal: null };
    }
    const separator = args.indexOf("--");
    const flags = separator < 0 ? args : args.slice(0, separator);
    if (flags.some(argument => argument !== "--list")) throw new Error(usage);
    if (separator >= 0) {
      const { inputs } = parseProjectTestRunnerArguments(args.slice(separator + 1));
      if (flags.includes("--list")) {
        const files = await new ProjectTestRunner(root).discoverTestFiles(inputs);
        output(files.map(file => path.relative(root, file)).join("\n"));
        return { exitCode: 0, signal: null };
      }
      return await (this.options.run ?? (files => new ProjectTestRunner(root).run(files)))(inputs);
    }
    const env = this.options.env ?? process.env;
    const origin = new URL(env.WORKBENCH_ORIGIN ?? "");
    if (origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("WORKBENCH_ORIGIN must be a loopback HTTP origin.");
    }
    const request = GitCheckpointRequestSchema.parse({
      action: "arcScope", cwd: root, harness: env.WORKBENCH_HARNESS ?? "codex",
      threadId: env.WORKBENCH_THREAD_ID ?? env.CODEX_THREAD_ID ?? "",
    });
    const response = await (this.options.fetch ?? globalThis.fetch)(new URL("/orchestrator/git-arc", origin), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Could not read Git arc claims (HTTP ${response.status}).`);
    const parsed = GitArcScopeClaimsResponseSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Git arc scope response lacks valid repository-relative claims. Installed CLI and orchestrator must support this response.");
    const scopes = parsed.data;
    const claims = [...new Set(scopes.filter(scope => !path.relative(root, path.resolve(scope.repoRoot))).flatMap(scope => scope.claimedPaths))];
    const otherRoots = scopes.filter(scope => path.relative(root, path.resolve(scope.repoRoot)) && scope.claimedPaths.length);
    if (otherRoots.length) output(`Claims in ${otherRoots.length} other repositories are not Workbench test inputs.`);
    if (!claims.length) throw new Error("No live Workbench claims. Claim the intended files before running wb test.");
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
    return await (this.options.run ?? (files => new ProjectTestRunner(root).run(files)))(selection.files);
  }
}
