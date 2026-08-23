/*
 * Exports:
 * - WORKBENCH_GIT_ARC_COMMANDS: typed Git plan, arc, proposal, and restore definitions shared by CLI and MCP. Keywords: workbench, git, arc, plan, commands.
 */
import { z } from "zod";

import { parseGitArcMoveArguments, type GitArcMoveArguments } from "../git/git-arc-move-arguments";
import { normalizeOrchestratorReloadScopes, ORCHESTRATOR_RELOAD_SCOPES } from "../orchestrator-reload";
import { preservePowerShellTrailingPaths, WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand,
  postWorkbenchAgentCommand,
  type WorkbenchAgentCommandResponseKind,
} from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);
const paths = z.array(requiredText);
const requiredPaths = paths.min(1);

function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new Error("A managed Workbench thread identity is required.");
  return callerThreadId;
}

function requireCallerHarness(callerHarness: string) {
  if (callerHarness === "codex" || callerHarness === "copilot" || callerHarness === "opencode") return callerHarness;
  throw new Error("A managed Workbench harness identity is required.");
}

function baseBody(callerHarness: string, callerThreadId: string | null, cwd: string) {
  return { cwd, harness: requireCallerHarness(callerHarness), threadId: requireCallerThreadId(callerThreadId) };
}

const ordinaryPlanSchema = z.object({
  adoptPaths: paths.default([]).describe("Intentional dirty unclaimed work to adopt into this plan. Adopted paths may overlap ordinary scope; nested scope collapses to one minimal claim. Never use for sibling-owned changes or merely because raw Git output shows dirt."),
  intentDescription: z.string().default("").describe("Optional detail explaining the plan's approved intent."),
  intentName: requiredText.describe("Short name for the approved implementation intent."),
  paths: paths.default([]).describe("Ordinary inactive plan scope. Use for clean files and sibling-claimed files; planning these paths does not claim them."),
}).strict();
const planSchema = ordinaryPlanSchema.extend({
  reloadScopes: z.array(z.enum(ORCHESTRATOR_RELOAD_SCOPES)).default([]).describe("Shared runtime reload barriers required by this Workbench-project arc."),
}).strict();

function parsePlanArgs(args: string[], commandName: "Arc plan" | "Arc plan start") {
  const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: ["-m", "--adopt", "--reload-scope"] }), {
    repeatable: ["-m", "--adopt", "--reload-scope"], trailing: true,
  });
  const messages = flags.repeated("-m").map((message) => message.trim());
  if (messages.length > 2) throw new Error(`${commandName} accepts at most two -m values.`);
  if (!messages[0]) throw new Error("-m is required.");
  return {
    adoptPaths: flags.repeated("--adopt"),
    intentDescription: messages[1] ?? "",
    intentName: messages[0],
    paths: flags.trailing,
    reloadScopes: normalizeOrchestratorReloadScopes(flags.repeated("--reload-scope")),
  };
}

const plan = defineWorkbenchAgentCommand({
  description: "Create or replace this thread's inactive Git plan without claiming ordinary paths. Put clean and sibling-claimed files in paths; use adoptPaths only for intentional dirty unclaimed work, including nested work within ordinary scope.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "plan"],
  usage: "wb git arc plan -m <short-intent> [-m <optional-description>] [--reload-scope <scope>]... [--adopt <dirty-path>]... [-- <path>...]",
  inputSchema: planSchema,
  mcpInputSchema: ({ reloadScopes }) => reloadScopes ? planSchema : ordinaryPlanSchema,
  parseCliArgs: (args) => parsePlanArgs(args, "Arc plan"),
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "plan",
      ...(input.adoptPaths.length ? { adoptPaths: input.adoptPaths } : {}),
      ...baseBody(callerHarness, callerThreadId, cwd),
      intentDescription: input.intentDescription,
      intentName: input.intentName,
      paths: input.paths,
      ...(input.reloadScopes.length ? { reloadScopes: input.reloadScopes } : {}),
    }, "git-arc-plan");
  },
});

function planMutation(operation: "add" | "adopt" | "remove") {
  return defineWorkbenchAgentCommand({
    description: `${operation === "add" ? "Add clean paths to" : operation === "adopt" ? "Adopt intentional dirty unclaimed paths into" : "Remove paths from"} the current inactive plan.`,
    helpGroups: ["git-arc"],
    words: ["git", "arc", "plan", operation],
    usage: `wb git arc plan ${operation} -- <path> [<path>...]`,
    inputSchema: z.object({ paths: requiredPaths }).strict(),
    parseCliArgs(args) {
      const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: [] }), { trailing: true });
      return { paths: flags.trailing };
    },
    buildRequest(input, { callerHarness, callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/git-checkpoint", {
        action: operation === "add" ? "planAdd" : operation === "adopt" ? "planAdopt" : "planRemove",
        ...baseBody(callerHarness, callerThreadId, cwd), paths: input.paths,
      }, "git-arc-plan");
    },
  });
}

const planStart = defineWorkbenchAgentCommand({
  description: "Create and activate a plan atomically. Put clean files in paths; use adoptPaths only for intentional dirty unclaimed work, including nested work within ordinary scope, that this thread may claim now.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "plan", "start"],
  usage: "wb git arc plan start -m <short-intent> [-m <optional-description>] [--reload-scope <scope>]... [--adopt <dirty-path>]... [-- <path>...]",
  inputSchema: planSchema,
  mcpInputSchema: ({ reloadScopes }) => reloadScopes ? planSchema : ordinaryPlanSchema,
  parseCliArgs: (args) => parsePlanArgs(args, "Arc plan start"),
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "planStart", adoptPaths: input.adoptPaths,
      ...baseBody(callerHarness, callerThreadId, cwd),
      intentDescription: input.intentDescription, intentName: input.intentName, paths: input.paths,
      ...(input.reloadScopes.length ? { reloadScopes: input.reloadScopes } : {}),
    }, "git-arc-start");
  },
});

const start = defineWorkbenchAgentCommand({
  description: "Activate and compare a plan's files before implementation without creating another ref.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "start"],
  usage: "wb git arc start [--ref <ref>]",
  inputSchema: z.object({ ref: requiredText.optional() }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--ref"] });
    return { ref: flags.optional("--ref") ?? undefined };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcStart", ...(input.ref ? { checkpointCommit: input.ref } : {}), ...baseBody(callerHarness, callerThreadId, cwd),
    }, "git-arc-start");
  },
});

const continueArc = defineWorkbenchAgentCommand({
  description: "Continue an active arc or resume it after its proposal was committed.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "continue"],
  usage: "wb git arc continue --ref <last-known-ref>",
  inputSchema: z.object({ ref: requiredText }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--ref"] });
    return { ref: flags.required("--ref") };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcContinue", checkpointCommit: input.ref, ...baseBody(callerHarness, callerThreadId, cwd),
    }, "git-arc-continue");
  },
});

function activePathCommand(action: "add" | "adopt" | "remove", description: string) {
  const responseKind: WorkbenchAgentCommandResponseKind = action === "add"
    ? "git-arc-add"
    : action === "adopt"
      ? "git-arc-adopt"
      : "git-arc-remove";
  return defineWorkbenchAgentCommand({
    description,
    helpGroups: ["git-arc"],
    words: ["git", "arc", action],
    usage: `wb git arc ${action} -- <${action === "add" ? "additional" : action === "adopt" ? "dirty" : "claimed"}-path> [<path>...]`,
    inputSchema: z.object({ paths: requiredPaths }).strict(),
    parseCliArgs(args) {
      const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: [] }), { trailing: true });
      return { paths: flags.trailing };
    },
    buildRequest(input, { callerHarness, callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/git-checkpoint", {
        action: action === "add" ? "arcAdd" : action === "adopt" ? "arcAdopt" : "arcRemove",
        ...baseBody(callerHarness, callerThreadId, cwd), paths: input.paths,
      }, responseKind);
    },
  });
}

const moveSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("operands"), operands: z.array(requiredText).min(2) }).strict(),
  z.object({ kind: z.literal("maps"), mappings: z.array(z.object({ destination: requiredText, source: requiredText }).strict()).min(1) }).strict(),
  z.object({ confirm: z.boolean().default(false), kind: z.literal("regex"), pattern: requiredText, replacement: z.string(), roots: requiredPaths }).strict(),
]);

function moveToJson(move: GitArcMoveArguments): z.input<typeof moveSchema> {
  if (move.kind === "operands") return { kind: move.kind, operands: [...move.operands] };
  if (move.kind === "maps") return { kind: move.kind, mappings: move.mappings.map(({ destination, source }) => ({ destination, source })) };
  return { confirm: move.confirm, kind: move.kind, pattern: move.pattern, replacement: move.replacement, roots: [...move.roots] };
}

const move = defineWorkbenchAgentCommand({
  description: "Move paths while automatically claiming the source and destination sides in this thread's active arc.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "mv"],
  usage: "wb git arc mv (<source>... <destination> | --map <source> <destination>... | [--confirm] --regex <pattern> --replace <replacement> -- <root> [<root>...])",
  inputSchema: z.object({ move: moveSchema }).strict(),
  parseCliArgs(args) {
    const normalizedArgs = args.includes("--regex") || args.includes("--replace")
      ? preservePowerShellTrailingPaths(args, { boolean: ["--confirm"], values: ["--regex", "--replace"] })
      : args;
    return { move: moveToJson(parseGitArcMoveArguments(normalizedArgs)) };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcMove", ...baseBody(callerHarness, callerThreadId, cwd), move: input.move,
    }, "git-arc-mv");
  },
});

function inspectionCommand(action: "compare" | "diff") {
  return defineWorkbenchAgentCommand({
    description: action === "compare"
      ? "Show per-file change counts for an arc's claimed set or selected paths."
      : "Show unified diff content for an arc's claimed set or selected paths.",
    effects: { idempotent: true, readOnly: true },
    helpGroups: ["git-arc"],
    words: ["git", "arc", action],
    usage: `wb git arc ${action} [--ref <active-or-plan-ref>] [-- <path> [<path>...]]`,
    inputSchema: z.object({
      paths: paths.default([]),
      ref: requiredText.optional().describe("The current active arc ref or an inactive or historical plan ref owned by this thread."),
    }).strict(),
    parseCliArgs(args) {
      const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: ["--ref"] }), { trailing: true, values: ["--ref"] });
      return { paths: flags.trailing, ref: flags.optional("--ref") ?? undefined };
    },
    buildRequest(input, { callerHarness, callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/git-checkpoint", {
        action, ...baseBody(callerHarness, callerThreadId, cwd),
        ...(input.ref ? { checkpointCommit: input.ref } : {}),
        ...(input.paths.length ? { paths: input.paths } : {}),
      }, action === "compare" ? "git-arc-compare" : "git-arc-diff");
    },
  });
}

const propose = defineWorkbenchAgentCommand({
  description: "Create a durable editable commit proposal from an arc's claimed changes or a subset.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "propose"],
  usage: "wb git arc propose [--amend] [<proposal-id>] [--replace <proposal-id>] [-m <title> [-m <description>]] [-- <claimed-path>...]",
  inputSchema: z.object({
    amend: z.boolean().default(false),
    amendProposalId: requiredText.optional(),
    description: z.string().default(""),
    paths: paths.default([]),
    replaceProposalId: requiredText.optional(),
    title: z.string().default(""),
  }).strict().superRefine((input, context) => {
    if (input.amend && input.replaceProposalId) context.addIssue({ code: "custom", message: "amend and replaceProposalId cannot be combined." });
    if (!input.amend && !input.title.trim()) context.addIssue({ code: "custom", message: "title is required unless amend is true." });
  }),
  parseCliArgs(args) {
    const normalizedArgs = [...args];
    const amendIndex = normalizedArgs.indexOf("--amend");
    let amendProposalId: string | undefined;
    if (amendIndex >= 0 && normalizedArgs[amendIndex + 1] && !normalizedArgs[amendIndex + 1].startsWith("-")) {
      amendProposalId = normalizedArgs[amendIndex + 1];
      normalizedArgs.splice(amendIndex + 1, 1);
    }
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(normalizedArgs, { boolean: ["--amend"], values: ["-m", "--replace"] }), {
      boolean: ["--amend"], leadingDashValues: ["-m"], repeatable: ["-m"], values: ["--replace"], trailing: true,
    });
    const messages = flags.repeated("-m").map((value) => value.trim());
    if (messages.length > 2) throw new Error("Arc proposal accepts at most two -m values.");
    return {
      amend: flags.has("--amend"), amendProposalId, description: messages[1] ?? "", paths: flags.trailing,
      replaceProposalId: flags.optional("--replace") ?? undefined, title: messages[0] ?? "",
    };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "proposalCreate", amend: input.amend,
      ...(input.amendProposalId ? { amendProposalId: input.amendProposalId } : {}),
      ...baseBody(callerHarness, callerThreadId, cwd),
      description: input.description,
      ...(input.paths.length ? { paths: input.paths } : {}),
      ...(input.replaceProposalId ? { replaceProposalId: input.replaceProposalId } : {}),
      title: input.title,
    }, "git-arc-propose");
  },
});

const rescind = defineWorkbenchAgentCommand({
  description: "Rescind one pending proposal without changing the arc.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "rescind"],
  usage: "wb git arc rescind --proposal <proposal-id>",
  inputSchema: z.object({ proposalId: requiredText }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--proposal"] });
    return { proposalId: flags.required("--proposal") };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "proposalRescind", ...baseBody(callerHarness, callerThreadId, cwd), proposalId: input.proposalId,
    }, "git-arc-propose");
  },
});

const restore = defineWorkbenchAgentCommand({
  description: "Restore selected paths from an arc, or restore its full snapshot after explicit confirmation.",
  effects: { destructive: true },
  helpGroups: ["git-arc"],
  words: ["git", "arc", "restore"],
  usage: "wb git arc restore --ref <ref> (--confirm | -- <path> [<path>...])",
  inputSchema: z.object({ confirmRestore: z.boolean().default(false), paths: paths.default([]), ref: requiredText }).strict()
    .refine(({ confirmRestore, paths: selectedPaths }) => confirmRestore || selectedPaths.length > 0, { message: "Full arc restore requires confirmRestore; otherwise provide paths." }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { boolean: ["--confirm"], values: ["--ref"] }), {
      boolean: ["--confirm"], trailing: true, values: ["--ref"],
    });
    return { confirmRestore: flags.has("--confirm"), paths: flags.trailing, ref: flags.required("--ref") };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "restore", checkpointCommit: input.ref,
      ...(input.confirmRestore ? { confirmRestore: true } : {}),
      ...baseBody(callerHarness, callerThreadId, cwd),
      ...(input.paths.length ? { paths: input.paths } : {}),
    }, "git-arc-restore");
  },
});

export const WORKBENCH_GIT_ARC_COMMANDS = [
  plan,
  planMutation("add"),
  planMutation("remove"),
  planMutation("adopt"),
  planStart,
  start,
  continueArc,
  activePathCommand("add", "Continue an arc while claiming additional clean paths."),
  activePathCommand("adopt", "Adopt intentional dirty unclaimed workspace paths into this thread's active arc."),
  move,
  activePathCommand("remove", "Relinquish exact clean claims without changing working-tree files."),
  inspectionCommand("compare"),
  inspectionCommand("diff"),
  propose,
  rescind,
  restore,
] as const;
