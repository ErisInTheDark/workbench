/*
 * Keywords: Git arc, rejection reasons, validation, human messages, diagnostics.
 * Exports:
 * - GitArcRejectionSchema/GitArcRejection: bounded reason-specific rejection facts.
 * - GitArcRejectionError: preserve a semantic rejection alongside agent diagnostics.
 * - describeGitArcRejection: human wording derived only from typed facts.
 * - gitArcRejectionIssue: attach rejection facts to a Zod custom issue.
 * - readGitArcValidationRejection: recover facts from structured validation issues.
 */
import { z } from "zod";

const fact = z.string().transform((value) => value.slice(0, 2_000));
const facts = z.array(fact).transform((values) => values.slice(0, 20));
const simpleMessages = {
  inheritanceRequired: "This change needs to retain the existing claim set.",
  missingPlanName: "The plan has no name.",
  missingLifecycle: "This thread has no Git arc or plan.",
  missingActiveArc: "This thread has no active Git arc.",
  inactiveArcRequiresStart: "The plan has not been started yet.",
  activePlanMutationRequiresRevision: "This arc is already active and needs a combined claim revision.",
  notImplementationArc: "The selected checkpoint is not an implementation arc.",
  wrongLifecycleRef: "The selected reference does not belong to this thread's current arc.",
  missingInactivePlan: "This thread has no inactive plan to start.",
  wrongPlanKind: "The selected checkpoint is not an inactive plan.",
  emptyPlan: "The plan has no files to claim.",
  conflictingProposalTargets: "A proposal can't be replaced and amended at the same time.",
  conflictingReplacementTargets: "The request selects different proposals to replace.",
  conflictingAmendmentTargets: "The request selects different proposals to amend.",
  missingCommitTitle: "The proposed commit has no title.",
  missingFreshTitle: "The amendment has no title for its separate commit choice.",
  unexpectedFreshMetadata: "A separate commit choice is only available for a content amendment.",
  unchangedMessage: "The proposed commit message is unchanged.",
  noChangesToPropose: "The selected files have no changes to propose.",
  proposalRequiresCommittedTarget: "The selected proposal has not been committed, so it can't be amended.",
  proposalCannotBeReplaced: "The selected proposal is no longer available for replacement.",
  proposalCannotBeRescinded: "The selected proposal is no longer pending.",
  messageAmendRequiresTarget: "The message amendment has no committed target.",
  messageAmendCannotCommitFresh: "A message-only amendment can't become a separate commit.",
  cannotCommitAsAmend: "This proposal is not an amendment.",
  missingFreshCommitChoice: "This amendment has no separate commit choice.",
  proposalNotOwned: "The proposal no longer belongs to this thread's arc.",
  proposalUnavailable: "The proposal is no longer available to commit.",
  incompatibleHead: "Repository history changed incompatibly with this arc.",
  missingWorkspaceMembers: "No Git repositories match this workspace arc.",
  missingInactiveMembers: "No inactive plans match this workspace arc.",
  missingProposalRoot: "The proposal needs a single project selected.",
  detachedHead: "The repository is not on a branch, so amending is unsafe.",
  selectedPathPaging: "The selected files are returned together, so there isn't another page.",
  missingSelectedPaths: "No files or project scopes were selected.",
  missingMoveOperands: "The move needs both a source and a destination.",
  mixedMoveForms: "The request combines incompatible ways of specifying a move.",
  missingRegexOptions: "The pattern-based move needs both a pattern and a replacement.",
  missingMoveRoots: "The pattern-based move has no folders to search.",
  invalidMoveOptions: "The pattern-based move contains unsupported options.",
  emptyClaimOperand: "A claim change has no path.",
  tooManyPlanMessages: "The plan has more message values than it accepts.",
  duplicateInheritance: "The request repeats the inheritance option.",
  unexpectedScopeArguments: "Reading the current arc scope does not accept extra arguments.",
  unsupportedCommand: "The requested Git arc action is not supported.",
  unexpectedTrailingArguments: "This request does not accept trailing arguments.",
  missingManagedIdentity: "The request has no managed thread identity.",
  invalidHarness: "The request has no supported agent identity.",
  invalidProposalId: "The proposal identifier is invalid.",
  wrongCheckpointOwnership: "The checkpoint does not belong to this thread and worktree.",
} as const;

export const GitArcRejectionSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.enum(Object.keys(simpleMessages) as [keyof typeof simpleMessages, ...(keyof typeof simpleMessages)[]]) }).strict(),
  z.object({
    reason: z.enum(["unclaimedRemoval", "conflictingClaimOperations", "adoptionRequiresUnclaimed", "adoptionRequiresDirty", "uncoveredDirtyClaims", "pathsOutsideClaims", "baselineChanged"]),
    paths: facts,
  }).strict(),
  z.object({ reason: z.literal("proposalNotFound"), proposalId: fact }).strict(),
  z.object({ reason: z.literal("publishedCommit"), refs: facts }).strict(),
  z.object({
    reason: z.enum(["unknownWorkspaceRoot", "rootNotRepository", "noClaimedRootPaths", "missingRestoreRef", "crossRootProposal"]),
    rootId: fact,
  }).strict(),
  z.object({ reason: z.literal("pathOutsideWorkspaceRoot"), rootId: fact, path: fact }).strict(),
  z.object({ reason: z.literal("conflictingRootRefs"), rootIds: facts }).strict(),
  z.object({
    reason: z.enum(["missingArgument", "unknownArgument", "duplicateArgument", "argumentMustBeUnique", "argumentMustBeInteger", "unexpectedArgument"]),
    argument: fact,
  }).strict(),
  z.object({ reason: z.literal("invalidArguments"), fields: facts }).strict(),
]);

export type GitArcRejection = z.infer<typeof GitArcRejectionSchema>;

const humanMessages = {
  ...simpleMessages,
  unclaimedRemoval: "These paths aren't in the arc's claim set.",
  conflictingClaimOperations: "The request makes conflicting changes to the same paths.",
  adoptionRequiresUnclaimed: "These changes are already claimed.",
  adoptionRequiresDirty: "These files have no unclaimed changes to adopt.",
  uncoveredDirtyClaims: "The revised plan would leave changed files without an owner.",
  pathsOutsideClaims: "The proposal includes files outside this arc's claims.",
  baselineChanged: "The selected files changed since the arc's baseline.",
  proposalNotFound: "The requested proposal could not be found.",
  publishedCommit: "The commit is already published, so it can't be amended.",
  unknownWorkspaceRoot: "The selected project is not in this workspace.",
  rootNotRepository: "The selected project is not in a Git repository.",
  noClaimedRootPaths: "The selected project has no claimed files to propose.",
  missingRestoreRef: "The selected project has no arc reference to restore.",
  crossRootProposal: "One proposal can't include files from different projects.",
  pathOutsideWorkspaceRoot: "The selected path is outside its project.",
  conflictingRootRefs: "Projects in the same repository selected different arc references.",
  missingArgument: "The request is missing a required argument.",
  unknownArgument: "The request contains an unsupported option.",
  duplicateArgument: "The request repeats an option that accepts only one value.",
  argumentMustBeUnique: "The request repeats values that must be unique.",
  argumentMustBeInteger: "The request needs a valid non-negative whole number.",
  unexpectedArgument: "The request contains an unexpected argument.",
  invalidArguments: "The request contains missing or invalid values.",
} satisfies Record<GitArcRejection["reason"], string>;

export function describeGitArcRejection(rejection: GitArcRejection): string {
  return humanMessages[rejection.reason];
}

export class GitArcRejectionError extends Error {
  readonly rejection: GitArcRejection;
  constructor(rejection: GitArcRejection, diagnostic?: string) {
    super(diagnostic ?? describeGitArcRejection(rejection));
    this.name = "GitArcRejectionError";
    this.rejection = GitArcRejectionSchema.parse(rejection);
  }
}

export function gitArcRejectionIssue(rejection: GitArcRejection, message: string, path: Array<string | number> = []) {
  return { code: "custom" as const, message, params: { gitArcRejection: GitArcRejectionSchema.parse(rejection) }, path };
}

const validationIssues = z.array(z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])).default([]),
  params: z.object({ gitArcRejection: GitArcRejectionSchema.optional() }).optional(),
})).min(1);

export function readGitArcValidationRejection(issues: unknown): GitArcRejection | null {
  const parsed = validationIssues.safeParse(issues);
  if (!parsed.success) return null;
  for (const issue of parsed.data) {
    if (issue.params?.gitArcRejection) return issue.params.gitArcRejection;
    if (issue.code === "invalid_value" && issue.path.at(-1) === "inherit") return { reason: "inheritanceRequired" };
  }
  return { reason: "invalidArguments", fields: [...new Set(parsed.data.flatMap(({ path }) => path.filter((part): part is string => typeof part === "string")))].slice(0, 20) };
}
