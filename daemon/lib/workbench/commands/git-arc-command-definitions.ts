/*
 * Exports:
 * - WORKBENCH_GIT_ARC_COMMANDS: typed Git plan, arc, proposal, and restore definitions shared by CLI and MCP. Keywords: workbench, git, arc, plan, commands.
 */
import { z } from "zod";

import { parseGitArcMoveArguments, type GitArcMoveArguments } from "workbench-shared/workbench/git/git-arc-move-arguments";
import { preservePowerShellTrailingPaths, WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand,
  postWorkbenchAgentCommand,
  type WorkbenchAgentCommandResponseKind,
} from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);
const paths = z.array(requiredText);
const requiredPaths = paths.min(1);
const rootPathsSchema = z.object({ paths: requiredPaths, rootId: requiredText }).strict();
const planRootSchema = z.object({ adoptPaths: paths.default([]), paths: paths.default([]), rootId: requiredText }).strict();
const memberRefSchema = z.object({ ref: requiredText, rootId: requiredText }).strict();
const scopedPathsSchema = z.object({ paths: paths.default([]), roots: z.array(rootPathsSchema).default([]) }).strict()
  .superRefine((input, context) => {
    if (!input.paths.length && !input.roots.length) context.addIssue({ code: "custom", message: "At least one path or root scope is required." });
  });

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
  roots: z.array(planRootSchema).default([]).describe("Workspace-root plan scopes for a multi-root workspace."),
}).strict();
function parsePlanArgs(args: string[], commandName: "Arc plan" | "Arc plan start") {
  const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: ["-m", "--adopt"] }), {
    repeatable: ["-m", "--adopt"], trailing: true,
  });
  const messages = flags.repeated("-m").map((message) => message.trim());
  if (messages.length > 2) throw new Error(`${commandName} accepts at most two -m values.`);
  if (!messages[0]) throw new Error("-m is required.");
  return {
    adoptPaths: flags.repeated("--adopt"),
    intentDescription: messages[1] ?? "",
    intentName: messages[0],
    paths: flags.trailing,
    roots: [],
  };
}

const plan = defineWorkbenchAgentCommand({
  description: "Create or replace this thread's inactive Git plan without claiming ordinary paths. Put clean and sibling-claimed files in paths; use adoptPaths only for intentional dirty unclaimed work, including nested work within ordinary scope.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "plan"],
  usage: "wb git arc plan -m <short-intent> [-m <optional-description>] [--adopt <dirty-path>]... [-- <path>...]",
  inputSchema: ordinaryPlanSchema,
  parseCliArgs: (args) => parsePlanArgs(args, "Arc plan"),
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "plan",
      ...(input.adoptPaths.length ? { adoptPaths: input.adoptPaths } : {}),
      ...baseBody(callerHarness, callerThreadId, cwd),
      intentDescription: input.intentDescription,
      intentName: input.intentName,
      paths: input.paths,
      ...(input.roots.length ? { roots: input.roots } : {}),
    }, "git-arc-plan");
  },
});

function planMutation(operation: "add" | "adopt" | "remove") {
  return defineWorkbenchAgentCommand({
    description: `${operation === "add" ? "Add clean paths to" : operation === "adopt" ? "Adopt intentional dirty unclaimed paths into" : "Remove paths from"} the current inactive plan.`,
    helpGroups: ["git-arc"],
    words: ["git", "arc", "plan", operation],
    usage: `wb git arc plan ${operation} -- <path> [<path>...]`,
    inputSchema: scopedPathsSchema,
    parseCliArgs(args) {
      const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: [] }), { trailing: true });
      if (!flags.trailing.length) throw new Error("At least one path is required.");
      return { paths: flags.trailing, roots: [] };
    },
    buildRequest(input, { callerHarness, callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/git-checkpoint", {
        action: operation === "add" ? "planAdd" : operation === "adopt" ? "planAdopt" : "planRemove",
        ...baseBody(callerHarness, callerThreadId, cwd), paths: input.paths,
        ...(input.roots.length ? { roots: input.roots } : {}),
      }, "git-arc-plan");
    },
  });
}

const planStart = defineWorkbenchAgentCommand({
  description: "Create and activate a plan atomically. Put clean files in paths; use adoptPaths only for intentional dirty unclaimed work, including nested work within ordinary scope, that this thread may claim now.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "plan", "start"],
  usage: "wb git arc plan start -m <short-intent> [-m <optional-description>] [--adopt <dirty-path>]... [-- <path>...]",
  inputSchema: ordinaryPlanSchema,
  parseCliArgs: (args) => parsePlanArgs(args, "Arc plan start"),
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "planStart", adoptPaths: input.adoptPaths,
      ...baseBody(callerHarness, callerThreadId, cwd),
      intentDescription: input.intentDescription, intentName: input.intentName, paths: input.paths,
      ...(input.roots.length ? { roots: input.roots } : {}),
    }, "git-arc-start");
  },
});

const start = defineWorkbenchAgentCommand({
  description: "Activate and compare a plan's files before implementation without creating another ref.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "start"],
  usage: "wb git arc start [--ref <ref>]",
  inputSchema: z.object({ ref: requiredText.optional(), refs: z.array(memberRefSchema).default([]) }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--ref"] });
    return { ref: flags.optional("--ref") ?? undefined, refs: [] };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcStart", ...(input.ref ? { checkpointCommit: input.ref } : {}),
      ...(input.refs.length ? { refs: input.refs } : {}), ...baseBody(callerHarness, callerThreadId, cwd),
    }, "git-arc-start");
  },
});

const wait = defineWorkbenchAgentCommand({
  description: "Wait until sibling claims no longer intersect the current or selected inactive plan, then start it.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "wait"],
  usage: "wb git arc wait [--ref <ref>]",
  inputSchema: z.object({ ref: requiredText.optional(), refs: z.array(memberRefSchema).default([]) }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--ref"] });
    return { ref: flags.optional("--ref") ?? undefined, refs: [] };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcWait", ...(input.ref ? { checkpointCommit: input.ref } : {}),
      ...(input.refs.length ? { refs: input.refs } : {}), ...baseBody(callerHarness, callerThreadId, cwd),
    }, "git-arc-wait");
  },
  mcpCodeModeEligible: true,
  mcpRuntimeDrainPolicy: "abort-immediately",
  mcpSteerInterruptible: true,
});

const continueArc = defineWorkbenchAgentCommand({
  description: "Continue an active arc or resume it after its proposal was committed.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "continue"],
  usage: "wb git arc continue --ref <last-known-ref>",
  inputSchema: z.object({ ref: requiredText.optional(), refs: z.array(memberRefSchema).default([]) }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--ref"] });
    return { ref: flags.required("--ref"), refs: [] };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcContinue", ...(input.ref ? { checkpointCommit: input.ref } : {}),
      ...(input.refs.length ? { refs: input.refs } : {}), ...baseBody(callerHarness, callerThreadId, cwd),
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
    inputSchema: scopedPathsSchema,
    parseCliArgs(args) {
      const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: [] }), { trailing: true });
      if (!flags.trailing.length) throw new Error("At least one path is required.");
      return { paths: flags.trailing, roots: [] };
    },
    buildRequest(input, { callerHarness, callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/git-checkpoint", {
        action: action === "add" ? "arcAdd" : action === "adopt" ? "arcAdopt" : "arcRemove",
        ...baseBody(callerHarness, callerThreadId, cwd), paths: input.paths,
        ...(input.roots.length ? { roots: input.roots } : {}),
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
  inputSchema: z.object({ move: moveSchema, rootId: requiredText.optional() }).strict(),
  parseCliArgs(args) {
    const normalizedArgs = args.includes("--regex") || args.includes("--replace")
      ? preservePowerShellTrailingPaths(args, { boolean: ["--confirm"], values: ["--regex", "--replace"] })
      : args;
    return { move: moveToJson(parseGitArcMoveArguments(normalizedArgs)), rootId: undefined };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcMove", ...baseBody(callerHarness, callerThreadId, cwd), move: input.move,
      ...(input.rootId ? { rootId: input.rootId } : {}),
    }, "git-arc-mv");
  },
});

const release = defineWorkbenchAgentCommand({
  description: "Release every live claim owned by this thread without changing Git or workspace content. Dirty claims are rejected unless disown is true.",
  effects: { destructive: true },
  helpGroups: ["git-arc"],
  words: ["git", "arc", "release"],
  usage: "wb git arc release [--disown]",
  inputSchema: z.object({
    disown: z.boolean().default(false).describe("Release ownership of dirty claims without changing their workspace or Git content."),
  }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { boolean: ["--disown"] });
    return { disown: flags.has("--disown") };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcRelease",
      ...baseBody(callerHarness, callerThreadId, cwd),
      disown: input.disown,
    }, "git-arc-release");
  },
});

function inspectionCommand(action: "compare" | "diff") {
  const valueFlags = action === "diff" ? ["--ref", "--page"] : ["--ref"];
  return defineWorkbenchAgentCommand({
    description: action === "compare"
      ? "Show per-file change counts for an arc's claimed set or selected paths."
      : "Show unified diff content for an arc's claimed set or selected paths.",
    effects: { idempotent: true, readOnly: true },
    helpGroups: ["git-arc"],
    mcpCodeModeEligible: true,
    words: ["git", "arc", action],
    usage: `wb git arc ${action} [--ref <arc-sha|proposal-id>]${action === "diff" ? " [--page <page>]" : ""} [-- <path> [<path>...]]`,
    inputSchema: z.object({
      ...(action === "diff" ? { page: z.number().int().positive().optional() } : {}),
      paths: paths.default([]),
      ref: requiredText.optional().describe("An arc SHA or proposal ID owned by this thread."),
      refs: z.array(memberRefSchema).default([]),
      roots: z.array(rootPathsSchema).default([]),
    }).strict().superRefine((input, context) => {
      if (
        action === "diff"
        && "page" in input
        && input.page !== undefined
        && (input.paths.length || input.roots.some(({ paths: rootPaths }) => rootPaths.length > 0))
      ) {
        context.addIssue({ code: "custom", message: "Git arc diff page cannot be combined with selected paths." });
      }
    }),
    parseCliArgs(args) {
      const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { values: valueFlags }), { trailing: true, values: valueFlags });
      const page = action === "diff" ? flags.optionalNonNegativeInteger("--page") : null;
      return {
        ...(page !== null ? { page } : {}),
        paths: flags.trailing,
        ref: flags.optional("--ref") ?? undefined,
        refs: [],
        roots: [],
      };
    },
    buildRequest(input, { callerHarness, callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/git-checkpoint", {
        action, ...baseBody(callerHarness, callerThreadId, cwd),
        ...("page" in input && input.page !== undefined ? { page: input.page } : {}),
        ...(input.ref ? { ref: input.ref } : {}),
        ...(input.paths.length ? { paths: input.paths } : {}),
        ...(input.refs.length ? { refs: input.refs } : {}),
        ...(input.roots.length ? { roots: input.roots } : {}),
      }, action === "compare" ? "git-arc-compare" : "git-arc-diff");
    },
  });
}

const propose = defineWorkbenchAgentCommand({
  description: "Create a durable editable commit proposal from claimed changes, including amend and fresh choices, or change an accepted proposal's message by exact id.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "propose"],
  usage: "wb git arc propose [--root <root-id>] [--amend [<proposal-id>] --fresh-title <title> [--fresh-description <description>]] [--replace <proposal-id>] [--title <title>] [--description <description>] [-- <claimed-path>...]",
  inputSchema: z.object({
    amend: z.boolean().default(false),
    amendProposalId: requiredText.optional(),
    description: z.string().default(""),
    freshDescription: z.string().optional().describe("Description to use if the content amendment is committed fresh."),
    freshTitle: requiredText.optional().describe("Required title to use if the content amendment is committed fresh."),
    paths: paths.default([]),
    replaceProposalId: requiredText.optional(),
    rootId: requiredText.optional(),
    title: z.string().default(""),
  }).strict().superRefine((input, context) => {
    if (input.amend && input.replaceProposalId) context.addIssue({ code: "custom", message: "amend and replaceProposalId cannot be combined." });
    if (!input.amend && !input.title.trim()) context.addIssue({ code: "custom", message: "title is required unless amend is true." });
    if (input.amend && !input.freshTitle) context.addIssue({ code: "custom", message: "freshTitle is required when amend is true.", path: ["freshTitle"] });
    if (!input.amend && (input.freshTitle !== undefined || input.freshDescription !== undefined)) {
      context.addIssue({ code: "custom", message: "freshTitle and freshDescription require amend.", path: ["freshTitle"] });
    }
  }),
  parseCliArgs(args) {
    const normalizedArgs = [...args];
    const amendIndex = normalizedArgs.indexOf("--amend");
    let amendProposalId: string | undefined;
    if (amendIndex >= 0 && normalizedArgs[amendIndex + 1] && !normalizedArgs[amendIndex + 1].startsWith("-")) {
      amendProposalId = normalizedArgs[amendIndex + 1];
      normalizedArgs.splice(amendIndex + 1, 1);
    }
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(normalizedArgs, {
      boolean: ["--amend"],
      values: ["--description", "--fresh-description", "--fresh-title", "--replace", "--root", "--title"],
    }), {
      boolean: ["--amend"],
      leadingDashValues: ["--description", "--fresh-description", "--fresh-title", "--title"],
      values: ["--description", "--fresh-description", "--fresh-title", "--replace", "--root", "--title"],
      trailing: true,
    });
    const freshDescription = flags.optional("--fresh-description") ?? undefined;
    const freshTitle = flags.optional("--fresh-title") ?? undefined;
    const targetedMessageOnly = Boolean(
      amendProposalId
      && !flags.trailing.length
      && freshDescription === undefined
      && freshTitle === undefined
    );
    return {
      amend: flags.has("--amend") && !targetedMessageOnly,
      amendProposalId,
      description: flags.optional("--description") ?? "",
      freshDescription,
      freshTitle,
      paths: flags.trailing,
      replaceProposalId: flags.optional("--replace") ?? undefined,
      rootId: flags.optional("--root") ?? undefined,
      title: flags.optional("--title") ?? "",
    };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "proposalCreate", amend: input.amend,
      ...(input.amendProposalId ? { amendProposalId: input.amendProposalId } : {}),
      ...baseBody(callerHarness, callerThreadId, cwd),
      description: input.description,
      ...(input.freshDescription !== undefined ? { freshDescription: input.freshDescription } : {}),
      ...(input.freshTitle ? { freshTitle: input.freshTitle } : {}),
      ...(input.paths.length ? { paths: input.paths } : {}),
      ...(input.replaceProposalId ? { replaceProposalId: input.replaceProposalId } : {}),
      ...(input.rootId ? { rootId: input.rootId } : {}),
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
  inputSchema: z.object({
    confirmRestore: z.boolean().default(false), paths: paths.default([]), ref: requiredText.optional(),
    refs: z.array(memberRefSchema).default([]), roots: z.array(rootPathsSchema).default([]),
  }).strict().refine(({ confirmRestore, paths: selectedPaths, roots }) => confirmRestore || selectedPaths.length > 0 || roots.length > 0, { message: "Full arc restore requires confirmRestore; otherwise provide paths." }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { boolean: ["--confirm"], values: ["--ref"] }), {
      boolean: ["--confirm"], trailing: true, values: ["--ref"],
    });
    return { confirmRestore: flags.has("--confirm"), paths: flags.trailing, ref: flags.required("--ref"), refs: [], roots: [] };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "restore", ...(input.ref ? { checkpointCommit: input.ref } : {}),
      ...(input.confirmRestore ? { confirmRestore: true } : {}),
      ...baseBody(callerHarness, callerThreadId, cwd),
      ...(input.paths.length ? { paths: input.paths } : {}),
      ...(input.refs.length ? { refs: input.refs } : {}),
      ...(input.roots.length ? { roots: input.roots } : {}),
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
  wait,
  continueArc,
  activePathCommand("add", "Continue an arc while claiming additional clean paths."),
  activePathCommand("adopt", "Adopt intentional dirty unclaimed workspace paths into this thread's active arc."),
  move,
  activePathCommand("remove", "Relinquish exact clean claims without changing working-tree files."),
  release,
  inspectionCommand("compare"),
  inspectionCommand("diff"),
  propose,
  rescind,
  restore,
] as const;
