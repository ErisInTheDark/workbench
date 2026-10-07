/*
 * Exports:
 * - WorkbenchToolAdmissionOptions: bind authoritative identity, policy, approval and execution owners.
 * - default WorkbenchToolAdmissionController: admit one provider tool call without owning pending interactions; `prepareShell` prepares the Workbench-hosted shell for escalating providers.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkbenchEscalatingShellInput } from "workbench-shared/workbench/commands/workbench-shell-command";
import type { WorkbenchItemId, WorkbenchTurnId } from "workbench-shared/workbench/identity";
import type { WorkbenchApprovalDecision, WorkbenchApprovalSubject } from "workbench-shared/workbench/provider/provider-approval";
import type {
  ProviderToolMetadata, ProviderToolRequestContext, WorkbenchAdmittedExecution, WorkbenchPreparedShell, WorkbenchProviderCaller,
  WorkbenchProviderTools, WorkbenchShellRun,
} from "./provider-execution";
import { prepareWorkbenchShellExecution } from "./CodexShellController";
import { isPathWithinRoot } from "./lib/project";
import { isDaemonWorkspacePath } from "./lib/daemon-workspace-paths";

export interface WorkbenchToolAdmissionOptions {
  caller: WorkbenchProviderCaller;
  resolve(signal: AbortSignal): Promise<{
    caller: WorkbenchProviderCaller;
    writableRoots: string[];
    network: boolean;
  }>;
  approve(request: {
    caller: WorkbenchProviderCaller;
    subject: Extract<WorkbenchApprovalSubject, { kind: "command" }>;
    itemId: WorkbenchItemId | null;
    turnId: WorkbenchTurnId | null;
  }, signal: AbortSignal): Promise<WorkbenchApprovalDecision>;
  prepare: NonNullable<WorkbenchProviderTools["prepareExecution"]>;
  canonicalize?: (path: string) => Promise<string>;
  /** Whether a bound root may run commands in any directory; defaults to the daemon workspace. */
  isUnboundedRoot?: (root: string) => boolean;
}

const MAX_APPROVAL_COMMAND_LENGTH = 4000;

function quoteArgument(value: string, posix: boolean) {
  if (value && !/[\s'"]/u.test(value)) return value;
  return posix ? `'${value.replaceAll("'", "'\\''")}'` : `'${value.replaceAll("'", "''")}'`;
}

/** One reviewable command line in the launcher shape approval rules and renderers already parse. */
function formatApprovalCommand(argv: readonly string[]) {
  const posix = !/(?:^|[\\/])(?:pwsh|powershell)(?:\.exe)?$/iu.test(argv[0] ?? "");
  return argv.map(value => quoteArgument(value, posix)).join(" ");
}

export default class WorkbenchToolAdmissionController {
  constructor(private readonly options: WorkbenchToolAdmissionOptions) {}

  private unboundedWorkdir(root: string) {
    return (this.options.isUnboundedRoot ?? isDaemonWorkspacePath)(root);
  }

  /**
   * The shell tool for providers that escalate through Workbench approval: the provider only names the trusted
   * caller and prepares the admitted command for its sandbox; Workbench owns admission and the approval wait.
   */
  static async prepareShell(owners: {
    tools: Pick<WorkbenchProviderTools, "caller" | "prepareExecution">;
    approve: WorkbenchToolAdmissionOptions["approve"];
    canonicalize?: WorkbenchToolAdmissionOptions["canonicalize"];
  }, input: WorkbenchEscalatingShellInput, metadata: ProviderToolMetadata, signal: AbortSignal, context?: ProviderToolRequestContext): Promise<WorkbenchPreparedShell> {
    const { tools } = owners;
    if (!tools.prepareExecution) throw new Error("This provider cannot run Workbench-admitted commands.");
    const prepare = tools.prepareExecution.bind(tools);
    const caller = await tools.caller(metadata, signal, context);
    const prepared = prepareWorkbenchShellExecution(input, caller.cwd);
    const admission = new WorkbenchToolAdmissionController({
      caller,
      resolve: async resolveSignal => ({
        caller: await tools.caller(metadata, resolveSignal, context),
        writableRoots: [caller.cwd], network: false,
      }),
      approve: owners.approve,
      prepare,
      ...(owners.canonicalize ? { canonicalize: owners.canonicalize } : {}),
    });
    const run = await admission.admit({
      ...prepared,
      ...(context?.itemId ? { itemId: context.itemId } : {}),
      ...(context?.turnId ? { turnId: context.turnId } : {}),
    }, signal);
    return { run, cwd: prepared.cwd, shell: prepared.shell };
  }

  async admit(input: {
    command: string[];
    cwd?: string;
    outsideSandbox?: boolean;
    justification?: string;
    timeoutMs?: number;
    expensive?: boolean;
    itemId?: WorkbenchItemId;
    turnId?: WorkbenchTurnId;
  }, signal: AbortSignal): Promise<WorkbenchShellRun> {
    signal.throwIfAborted();
    const command = [...input.command];
    if (!command.length || !command[0]?.trim() || command.some(arg => arg.includes("\0"))) {
      throw new Error("Tool execution requires a valid command.");
    }
    const outsideSandbox = input.outsideSandbox === true;
    const timeoutMs = input.timeoutMs;
    const requestedCwd = input.cwd;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
      throw new Error("A command deadline must be a positive integer.");
    }
    const resolved = await this.options.resolve(signal);
    const caller = { ...resolved.caller };
    if (caller.threadId !== this.options.caller.threadId || caller.harness !== this.options.caller.harness) {
      throw new Error("Tool execution caller no longer matches its provider binding.");
    }
    const canonicalize = this.options.canonicalize ?? fs.realpath;
    const [boundRoot, currentRoot] = await Promise.all([
      canonicalize(this.options.caller.cwd), canonicalize(caller.cwd),
    ]);
    if (!isPathWithinRoot(boundRoot, currentRoot) || !isPathWithinRoot(currentRoot, boundRoot)) {
      throw new Error("Tool execution caller changed its bound working directory.");
    }
    const cwd = await canonicalize(path.resolve(currentRoot, requestedCwd ?? "."));
    // Daemon-project threads analyse the whole machine; their sandbox still only writes the daemon workspace.
    if (!isPathWithinRoot(cwd, currentRoot) && !this.unboundedWorkdir(boundRoot)) {
      throw new Error("Tool working directory is outside its bound project.");
    }
    const writableRoots = await Promise.all(resolved.writableRoots.map(root => canonicalize(root)));
    signal.throwIfAborted();
    let permissions: WorkbenchAdmittedExecution["permissions"] = {
      mode: "restricted", writableRoots, network: resolved.network,
    };
    if (outsideSandbox) {
      const line = formatApprovalCommand(command);
      if (line.length > MAX_APPROVAL_COMMAND_LENGTH) throw new Error("Outside-sandbox command is too long to review safely.");
      const decision = await this.options.approve({
        caller: { ...caller },
        subject: {
          kind: "command", command: line, cwd, commandActions: [],
          justification: input.justification?.trim() || null, networkTarget: null,
          rememberable: true, suggestedPrefixes: [],
        },
        itemId: input.itemId ?? null,
        turnId: input.turnId ?? null,
      }, signal);
      signal.throwIfAborted();
      if (decision.kind === "decline") throw new Error(decision.feedback ?? "Outside-sandbox execution was declined.");
      permissions = { mode: "approved-unrestricted" };
    }
    signal.throwIfAborted();
    return await this.options.prepare({
      caller, command, cwd, permissions, timeoutMs, ...(input.expensive ? { expensive: true } : {}),
    }, signal);
  }
}
