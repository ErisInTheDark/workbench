/*
 * Exports:
 * - WORKBENCH_GIT_ARC_COMMANDS: typed planning, status, lifecycle, inspection and proposal commands shared by CLI/MCP.
 */
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { GitArcRejectionError, gitArcRejectionIssue } from "workbench-shared/workbench/git/git-arc-rejections";
import { GitArcClaimsSchema } from "workbench-shared/workbench/git/checkpoint-contracts";
import { GitArcStatusFullSchema } from "workbench-shared/workbench/git/git-arc-status";
import { parseGitClaimArguments } from "workbench-shared/workbench/git/git-claim-arguments";
import { WORKBENCH_GIT_PLAN_COMMANDS } from "./git-plan-command-definitions";
import { WORKBENCH_GIT_ARC_PROPOSAL_COMMANDS } from "./git-arc-proposal-commands";

import { parseGitArcMoveArguments, type GitArcMoveArguments } from "workbench-shared/workbench/git/git-arc-move-arguments";
import { preservePowerShellTrailingPaths, WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand,
  postWorkbenchAgentCommand,
} from "./workbench-agent-command-definition";

const requiredText = z.string().trim().min(1);
const paths = z.array(requiredText);
const requiredPaths = paths.min(1);
const rootPathsSchema = z.object({ paths: requiredPaths, rootId: requiredText }).strict();
const memberRefSchema = z.object({ ref: requiredText, rootId: requiredText }).strict();

function requireCallerThreadId(callerThreadId: string | null) {
  if (!callerThreadId) throw new GitArcRejectionError({ reason: "missingManagedIdentity" }, "A managed Workbench thread identity is required.");
  return callerThreadId;
}

function requireCallerHarness(callerHarness: string) {
  if (ProviderKeySchema.safeParse(callerHarness).success) return callerHarness;
  throw new GitArcRejectionError({ reason: "invalidHarness" }, "A managed Workbench harness identity is required.");
}

function baseBody(callerHarness: string, callerThreadId: string | null, cwd: string) {
  return { cwd, harness: requireCallerHarness(callerHarness), threadId: requireCallerThreadId(callerThreadId) };
}

const start = defineWorkbenchAgentCommand({
  description: "Activate the caller's plan and claim its files after checking for changes.",
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
  mcpRuntimeDrainPolicy: "preserve-across-reload",
  mcpSteerInterruptible: true,
});

const continueArc = defineWorkbenchAgentCommand({
  description: "Continue an active arc or resume it after its proposal was committed.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "continue"],
  usage: "wb git arc continue [--ref <ref>]",
  inputSchema: z.object({ ref: requiredText.optional(), refs: z.array(memberRefSchema).default([]) }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--ref"] });
    return { ref: flags.optional("--ref") ?? undefined, refs: [] };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcContinue", ...(input.ref ? { checkpointCommit: input.ref } : {}),
      ...(input.refs.length ? { refs: input.refs } : {}), ...baseBody(callerHarness, callerThreadId, cwd),
    }, "git-arc-continue");
  },
});

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
        && input.page !== undefined && input.page !== 1
        && (input.paths.length || input.roots.some(({ paths: rootPaths }) => rootPaths.length > 0))
      ) {
        context.addIssue(gitArcRejectionIssue({ reason: "selectedPathPaging" }, "Selected paths return one complete diff. Only page 1 is valid."));
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

const claims = defineWorkbenchAgentCommand({
  description: "Edit active claims atomically, including continuation checks. Inheritance is required. Adopt only intentional dirty unclaimed work.",
  helpGroups: ["git-arc"], words: ["git", "arc", "claims"],
  usage: "wb git arc claims --inherit [-- <add-path> -<remove-path> '*<adopt-path>'...]",
  inputSchema: GitArcClaimsSchema,
  parseCliArgs: (args) => ({ ...parseGitClaimArguments(args), inherit: true as const }),
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      ...baseBody(callerHarness, callerThreadId, cwd), action: "arcClaims", ...input,
    }, "git-arc-claims");
  },
});

const scope = defineWorkbenchAgentCommand({
  description: "Read scope and current proposal IDs/statuses without changing Git. Recover a lost proposal response here before retrying.",
  effects: { readOnly: true, idempotent: true }, helpGroups: ["git-arc"],
  words: ["git", "arc", "scope"], usage: "wb git arc scope",
  inputSchema: z.object({}).strict(),
  parseCliArgs(args) {
    if (args.length) throw new GitArcRejectionError({ reason: "unexpectedScopeArguments" }, "Scope reads the caller's lifecycle and accepts no parameters.");
    return {};
  },
  buildRequest(_input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      ...baseBody(callerHarness, callerThreadId, cwd), action: "arcScope",
    }, "git-arc-scope");
  },
});

const status = defineWorkbenchAgentCommand({
  description: "Read compact proposals, dirty/clean claims and unclaimed dirt. On follow-ups use status before rereading; lost claims include changes since their exact loss boundary.",
  effects: { readOnly: true, idempotent: true },
  helpGroups: ["git-arc"],
  words: ["git", "arc", "status"],
  usage: "wb git arc status [--full=dirty,clean,unclaimed-dirt]",
  inputSchema: z.object({ full: z.array(GitArcStatusFullSchema).default([]).describe("Groups to show as complete path lists instead of counts above five.") }).strict(),
  parseCliArgs(args) {
    const normalized = args.flatMap(arg => arg.startsWith("--full=") ? ["--full", arg.slice(7)] : [arg]);
    const flags = new WorkbenchAgentCommandFlags(normalized, { values: ["--full"] });
    const value = flags.optional("--full");
    return { full: value === null ? [] : value.split(",").map(part => GitArcStatusFullSchema.parse(part)) };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      ...baseBody(callerHarness, callerThreadId, cwd), action: "arcStatus", full: input.full,
    }, "git-arc-status");
  },
});

export const WORKBENCH_GIT_ARC_COMMANDS = [
  ...WORKBENCH_GIT_PLAN_COMMANDS,
  start,
  wait,
  continueArc,
  claims,
  scope,
  status,
  move,
  release,
  inspectionCommand("compare"),
  inspectionCommand("diff"),
  ...WORKBENCH_GIT_ARC_PROPOSAL_COMMANDS,
  rescind,
  restore,
] as const;
