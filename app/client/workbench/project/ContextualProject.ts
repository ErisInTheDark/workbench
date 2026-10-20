/*
 * Exports:
 * - ContextualProjectFacts: what a surface knows about the project its content belongs to.
 * - default ContextualProject: the answer owner for those facts. Descendants ask it to summarise commands, show paths and
 *   render links instead of holding the facts; one instance exists per fact content, so the instance is dependency-safe.
 */
import type { WorkbenchSkillSummary } from "workbench-shared/types";
import { toWorkspaceDisplayPath, type WorkspaceFileLinkRoot } from "../markdown/markdown-links";
import type { ProjectFilePathDisambiguationIndex } from "./project-file-path";
import type { InlineMentionHighlightSources } from "../thread/inline-mention-highlights";
import { getThreadCommandDisplay } from "../thread/thread-command-matchers";

export interface ContextualProjectFacts {
  /** The directory relative paths in this content resolve against, such as a thread's working directory. */
  cwd?: string;
  /** Project files, which disambiguate path pills that share a name. */
  filePaths?: readonly string[];
  /** A prebuilt index over `filePaths`, keyed by its file index identity. */
  pathDisambiguation?: { index: ProjectFilePathDisambiguationIndex | null; key: string };
  id: string | null;
  mentions?: InlineMentionHighlightSources | null;
  rootPath?: string;
  skills?: WorkbenchSkillSummary[];
  workspaceRoots?: readonly WorkspaceFileLinkRoot[];
}

type CommandInput = Pick<Parameters<typeof getThreadCommandDisplay>[0], "command" | "commandActions" | "cwd" | "shell">;

const NO_SKILLS: WorkbenchSkillSummary[] = [];

function hashStrings(values: readonly string[]) {
  let hash = 2_166_136_261;
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
    hash = Math.imul(hash, 16_777_619);
  }
  return `${values.length}:${(hash >>> 0).toString(36)}`;
}

/** Fact lists are re-provided every render; each list's content is hashed once. */
const listKeys = new WeakMap<object, string>();
function listKey<Value>(values: readonly Value[] | undefined, describe: (value: Value) => string) {
  if (!values) return "none";
  let key = listKeys.get(values);
  if (key === undefined) {
    key = hashStrings(values.map(describe));
    listKeys.set(values, key);
  }
  return key;
}

export default class ContextualProject {
  /** Changes exactly when a fact's content changes. */
  readonly key: string;
  readonly #facts: ContextualProjectFacts;
  readonly #commandDisplays = new Map<string, ReturnType<typeof getThreadCommandDisplay>>();
  #matcherContext: ReturnType<ContextualProject["buildMatcherContext"]> | null = null;
  #mcpMatcherContext: { cwd?: string; knownSkills: WorkbenchSkillSummary[]; projectRootPath?: string; workspaceRoots?: readonly WorkspaceFileLinkRoot[] } | null = null;

  static keyOf(facts: ContextualProjectFacts) {
    return [
      facts.id ?? "",
      facts.rootPath ?? "",
      facts.cwd ?? "",
      facts.pathDisambiguation?.key ?? listKey(facts.filePaths, path => path),
      listKey(facts.workspaceRoots, root => `${root.id}:${root.openPathMode ?? ""}:${root.projectId ?? ""}:${root.rootPath}`),
      listKey(facts.skills, skill => `${skill.name}:${skill.path}`),
      facts.mentions?.cacheKey ?? "mentions:none",
    ].join("|");
  }

  constructor(facts: ContextualProjectFacts) {
    this.#facts = facts;
    this.key = ContextualProject.keyOf(facts);
  }

  get cwd() { return this.#facts.cwd; }
  get filePaths() { return this.#facts.filePaths; }
  get id() { return this.#facts.id; }
  get mentions() { return this.#facts.mentions ?? null; }
  get pathDisambiguation() { return this.#facts.pathDisambiguation; }
  get rootPath() { return this.#facts.rootPath; }
  get workspaceRoots() { return this.#facts.workspaceRoots; }

  /** The same project seen from content with different facts, such as a child thread's working directory. */
  with(overrides: Partial<ContextualProjectFacts>) {
    return new ContextualProject({ ...this.#facts, ...overrides });
  }

  /** Item fields (an item's own cwd) always win over these, so the content's cwd is not part of it. */
  private buildMatcherContext() {
    return {
      knownSkills: this.#facts.skills ?? NO_SKILLS,
      projectRootPath: this.#facts.rootPath,
      workspaceRoots: this.#facts.workspaceRoots,
    };
  }

  /** Context the command, tool and MCP matchers summarise with. */
  get matcherContext() {
    this.#matcherContext ??= this.buildMatcherContext();
    return this.#matcherContext;
  }

  /** Context MCP summaries resolve with: paths resolve only where the content has a working directory. */
  get mcpMatcherContext() {
    this.#mcpMatcherContext ??= {
      knownSkills: this.matcherContext.knownSkills,
      ...(this.#facts.cwd ? { cwd: this.#facts.cwd, projectRootPath: this.#facts.rootPath, workspaceRoots: this.#facts.workspaceRoots } : {}),
    };
    return this.#mcpMatcherContext;
  }

  commandDisplay(input: CommandInput) {
    const cacheKey = JSON.stringify([input.command, input.cwd, input.shell ?? null, input.commandActions ?? []]);
    let display = this.#commandDisplays.get(cacheKey);
    if (!display) {
      const { knownSkills, projectRootPath, workspaceRoots } = this.matcherContext;
      display = getThreadCommandDisplay({ knownSkills, projectRootPath, workspaceRoots, ...input });
      this.#commandDisplays.set(cacheKey, display);
    }
    return display;
  }

  /** A path as this project shows it: workspace-relative wherever a root holds it. */
  displayPath(path: string) {
    return toWorkspaceDisplayPath(path, { projectRootPath: this.#facts.rootPath ?? "", workspaceRoots: this.#facts.workspaceRoots }) ?? path;
  }
}
