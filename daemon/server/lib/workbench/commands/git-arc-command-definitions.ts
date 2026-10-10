/*
 * Exports:
 * - WORKBENCH_GIT_ARC_COMMANDS: typed planning, status, lifecycle, inspection and proposal commands shared by CLI/MCP, plus the CLI-only build view tree and edit sessions.
 */
import path from "node:path";
import { z } from "zod";
import { ProviderKeySchema } from "workbench-shared/workbench/provider/provider-key";
import { GitArcRejectionError, gitArcRejectionIssue } from "workbench-shared/workbench/git/git-arc-rejections";
import { GitArcClaimsSchema } from "workbench-shared/workbench/git/checkpoint-contracts";
import { GitArcEditOperationsSchema } from "workbench-shared/workbench/git/git-arc-edit-contracts";
import { GitArcStatusFullSchema } from "workbench-shared/workbench/git/git-arc-status";
import { parseGitClaimArguments } from "workbench-shared/workbench/git/git-claim-arguments";
import { WORKBENCH_GIT_PLAN_COMMANDS } from "./git-plan-command-definitions";
import { WORKBENCH_GIT_ARC_PROPOSAL_COMMANDS } from "./git-arc-proposal-commands";

import { preservePowerShellTrailingPaths, WorkbenchAgentCommandFlags } from "./workbench-agent-command-arguments";
import {
  defineWorkbenchAgentCommand,
  postWorkbenchAgentCommand,
} from "./workbench-agent-command-definition";
import { readGitClaimPathFile, readProjectJsonFile } from "./git-claim-path-file";

const requiredText = z.string().trim().min(1);
const paths = z.array(requiredText);
const requiredPaths = paths.min(1);
const rootPathsSchema = z.object({ paths: requiredPaths, rootId: requiredText }).strict();
const memberRefSchema = z.object({ ref: requiredText, rootId: requiredText }).strict();
const claimsCommandSchema = GitArcClaimsSchema.extend({
  pathsFile: requiredText.optional().describe("Project-relative JSON file containing addPaths, removePaths, adoptPaths and roots."),
}).strict().superRefine((input, context) => {
  if (input.pathsFile && (input.addPaths.length || input.removePaths.length || input.adoptPaths.length || input.roots.length)) {
    context.addIssue({ code: "custom", message: "pathsFile cannot be combined with inline claim arrays." });
  }
});

function parseClaimsCommandArguments(args: readonly string[]) {
  const remaining: string[] = [];
  let pathsFile: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--paths-file") {
      remaining.push(args[index]!);
      continue;
    }
    if (pathsFile !== undefined) throw new Error("--paths-file was supplied twice.");
    const value = args[++index];
    if (!value?.trim()) throw new Error("--paths-file requires a project-relative JSON file.");
    pathsFile = value;
  }
  const parsed = parseGitClaimArguments(remaining);
  return {
    addPaths: parsed.addPaths,
    removePaths: parsed.removePaths,
    adoptPaths: parsed.adoptPaths,
    inherit: true as const,
    roots: parsed.roots,
    ...(pathsFile ? { pathsFile } : {}),
  };
}

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

const editRoot = requiredText.optional().describe("Workspace root id; defaults to the caller's project root.");

function editRootFlag(args: string[], values: string[] = [], repeatable: string[] = []) {
  return new WorkbenchAgentCommandFlags(args, { repeatable, values: ["--root", ...values] });
}

const editStart = defineWorkbenchAgentCommand({
  description: "Preview an edit session of ordered moves (with path reference rewrites) and regex replacements, reporting claim intersections. Writes no files.",
  helpGroups: ["git-arc-edit"],
  hideFromMcp: true,
  words: ["git", "arc", "edit", "start"],
  usage: "wb git arc edit start (--operations-json <file> | --operations <json>) [--root <root>]",
  inputSchema: z.object({
    operations: GitArcEditOperationsSchema.optional(),
    operationsFile: requiredText.optional(),
    rootId: editRoot,
  }).strict().refine(input => (input.operations === undefined) !== (input.operationsFile === undefined), "Supply exactly one of --operations-json or --operations."),
  parseCliArgs(args) {
    const flags = editRootFlag(args, ["--operations", "--operations-json"]);
    const inline = flags.optional("--operations");
    let operations: z.input<typeof GitArcEditOperationsSchema> | undefined;
    if (inline !== null) {
      try {
        operations = JSON.parse(inline);
      } catch (error) {
        throw new Error(`--operations must be JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return { operations, operationsFile: flags.optional("--operations-json") ?? undefined, rootId: flags.optional("--root") ?? undefined };
  },
  async buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    const operations = input.operations ?? await readProjectJsonFile(cwd, input.operationsFile!, GitArcEditOperationsSchema, "edit operations");
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcEditStart", ...baseBody(callerHarness, callerThreadId, cwd), operations,
      ...(input.rootId ? { rootId: input.rootId } : {}),
    }, "git-arc-edit");
  },
});

const editView = defineWorkbenchAgentCommand({
  description: "Page through the edit session's changed files and line numbers, or diff selected files or lines.",
  effects: { idempotent: true, readOnly: true },
  helpGroups: ["git-arc-edit"],
  hideFromMcp: true,
  words: ["git", "arc", "edit", "view"],
  usage: "wb git arc edit view [--page <n>] [--diff <path>[:<line>]]... [--root <root>]",
  inputSchema: z.object({ diffs: paths.default([]), page: z.number().int().positive().default(1), rootId: editRoot }).strict(),
  parseCliArgs(args) {
    const flags = editRootFlag(args, ["--page"], ["--diff"]);
    return { diffs: flags.repeated("--diff"), page: flags.optionalNonNegativeInteger("--page") ?? 1, rootId: flags.optional("--root") ?? undefined };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcEditView", ...baseBody(callerHarness, callerThreadId, cwd), diffs: input.diffs, page: input.page,
      ...(input.rootId ? { rootId: input.rootId } : {}),
    }, "git-arc-edit");
  },
});

function editStep(step: "apply" | "revert" | "end", description: string, effects: { destructive?: boolean } = {}) {
  const action = step === "apply" ? "arcEditApply" : step === "revert" ? "arcEditRevert" : "arcEditEnd";
  return defineWorkbenchAgentCommand({
    description,
    effects: { idempotent: false, ...effects },
    helpGroups: ["git-arc-edit"],
    hideFromMcp: true,
    words: ["git", "arc", "edit", step],
    usage: `wb git arc edit ${step} [--root <root>]`,
    inputSchema: z.object({ rootId: editRoot }).strict(),
    parseCliArgs(args) {
      return { rootId: editRootFlag(args).optional("--root") ?? undefined };
    },
    buildRequest(input, { callerHarness, callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/git-checkpoint", {
        action, ...baseBody(callerHarness, callerThreadId, cwd), ...(input.rootId ? { rootId: input.rootId } : {}),
      }, "git-arc-edit");
    },
  });
}

const editApply = editStep("apply", "Wait until no other thread claims a touched Git-visible file, then recompute, claim and write the session atomically.");
const editRevert = editStep("revert", "Undo the applied session while keeping later edits; text conflicts become editable markers.", { destructive: true });
const editEnd = editStep("end", "Keep the applied session's changes (or discard a preview) and drop the session.", { destructive: true });

const release = defineWorkbenchAgentCommand({
  description: "Release clean claims, or transfer selected live claims and/or saved stash atomically to an owned subagent without changing workspace content.",
  effects: { destructive: true },
  helpGroups: ["git-arc"],
  words: ["git", "arc", "release"],
  usage: "wb git arc release [--disown] | wb git arc release --to-subagent <name> [--transfer-stash|--leave-stash] [-- <claim-path>...]",
  inputSchema: z.object({
    disown: z.boolean().default(false).describe("Release ownership of dirty claims without changing their workspace or Git content."),
    toSubagent: requiredText.optional().describe("Owned unsettled subagent receiving selected live claims."),
    paths: paths.default([]),
    transferStash: z.boolean().optional().describe("Required when saved stash exists: true transfers it; false leaves it."),
  }).strict().superRefine((input, context) => {
    if (input.toSubagent && ((!input.paths.length && input.transferStash !== true) || input.disown)
      || !input.toSubagent && (input.paths.length || input.transferStash !== undefined)) {
      context.addIssue({ code: "custom", message: "A subagent transfer requires paths or transferStash: true and cannot use disown; ordinary release accepts neither." });
    }
  }),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, {
      boolean: ["--disown", "--leave-stash", "--transfer-stash"], values: ["--to-subagent"],
    }), { boolean: ["--disown", "--leave-stash", "--transfer-stash"], trailing: true, values: ["--to-subagent"] });
    if (flags.has("--leave-stash") && flags.has("--transfer-stash")) throw new Error("Choose either --leave-stash or --transfer-stash.");
    return {
      disown: flags.has("--disown"), toSubagent: flags.optional("--to-subagent") ?? undefined, paths: flags.trailing,
      ...(flags.has("--leave-stash") ? { transferStash: false } : flags.has("--transfer-stash") ? { transferStash: true } : {}),
    };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      ...(input.toSubagent
        ? {
          action: "arcTransferClaims" as const,
          destination: { kind: "subagent" as const, name: input.toSubagent },
          paths: input.paths,
          ...(input.transferStash === undefined ? {} : { transferStash: input.transferStash }),
        }
        : { action: "arcRelease" as const }),
      ...baseBody(callerHarness, callerThreadId, cwd),
      ...(!input.toSubagent ? { disown: input.disown } : {}),
    }, "git-arc-release");
  },
});

function inspectionCommand(action: "compare" | "diff") {
  const valueFlags = action === "diff" ? ["--ref", "--page", "--thread"] : ["--ref"];
  return defineWorkbenchAgentCommand({
    description: action === "compare"
      ? "Show per-file change counts for an arc's claimed set or selected paths."
      : "Show unified diff content for the caller's or another Workbench thread's claimed set or selected paths.",
    effects: { idempotent: true, readOnly: true },
    helpGroups: ["git-arc"],
    mcpCodeModeEligible: true,
    words: ["git", "arc", action],
    usage: `wb git arc ${action}${action === "diff" ? " [--thread <id>]" : ""} [--ref <arc-sha|proposal-id>]${action === "diff" ? " [--page <page>]" : ""} [-- <path> [<path>...]]`,
    inputSchema: z.object({
      ...(action === "diff" ? { page: z.number().int().positive().optional() } : {}),
      paths: paths.default([]),
      ref: requiredText.optional().describe("An arc SHA or proposal ID owned by the selected or caller thread."),
      refs: z.array(memberRefSchema).default([]),
      roots: z.array(rootPathsSchema).default([]),
      ...(action === "diff" ? {
        threadId: requiredText.optional().describe("Workbench thread to inspect; omit for the caller."),
      } : {}),
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
        ...(action === "diff" ? { threadId: flags.optional("--thread") ?? undefined } : {}),
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
        ...("threadId" in input && input.threadId ? { targetThreadId: input.threadId } : {}),
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
  usage: "wb git arc claims --inherit [--paths-file <project-json> | -- <add-path> -<remove-path> '*<adopt-path>'...]",
  inputSchema: claimsCommandSchema,
  parseCliArgs: parseClaimsCommandArguments,
  async buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    const { pathsFile, ...inline } = input;
    const changes = pathsFile ? await readGitClaimPathFile(cwd, pathsFile) : inline;
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      ...baseBody(callerHarness, callerThreadId, cwd), action: "arcClaims", ...changes, inherit: true,
    }, "git-arc-claims");
  },
});

const adopt = defineWorkbenchAgentCommand({
  description: "Adopt complete or selected live claims. When the source has saved stash, transferStash must explicitly move or leave it. Thread IDs require explicit user instruction; names select an owned unsettled unlocked child.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "adopt"],
  usage: "wb git arc adopt (--thread <id> | --name <name>) [--transfer-stash|--leave-stash] [--release-to-subagent <name>] [-- <claim-path>...]",
  inputSchema: z.object({
    threadId: requiredText.optional(),
    name: requiredText.optional(),
    paths: paths.default([]).describe("Move only these live source claims; the source keeps its stash and other claims."),
    releaseToSubagent: requiredText.optional().describe("Owned unsettled subagent receiving the selected claims instead of the caller."),
    transferStash: z.boolean().optional().describe("Required when saved stash exists: true transfers it; false leaves it."),
  }).strict()
    .refine(input => Boolean(input.threadId) !== Boolean(input.name), "Supply exactly one threadId or name source.")
    .refine(input => !input.releaseToSubagent || input.paths.length > 0 && input.releaseToSubagent !== input.name,
      "releaseToSubagent requires paths and a different subagent than the source."),
  parseCliArgs(args) {
    const values = ["--thread", "--name", "--release-to-subagent"];
    const booleans = ["--leave-stash", "--transfer-stash"];
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { boolean: booleans, values }), {
      boolean: booleans, trailing: true, values,
    });
    if (flags.has("--leave-stash") && flags.has("--transfer-stash")) throw new Error("Choose either --leave-stash or --transfer-stash.");
    return {
      threadId: flags.optional("--thread") ?? undefined, name: flags.optional("--name") ?? undefined,
      paths: flags.trailing, releaseToSubagent: flags.optional("--release-to-subagent") ?? undefined,
      ...(flags.has("--leave-stash") ? { transferStash: false } : flags.has("--transfer-stash") ? { transferStash: true } : {}),
    };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      ...baseBody(callerHarness, callerThreadId, cwd), action: "arcAdoptSource",
      source: input.name ? { kind: "subagent", name: input.name } : { kind: "thread", threadId: input.threadId! },
      ...(input.paths.length ? { paths: input.paths } : {}),
      ...(input.releaseToSubagent ? { releaseToSubagent: { kind: "subagent" as const, name: input.releaseToSubagent } } : {}),
      ...(input.transferStash === undefined ? {} : { transferStash: input.transferStash }),
    }, "git-arc-adopt");
  },
});

function stashCommand(action: "arcStash" | "arcUnstash", word: "stash" | "unstash") {
  return defineWorkbenchAgentCommand({
    description: word === "stash"
      ? "Pause the caller's complete active arc, preserving its changes while releasing every claim."
      : "Resume the caller's complete stashed arc, reacquiring every claim before restoring its changes.",
    effects: { destructive: true },
    helpGroups: ["git-arc"],
    words: ["git", "arc", word],
    usage: `wb git arc ${word}`,
    inputSchema: z.object({}).strict(),
    parseCliArgs(args) {
      if (args.length) throw new Error(`Git arc ${word} accepts no paths or flags.`);
      return {};
    },
    buildRequest(_input, { callerHarness, callerThreadId, cwd }) {
      return postWorkbenchAgentCommand("/api/git-checkpoint", {
        action,
        ...baseBody(callerHarness, callerThreadId, cwd),
      }, `git-arc-${word}`);
    },
  });
}

const stash = stashCommand("arcStash", "stash");
const unstash = stashCommand("arcUnstash", "unstash");

const stack = defineWorkbenchAgentCommand({
  description: "Seal all pending unsealed proposals as one titled stack layer; their result becomes the arc baseline while claims stay.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "stack"],
  usage: "wb git arc stack --title <title>",
  inputSchema: z.object({ title: requiredText.describe("Commit-message-style layer title; no description.") }).strict(),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(args, { values: ["--title"], leadingDashValues: ["--title"] });
    return { title: flags.required("--title") };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcStack", ...baseBody(callerHarness, callerThreadId, cwd), title: input.title,
    }, "git-arc-stack");
  },
});

const unstack = defineWorkbenchAgentCommand({
  description: "Reopen the caller's top stack layer when nothing builds on it, returning its proposals to ordinary pending proposals.",
  helpGroups: ["git-arc"],
  words: ["git", "arc", "unstack"],
  usage: "wb git arc unstack",
  inputSchema: z.object({}).strict(),
  parseCliArgs(args) {
    if (args.length) throw new Error("Git arc unstack accepts no paths or flags.");
    return {};
  },
  buildRequest(_input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcUnstack", ...baseBody(callerHarness, callerThreadId, cwd),
    }, "git-arc-unstack");
  },
});

const status = defineWorkbenchAgentCommand({
  description: "Read compact proposals, dirty/clean claims and unclaimed dirt for the caller or another Workbench thread. On follow-ups use status before rereading; lost claims include changes since their exact loss boundary.",
  effects: { readOnly: true, idempotent: true },
  helpGroups: ["git-arc"],
  words: ["git", "arc", "status"],
  usage: "wb git arc status [--thread <id>] [--full=dirty,clean,unclaimed-dirt]",
  inputSchema: z.object({
    full: z.array(GitArcStatusFullSchema).default([]).describe("Groups to show as complete path lists instead of counts above five."),
    threadId: requiredText.optional().describe("Workbench thread to inspect; omit for the caller."),
  }).strict(),
  parseCliArgs(args) {
    const normalized = args.flatMap(arg => arg.startsWith("--full=") ? ["--full", arg.slice(7)] : [arg]);
    const flags = new WorkbenchAgentCommandFlags(normalized, { values: ["--full", "--thread"] });
    const value = flags.optional("--full");
    return {
      full: value === null ? [] : value.split(",").map(part => GitArcStatusFullSchema.parse(part)),
      threadId: flags.optional("--thread") ?? undefined,
    };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      ...baseBody(callerHarness, callerThreadId, cwd), action: "arcStatus", full: input.full,
      ...(input.threadId ? { targetThreadId: input.threadId } : {}),
    }, "git-arc-status");
  },
});

const tree = defineWorkbenchAgentCommand({
  description: "Print JSON with a Git tree of the worktree as the caller builds it: other live threads' dirty claims at their arc baselines (stack-aware). --hold-own holds the caller's back too. --into mirrors the view's paths (all when none) into a gitignored directory inside the repository, rewriting only changed files and removing files it previously mirrored that left the view; files it didn't write are never touched.",
  effects: { idempotent: true },
  helpGroups: ["git-arc"],
  hideFromMcp: true,
  words: ["git", "arc", "tree"],
  usage: "wb git arc tree [--hold-own] [--into <ignored-dir>] [-- <path>...]",
  inputSchema: z.object({ holdOwn: z.boolean().default(false), into: requiredText.optional(), paths: paths.default([]) }).strict()
    .refine(input => input.into || !input.paths.length, "Paths select what --into mirrors; supply --into with them."),
  parseCliArgs(args) {
    const flags = new WorkbenchAgentCommandFlags(preservePowerShellTrailingPaths(args, { boolean: ["--hold-own"], values: ["--into"] }), {
      boolean: ["--hold-own"], trailing: true, values: ["--into"],
    });
    return { holdOwn: flags.has("--hold-own"), into: flags.optional("--into") ?? undefined, paths: flags.trailing };
  },
  buildRequest(input, { callerHarness, callerThreadId, cwd }) {
    return postWorkbenchAgentCommand("/api/git-checkpoint", {
      action: "arcTree", ...baseBody(callerHarness, callerThreadId, cwd), holdOwn: input.holdOwn,
      // The caller's cwd anchors a relative mirror; the daemon resolves requests from the project root.
      ...(input.into ? { into: path.resolve(cwd, input.into) } : {}),
      paths: input.paths,
    }, "json");
  },
});

export const WORKBENCH_GIT_ARC_COMMANDS = [
  ...WORKBENCH_GIT_PLAN_COMMANDS,
  start,
  wait,
  continueArc,
  claims,
  adopt,
  status,
  editStart,
  editView,
  editApply,
  editRevert,
  editEnd,
  release,
  stash,
  unstash,
  stack,
  unstack,
  inspectionCommand("compare"),
  inspectionCommand("diff"),
  tree,
  ...WORKBENCH_GIT_ARC_PROPOSAL_COMMANDS,
  rescind,
  restore,
] as const;
